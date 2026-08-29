/**
 * Daemon de servicios de la caja.
 *
 * El problema: el POS depende de dos microservicios que corren FUERA de este proceso
 * y que se caen solos.
 *
 *   · NestorPrinter — servicio de Windows (NSSM) en 127.0.0.1:8331. Se queda
 *     "detenido" y hay que levantarlo a mano con `sc start NestorPrinter`.
 *   · Santander EMV — app de bandeja en 127.0.0.1:5000, lanzada por la tarea
 *     programada NestorSantanderEMV. También se cae, y hasta ahora se revivía
 *     corriendo un .ps1 a mano en la caja.
 *
 * Mientras tanto el cajero ve "no imprime" o "no pasa la tarjeta", que es
 * indistinguible de un cable suelto, y llama a soporte.
 *
 * Aquí se vigila la SALUD de los dos y se ejecuta el rescate. La arquitectura es
 * deliberadamente la misma de `ensureLocalServer` en main.js —sondeo barato, una sola
 * reparación serializada, reintentos con espera, estado que se difunde al renderer
 * sólo cuando cambia—: es el mismo problema resuelto ya una vez en este código.
 *
 * ── Cuatro decisiones que no son obvias ─────────────────────────────────────────
 *
 * 1. Se sondea el PUERTO, no el proceso. `sc query` diciendo RUNNING no significa que
 *    el servicio conteste: el caso "arriba pero colgado" es real y es el único que
 *    NADA más en el sistema puede detectar (ni el SCM, ni nssm, ni el updater). Es la
 *    mitad de la razón de existir de este archivo.
 *
 * 2. El 503 del EMV NO es una caída. `/api/health` contesta 503 CON CUERPO cuando el
 *    servicio está vivo pero la terminal no está lista (desconectada, sin llaves,
 *    reloj desfasado). Reiniciar el proceso por un PIN pad desconectado no arregla
 *    nada y sí tira la sesión con el host. Sólo "no contesta" dispara rescate.
 *
 * 3. Nunca se rescata con trabajo en vuelo. Lanzar el EMV mata la instancia previa
 *    (Program.cs → KillPreviousInstances), así que un rescate a media lectura de
 *    tarjeta MATA EL COBRO. Hay dos compuertas: el tráfico observado hacia esos
 *    puertos (automática) y un `hold` explícito que toma el POS en las operaciones
 *    largas.
 *
 * 4. Se rinde. Con backoff, tope por hora y un estado final `rendido` que sube una
 *    incidencia. Sin eso, una caja con la DLL en cuarentena se convierte en un bucle
 *    de reinicios que además entierra la causa real.
 *
 * Nada de esto lanza nunca: es instrumentación, y un fallo suyo no puede tumbar una
 * venta. Todas las funciones responden { ok:false, error } y siguen.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

// ── Interruptores ───────────────────────────────────────────────────────────────
//
// NESTOR_SERVICES=0        apaga el daemon entero (ni sondea).
// NESTOR_SERVICES_RESCUE=0 modo OBSERVACIÓN: sondea, registra y reporta, pero no
//                          toca nada. Es el modo con el que conviene pilotear en
//                          flota: desplegar rescate automático con un error adentro
//                          es una caída de flota.
const ENABLED = (process.env.NESTOR_SERVICES || '1') !== '0';
const RESCUE_ENABLED = (process.env.NESTOR_SERVICES_RESCUE || '1') !== '0';

// Sólo Windows tiene servicios y tareas que rescatar. En macOS/Linux (desarrollo) el
// daemon corre igual, pero en observación: sirve para probar sondas y estados.
const IS_WIN = process.platform === 'win32';

const WATCH_MS = Math.max(5000, parseInt(process.env.NESTOR_SERVICES_WATCH_MS || '15000', 10));
const PROBE_TIMEOUT_MS = Math.max(800, parseInt(process.env.NESTOR_SERVICES_PROBE_MS || '2500', 10));

// Fallos SEGUIDOS antes de mover un dedo. Un timeout suelto es normal: el printer
// renderiza PDFs en el mismo hilo y el EMV bloquea hasta 60 s esperando la tarjeta.
const STRIKES = Math.max(1, parseInt(process.env.NESTOR_SERVICES_STRIKES || '3', 10));

// Silencio exigido antes de rescatar: si hubo tráfico hacia ese puerto hace menos que
// esto, se salta la ronda. 90 s cubre una venta con tarjeta completa.
const QUIET_MS = Math.max(0, parseInt(process.env.NESTOR_SERVICES_QUIET_MS || '90000', 10));

// Espera entre intentos del MISMO episodio. Después del último valor se repite.
const BACKOFF_MS = [10000, 30000, 120000, 300000];

// Tope de rescates por hora y por servicio. Al pasarlo se declara `rendido` y se
// sube la incidencia: ya no es algo que se arregle reiniciando.
const MAX_RESCUES_PER_HOUR = Math.max(1, parseInt(process.env.NESTOR_SERVICES_MAX_HOUR || '5', 10));

// Cuánto se espera a que un servicio recién lanzado empiece a contestar. El EMV es
// LENTO de verdad: hace login contra el host de Santander y detecta puertos COM.
const SETTLE_MS = {
    printer: Math.max(3000, parseInt(process.env.NESTOR_SERVICES_SETTLE_PRINTER_MS || '20000', 10)),
    emv: Math.max(5000, parseInt(process.env.NESTOR_SERVICES_SETTLE_EMV_MS || '60000', 10))
};

// Nombres por omisión. El del printer se descubre de instance.json (ver
// resolvePrinterService); esto es el respaldo y el override manual.
const PRINTER_SERVICE_DEFAULT = String(process.env.NESTOR_PRINTER_SERVICE || 'NestorPrinter').trim();
const PRINTER_RESCUE_TASK = String(process.env.NESTOR_PRINTER_RESCUE_TASK || 'NestorPrinterRescue').trim();
const EMV_TASK = String(process.env.NESTOR_EMV_TASK || 'NestorSantanderEMV').trim();
const EMV_EXE_NAME = 'NestorSantanderEmvService.exe';

const LOG_MAX_BYTES = 2 * 1024 * 1024;

let dir = '';
let initError = '';
let timer = null;
let busy = null;
let onChange = null;
let report = null;
let logStream = null;

// ── Estado ──────────────────────────────────────────────────────────────────────

function nuevoEstado(id, label) {
    return {
        id,
        label,
        // ¿Se vigila? El printer sí desde el arranque; el EMV sólo cuando el POS
        // avisa que ESTA caja tiene terminal (ver ensure()). Una caja sin terminal
        // no debe intentar nada nunca.
        supervised: false,
        // Vocabulario cerrado, porque lo pinta el frontend:
        //   desconocido  todavía no se sondea
        //   ok           contesta (puede traer `warn`, ver abajo)
        //   sospechoso   falló, pero aún no llega a STRIKES fallos seguidos
        //   rescatando   se está actuando, o esperando entre intentos
        //   caido        confirmado abajo y no se va a actuar (modo observación)
        //   rendido      se intentó y no se sostiene, o no hay forma de rescatarlo
        state: 'desconocido',
        detail: '',
        // Diagnóstico secundario: el servicio contesta pero algo está mal (la DLL del
        // printer no cargó, la terminal EMV no está lista). No dispara rescate.
        warn: '',
        strikes: 0,
        lastOkAt: 0,
        lastProbeAt: 0,
        lastError: '',
        // Cuerpo de la última respuesta de salud, tal cual. Lo pinta el POS.
        info: null,
        // Rescate
        attempts: 0,
        nextAttemptAt: 0,
        rescues: [],
        lastRescueAt: 0,
        lastRescueStep: '',
        lastRescueError: '',
        rescuesTotal: 0,
        // Compuertas
        holdUntil: 0,
        lastTrafficAt: 0,
        // Se reportó ya la rendición de este episodio (una sola incidencia por caída,
        // no una por ronda).
        reported: false
    };
}

const servicios = {
    printer: nuevoEstado('printer', 'Servicio de impresión'),
    emv: nuevoEstado('emv', 'Terminal Santander EMV')
};

// El printer se vigila siempre: toda caja con cliente tiene el suyo (ver
// NeedServerStack en el instalador — un cliente autónomo instala su propio
// NestorPrinter).
servicios.printer.supervised = true;

// ── Utilidades ──────────────────────────────────────────────────────────────────

function resolveDir(userDataDir) {
    // Junto a las capturas y a los errores POS: la bitácora de por qué se cayó un
    // servicio tiene que sobrevivir al botón rojo de "Eliminar datos y caché".
    const override = String(process.env.NESTOR_SERVICES_DIR || '').trim();
    const candidatos = [];
    if (override) candidatos.push(override);

    if (process.platform === 'win32') {
        const base = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
        candidatos.push(path.join(base, 'NestorPOS', 'servicios'));
    } else if (process.platform === 'darwin') {
        candidatos.push(path.join('/Users/Shared', 'NestorPOS', 'servicios'));
    } else {
        candidatos.push(path.join('/var/lib', 'nestorpos', 'servicios'));
    }
    if (userDataDir) candidatos.push(path.join(userDataDir, 'servicios'));
    candidatos.push(path.join(os.homedir(), '.nestorpos', 'servicios'));

    for (const c of candidatos) {
        try {
            fs.mkdirSync(c, { recursive: true });
            const probe = path.join(c, '.escritura');
            fs.writeFileSync(probe, String(Date.now()));
            fs.rmSync(probe, { force: true });
            return c;
        } catch { }
    }
    return '';
}

// Bitácora local. Es lo primero que se pide cuando una caja "falla seguido", así que
// se escribe siempre —incluso en modo observación— y rota por tamaño.
function log(linea) {
    const texto = `${new Date().toISOString()} ${linea}`;
    console.log(`[servicios] ${linea}`);
    if (!logStream) return;
    try {
        logStream.write(texto + '\n');
    } catch { }
}

function abrirLog() {
    if (!dir) return;
    const file = path.join(dir, 'servicios.log');
    try {
        const st = fs.statSync(file);
        if (st.size > LOG_MAX_BYTES) {
            fs.rmSync(file + '.1', { force: true });
            fs.renameSync(file, file + '.1');
        }
    } catch { }
    try {
        logStream = fs.createWriteStream(file, { flags: 'a' });
        logStream.on('error', () => { logStream = null; });
    } catch {
        logStream = null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ¿Hay alguien escuchando en el puerto? Es la sonda más barata que existe y la única
 * que no toca al servicio: no genera petición, no entra a la DLL, no aparece en su
 * log. Distingue "el proceso no está" de "el proceso está pero no contesta HTTP",
 * que son rescates distintos.
 */
function tcpPing(port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let hecho = false;
        const cerrar = (abierto, error) => {
            if (hecho) return;
            hecho = true;
            try { socket.destroy(); } catch { }
            resolve({ open: abierto, error: error || '' });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => cerrar(true, ''));
        socket.once('timeout', () => cerrar(false, 'tiempo agotado'));
        socket.once('error', (e) => cerrar(false, e && e.message ? e.message : String(e)));
        try {
            socket.connect(port, '127.0.0.1');
        } catch (e) {
            cerrar(false, e && e.message ? e.message : String(e));
        }
    });
}

/**
 * GET a un servicio local. Devuelve { ok, status, body, error } y NO lanza: para el
 * EMV, un 503 con cuerpo es información valiosa (dice POR QUÉ la terminal no está
 * lista), no una excepción. Ver la nota larga en santander.local.js del frontend.
 */
function httpGet(url, timeoutMs) {
    return new Promise((resolve) => {
        let req;
        const fin = (res) => {
            try { if (req) req.destroy(); } catch { }
            resolve(res);
        };
        try {
            req = http.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
                const trozos = [];
                let bytes = 0;
                res.on('data', (d) => {
                    bytes += d.length;
                    // Un cuerpo enorme sería una respuesta que no es la que esperamos.
                    if (bytes <= 64 * 1024) trozos.push(d);
                });
                res.on('end', () => {
                    let body = null;
                    try { body = JSON.parse(Buffer.concat(trozos).toString('utf8')); } catch { }
                    fin({ ok: true, status: res.statusCode || 0, body, error: '' });
                });
            });
            req.on('timeout', () => fin({ ok: false, status: 0, body: null, error: 'tiempo agotado' }));
            req.on('error', (e) => fin({ ok: false, status: 0, body: null, error: e && e.message ? e.message : String(e) }));
        } catch (e) {
            fin({ ok: false, status: 0, body: null, error: e && e.message ? e.message : String(e) });
        }
    });
}

/**
 * Corre un ejecutable de Windows y devuelve { code, stdout, stderr }. Nunca lanza y
 * siempre tiene tope de tiempo: `sc` y `schtasks` se pueden quedar colgados contra un
 * SCM ocupado, y este daemon no puede permitirse un await eterno.
 */
function run(exe, args, timeoutMs) {
    return new Promise((resolve) => {
        try {
            execFile(exe, args, {
                timeout: Math.max(1000, timeoutMs || 15000),
                windowsHide: true,
                encoding: 'utf8',
                maxBuffer: 1024 * 1024
            }, (err, stdout, stderr) => {
                resolve({
                    code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                    error: err && err.message ? err.message : ''
                });
            });
        } catch (e) {
            resolve({ code: -1, stdout: '', stderr: '', error: e && e.message ? e.message : String(e) });
        }
    });
}

function sysExe(nombre) {
    const base = process.env.SystemRoot || 'C:\\Windows';
    return path.join(base, 'System32', nombre);
}

// ── Descubrimiento ──────────────────────────────────────────────────────────────

let printerServiceCache = null;

/**
 * Nombre real del servicio de impresión de ESTA máquina.
 *
 * No se puede quemar "NestorPrinter": el instalador escribe el nombre en
 * instance.json (`printer_service`) y una instancia adicional lo deja VACÍO a
 * propósito, porque comparte el servicio de la principal. Leerlo de ahí es lo mismo
 * que hace el updater.
 */
function resolvePrinterService() {
    if (printerServiceCache !== null) return printerServiceCache;

    if (process.env.NESTOR_PRINTER_SERVICE) {
        printerServiceCache = PRINTER_SERVICE_DEFAULT;
        return printerServiceCache;
    }

    const candidatos = [
        'C:\\NestorMX\\NestorPOS\\instance.json',
        'C:\\NestorMX\\NestorComplementos\\instance.json'
    ];
    for (const file of candidatos) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const cfg = JSON.parse(raw);
            const nombre = String(cfg.printer_service || '').trim();
            if (nombre) {
                printerServiceCache = nombre;
                log(`nombre del servicio de impresión tomado de ${file}: ${nombre}`);
                return printerServiceCache;
            }
        } catch { }
    }

    printerServiceCache = PRINTER_SERVICE_DEFAULT;
    return printerServiceCache;
}

/**
 * Estado del servicio según el SCM: 'running' | 'stopped' | 'pending' | 'ausente' |
 * 'sin-permiso' | 'desconocido'.
 *
 * Los tres fallos se distinguen aquí y no en el rescate, porque piden respuestas
 * distintas: "no existe" es reinstalar, "sin permiso" es escalar a la tarea elevada, y
 * "detenido" es arrancarlo.
 *
 * Se lee por CÓDIGO DE SALIDA y por el número de estado, no por el texto. Las cajas
 * corren Windows en español: ahí `sc query` imprime "ESTADO : 4  RUNNING" y el error
 * como "Acceso denegado". Los nombres del enum (RUNNING/STOPPED) no se traducen, pero
 * los mensajes de error sí, y el número nunca — así que el número manda y el texto es
 * el respaldo.
 */
async function serviceState(nombre) {
    if (!IS_WIN) return { state: 'desconocido', raw: '' };
    const r = await run(sysExe('sc.exe'), ['query', nombre], 8000);
    const salida = `${r.stdout}\n${r.stderr}`;

    // 1060 = ERROR_SERVICE_DOES_NOT_EXIST, 5 = ERROR_ACCESS_DENIED. sc los devuelve
    // como código de salida y además los imprime como "FAILED <n>".
    if (r.code === 1060 || /FAILED\s+1060/i.test(salida)) return { state: 'ausente', raw: salida };
    if (r.code === 5 || /FAILED\s+5\b/i.test(salida)) return { state: 'sin-permiso', raw: salida };

    // La línea de estado: "ESTADO : 4  RUNNING" (es) / "STATE : 1  STOPPED" (en).
    // Se ancla al nombre del enum y NO a "<dos puntos> <número>" a secas, porque la
    // línea anterior —"TIPO : 10  WIN32_OWN_PROCESS"— también encaja con eso y llegaría
    // primero.
    const m = /\b(STOPPED|START_PENDING|STOP_PENDING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED|RUNNING)\b/i.exec(salida);
    if (m) {
        switch (m[1].toUpperCase()) {
            case 'RUNNING': return { state: 'running', raw: salida };
            case 'STOPPED': return { state: 'stopped', raw: salida };
            // En pausa el servicio no atiende, pero tampoco está detenido: se trata
            // como detenido porque la respuesta correcta —arrancarlo— es la misma.
            case 'PAUSED': return { state: 'stopped', raw: salida };
            default: return { state: 'pending', raw: salida };
        }
    }
    return { state: 'desconocido', raw: salida };
}

/** ¿Está vivo el proceso del EMV? El servicio no es un servicio de Windows: es un exe. */
async function emvProcessAlive() {
    if (!IS_WIN) return false;
    const r = await run(sysExe('tasklist.exe'), ['/FI', `IMAGENAME eq ${EMV_EXE_NAME}`, '/NH'], 8000);
    return r.stdout.toLowerCase().includes(EMV_EXE_NAME.toLowerCase());
}

/** ¿Existe la tarea programada? */
async function taskExists(nombre) {
    if (!IS_WIN) return false;
    const r = await run(sysExe('schtasks.exe'), ['/Query', '/TN', nombre], 8000);
    return r.code === 0;
}

// ── Sondas ──────────────────────────────────────────────────────────────────────

/**
 * Salud del servicio de impresión.
 *
 * Se pregunta a /api/v1/health, que NO toca la DLL. Antes la única "cara" del
 * servicio era GET /api/v1, que calcula el HWID en cada llamada entrando al hardware:
 * como latido cada 15 s eso es martillar la máquina, y puede colgarse justo por lo
 * mismo que se intenta detectar. Con un printer viejo (sin /health) esa ruta contesta
 * 404 y el sondeo se conforma con que el puerto conteste — que es la pregunta que de
 * verdad importa para decidir el rescate.
 */
async function probePrinter() {
    const tcp = await tcpPing(8331, PROBE_TIMEOUT_MS);
    if (!tcp.open) {
        return { alive: false, error: `nadie escucha en 127.0.0.1:8331 (${tcp.error})`, warn: '', info: null };
    }

    const r = await httpGet('http://127.0.0.1:8331/api/v1/health', PROBE_TIMEOUT_MS);
    if (!r.ok) {
        // El puerto abre pero no completa una petición HTTP: es el caso "colgado", el
        // que sólo se ve desde aquí.
        return { alive: false, error: `el puerto abre pero no contesta (${r.error})`, warn: '', info: null };
    }
    if (r.status === 404) {
        return {
            alive: true,
            error: '',
            warn: 'printer sin /health (build anterior): sólo se comprueba el puerto',
            info: { legacy: true }
        };
    }
    if (r.status !== 200) {
        return { alive: false, error: `/health respondió ${r.status}`, warn: '', info: r.body };
    }

    const body = r.body || {};
    // Arriba pero sin DLL: NO es un rescate (reiniciar no devuelve una DLL en
    // cuarentena), es un aviso que tiene que llegar a una persona.
    const warn = body.dll_loaded === false
        ? 'el servicio atiende pero nestor_printer.dll no cargó: no puede imprimir'
        : '';
    return { alive: true, error: '', warn, info: body };
}

/**
 * Salud de la terminal EMV.
 *
 * Tres estados, no dos (ver EmvController.GetHealth y la nota de healthDetail en el
 * frontend):
 *   200 → servicio arriba y terminal lista.
 *   503 CON CUERPO → servicio ARRIBA, terminal no lista. Aquí eso es `alive:true` con
 *        aviso: reiniciar el proceso por un PIN pad desconectado no arregla nada y sí
 *        tira la sesión con el host.
 *   sin respuesta → el servicio no está. Lo único que dispara rescate.
 */
async function probeEmv() {
    const tcp = await tcpPing(5000, PROBE_TIMEOUT_MS);
    if (!tcp.open) {
        return { alive: false, error: `nadie escucha en 127.0.0.1:5000 (${tcp.error})`, warn: '', info: null };
    }

    const r = await httpGet('http://127.0.0.1:5000/api/health', PROBE_TIMEOUT_MS);
    if (!r.ok) {
        return { alive: false, error: `el puerto abre pero no contesta (${r.error})`, warn: '', info: null };
    }
    if (r.status !== 200 && r.status !== 503) {
        return { alive: false, error: `/api/health respondió ${r.status}`, warn: '', info: r.body };
    }

    const body = r.body || {};
    const listo = body.ready === true;
    return {
        alive: true,
        error: '',
        warn: listo ? '' : `el servicio está arriba pero la terminal no está lista (${textoEstadoEmv(body)})`,
        info: body
    };
}

function textoEstadoEmv(body) {
    const d = (body && body.detail) || {};
    if (d.terminal && d.terminal.connected === false) return 'terminal desconectada';
    if (!d.terminal) return 'terminal no detectada';
    return String(d.status || body.status || 'sin detalle');
}

// ── Escaleras de rescate ────────────────────────────────────────────────────────

/**
 * Rescate del servicio de impresión, de menos a más invasivo.
 *
 * El orden importa: parar y arrancar un servicio que SÍ está corriendo (paso 3) corta
 * cualquier impresión en curso, así que sólo se llega ahí cuando el SCM dice RUNNING y
 * el puerto no contesta — el caso colgado.
 */
async function rescuePrinter(st) {
    const svc = resolvePrinterService();
    const sc = sysExe('sc.exe');

    const estado = await serviceState(svc);
    log(`[printer] SCM dice "${estado.state}" para el servicio ${svc}`);

    if (estado.state === 'ausente') {
        return {
            ok: false,
            step: 'sc query',
            fatal: true,
            error: `el servicio ${svc} no está registrado en esta máquina; hay que reinstalar el componente`
        };
    }

    // 1) Detenido → arrancar. Es el caso reportado desde las cajas.
    if (estado.state === 'stopped' || estado.state === 'desconocido') {
        const r = await run(sc, ['start', svc], 30000);
        if (r.code === 0) return { ok: true, step: `sc start ${svc}` };
        log(`[printer] "sc start" falló (${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
        // Cae al escalón de la tarea.
    }

    // 2) Corriendo pero sin contestar → ciclo completo. ESTE es el caso que no atiende
    //    nada más: para el SCM y para nssm el servicio está perfectamente vivo.
    if (estado.state === 'running') {
        log(`[printer] el servicio dice RUNNING pero :8331 no contesta; ciclo stop/start`);
        await run(sc, ['stop', svc], 30000);
        // Esperar a que de verdad se detenga: arrancar sobre un STOP_PENDING falla.
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            const e = await serviceState(svc);
            if (e.state === 'stopped') break;
        }
        const r = await run(sc, ['start', svc], 30000);
        if (r.code === 0) return { ok: true, step: `sc stop+start ${svc}` };
        log(`[printer] el ciclo stop/start falló (${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
    }

    if (estado.state === 'pending') {
        return { ok: false, step: 'sc query', error: 'el servicio está en transición (START/STOP_PENDING); se reintenta' };
    }

    // 3) Sin permiso (o el start falló por permisos): la tarea programada elevada que
    //    deja registrada el instalador. Corre como SYSTEM, así que arrancar el
    //    servicio le sobra, y no pide UAC.
    if (await taskExists(PRINTER_RESCUE_TASK)) {
        const r = await run(sysExe('schtasks.exe'), ['/Run', '/TN', PRINTER_RESCUE_TASK], 20000);
        if (r.code === 0) return { ok: true, step: `schtasks /Run ${PRINTER_RESCUE_TASK}` };
        return {
            ok: false,
            step: `schtasks /Run ${PRINTER_RESCUE_TASK}`,
            error: `la tarea de respaldo falló (${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 200)}`
        };
    }

    return {
        ok: false,
        step: 'sin escalones',
        fatal: estado.state === 'sin-permiso',
        error: estado.state === 'sin-permiso'
            ? `este usuario no puede controlar el servicio ${svc} y no existe la tarea ${PRINTER_RESCUE_TASK}; `
              + 'hay que reinstalar para que el instalador conceda el permiso'
            : `no se pudo arrancar ${svc}`
    };
}

/**
 * Rescate de la terminal EMV.
 *
 * La única vía es la tarea programada. El exe del EMV es requireAdministrator (abre
 * HttpListener en :5000) y este cliente NO corre elevado: un CreateProcess directo
 * plantaría un UAC en la cara del cajero a media venta. `schtasks /Run` sobre una
 * tarea /RL HIGHEST lo lanza elevado y sin preguntar.
 */
async function rescueEmv(st) {
    if (!await taskExists(EMV_TASK)) {
        return {
            ok: false,
            step: 'schtasks /Query',
            fatal: true,
            error: `no existe la tarea ${EMV_TASK} en esta caja; hay que reinstalar el componente EMV Santander`
        };
    }

    // Si el proceso vive pero el puerto no contesta, está colgado: hay que matarlo
    // antes. Lanzar la tarea también lo haría —el propio exe mata las instancias
    // previas al arrancar (Program.cs)—, pero hacerlo aquí deja el motivo en la
    // bitácora en vez de que parezca que el EMV "se reinició solo".
    if (await emvProcessAlive()) {
        log('[emv] el proceso vive pero :5000 no contesta; se termina antes de relanzar');
        await run(sysExe('taskkill.exe'), ['/IM', EMV_EXE_NAME, '/F'], 15000);
        await sleep(1500);
    }

    const r = await run(sysExe('schtasks.exe'), ['/Run', '/TN', EMV_TASK], 20000);
    if (r.code === 0) return { ok: true, step: `schtasks /Run ${EMV_TASK}` };

    const salida = (r.stdout + r.stderr).trim().slice(0, 300);
    const denegado = /denegado|denied|0x80070005/i.test(salida);
    return {
        ok: false,
        step: `schtasks /Run ${EMV_TASK}`,
        fatal: denegado,
        error: denegado
            ? `este usuario no tiene permiso para disparar la tarea ${EMV_TASK}. `
              + 'Reinstala el componente EMV (el instalador concede el permiso) o ejecútalo una vez como administrador.'
            : `la tarea no arrancó (${r.code}): ${salida}`
    };
}

const RESCATES = { printer: rescuePrinter, emv: rescueEmv };
const SONDAS = { printer: probePrinter, emv: probeEmv };
const PUERTOS = { printer: 8331, emv: 5000 };

// ── Motor ───────────────────────────────────────────────────────────────────────

function payloadDe(st) {
    return {
        id: st.id,
        label: st.label,
        supervised: st.supervised,
        state: st.state,
        detail: st.detail,
        warn: st.warn,
        error: st.lastError,
        info: st.info,
        strikes: st.strikes,
        lastOkAt: st.lastOkAt,
        lastProbeAt: st.lastProbeAt,
        lastRescueAt: st.lastRescueAt,
        lastRescueStep: st.lastRescueStep,
        rescuesTotal: st.rescuesTotal,
        rescuesLastHour: st.rescues.length,
        attempts: st.attempts,
        nextAttemptAt: st.nextAttemptAt,
        // Las dos compuertas, visibles. Sin esto, "el daemon no hizo nada" es
        // indistinguible de "el daemon está roto", y la respuesta suele ser la primera:
        // no se toca un servicio que se está usando.
        lastTrafficAt: st.lastTrafficAt,
        holdUntil: st.holdUntil
    };
}

function status() {
    return {
        ok: ENABLED && !initError,
        enabled: ENABLED,
        rescue: RESCUE_ENABLED && IS_WIN,
        // Por qué NO se rescata, dicho una sola vez y en una frase. Sin esto, "no hizo
        // nada" en una caja de prueba se investiga durante media hora.
        mode: !ENABLED ? 'apagado'
            : !IS_WIN ? 'observación (plataforma sin servicios de Windows)'
                : !RESCUE_ENABLED ? 'observación (NESTOR_SERVICES_RESCUE=0)'
                    : 'rescate',
        error: initError,
        dir,
        watchMs: WATCH_MS,
        services: Object.values(servicios).map(payloadDe)
    };
}

function broadcast() {
    if (typeof onChange !== 'function') return;
    try { onChange(status()); } catch { }
}

// Firma de lo que se ve desde afuera. Difundir en cada ronda sería un evento cada 15 s
// por caja; sólo interesa el cambio (mismo criterio que setLocalServerState en main.js).
function firma() {
    return Object.values(servicios)
        .map((s) => `${s.id}:${s.supervised ? 1 : 0}:${s.state}:${s.warn ? 1 : 0}`)
        .join('|');
}

function podarRescates(st) {
    const corte = Date.now() - 3600000;
    st.rescues = st.rescues.filter((t) => t > corte);
}

/**
 * ¿Se puede tocar este servicio AHORA? Devuelve '' si sí, o el motivo por el que no.
 *
 * Las dos compuertas de seguridad viven aquí. Rescatar el EMV mata el proceso, y
 * hacerlo mientras la terminal lee una tarjeta mata el cobro: la primera regla del
 * daemon es no ser peor que la falla.
 */
function motivoParaEsperar(st, ahora) {
    if (st.holdUntil > ahora) {
        return `el POS pidió esperar (${Math.round((st.holdUntil - ahora) / 1000)} s)`;
    }
    if (QUIET_MS && st.lastTrafficAt && (ahora - st.lastTrafficAt) < QUIET_MS) {
        return `hubo tráfico hacia el servicio hace ${Math.round((ahora - st.lastTrafficAt) / 1000)} s`;
    }
    if (st.nextAttemptAt > ahora) {
        return `espera entre intentos (${Math.round((st.nextAttemptAt - ahora) / 1000)} s)`;
    }
    return '';
}

/**
 * Sube la incidencia de un servicio que se dio por perdido.
 *
 * Va por el canal de errores POS que ya existe, con todo lo que ese canal arma
 * (sesión XHR, consola, log del servidor). Se manda UNA vez por episodio —el propio
 * canal además deduplica por código+licencia+caja en 6 h—, porque lo que se quiere en
 * el panel es "esta caja se quedó sin impresión", no doscientos renglones iguales.
 */
async function reportarRendicion(st) {
    if (typeof report !== 'function' || st.reported) return;
    st.reported = true;
    try {
        // OJO con la forma: el manifiesto de pos.error.js es una LISTA BLANCA de campos
        // (ver `manifiesto` en report()). Un campo inventado no viaja — se descarta sin
        // decir nada. Lo único que admite contenido libre es `detail`, y `endpoint` hay
        // que ponerlo o el panel etiquetaría esto como un fallo de
        // /pos/register-ticket, que es justo lo contrario de lo que pasó.
        await report({
            code: `E_SERVICIO_CAIDO_${st.id.toUpperCase()}`,
            message: `${st.label}: ${st.lastError || 'no responde'}`,
            phase: 'daemon-servicios',
            endpoint: `http://127.0.0.1:${PUERTOS[st.id]}`,
            detail: {
                servicio: st.id,
                estado: st.state,
                puerto: PUERTOS[st.id],
                motivo: st.detail,
                error: st.lastError,
                aviso: st.warn,
                intentos_del_episodio: st.attempts,
                rescates_ultima_hora: st.rescues.length,
                rescates_totales: st.rescuesTotal,
                ultimo_paso: st.lastRescueStep,
                ultimo_error_rescate: st.lastRescueError,
                ultimo_ok: st.lastOkAt ? new Date(st.lastOkAt).toISOString() : '',
                salud: st.info,
                modo: status().mode,
                servicio_windows: st.id === 'printer' ? resolvePrinterService() : EMV_TASK
            }
        });
        log(`[${st.id}] incidencia reportada a la nube`);
    } catch (e) {
        log(`[${st.id}] no se pudo reportar la incidencia: ${e && e.message ? e.message : e}`);
    }
}

/** Una ronda para UN servicio. */
async function ronda(st) {
    if (!st.supervised) return;

    const ahora = Date.now();
    st.lastProbeAt = ahora;

    let sonda;
    try {
        sonda = await SONDAS[st.id]();
    } catch (e) {
        sonda = { alive: false, error: e && e.message ? e.message : String(e), warn: '', info: null };
    }

    st.warn = sonda.warn || '';
    if (sonda.info) st.info = sonda.info;

    // ── Contesta ────────────────────────────────────────────────────────────────
    if (sonda.alive) {
        const veniaMal = st.state !== 'ok' && st.state !== 'desconocido';
        if (veniaMal) {
            log(`[${st.id}] restablecido tras ${st.attempts} intento(s) de rescate`);
        }
        st.state = 'ok';
        st.detail = st.warn || 'atendiendo';
        st.strikes = 0;
        st.lastOkAt = ahora;
        st.lastError = '';
        st.attempts = 0;
        st.nextAttemptAt = 0;
        st.reported = false;
        return;
    }

    // ── No contesta ─────────────────────────────────────────────────────────────
    st.lastError = sonda.error || 'no responde';
    // Tope: pasado el umbral el contador ya no dice nada nuevo, y se muestra en la UI
    // ("sin respuesta 7/3" no significa nada). Lo que cuenta a partir de ahí son los
    // intentos de rescate.
    st.strikes = Math.min(st.strikes + 1, STRIKES);

    if (st.strikes < STRIKES) {
        st.state = 'sospechoso';
        st.detail = `sin respuesta (${st.strikes}/${STRIKES}): ${st.lastError}`;
        return;
    }

    if (!RESCUE_ENABLED || !IS_WIN) {
        st.state = 'caido';
        st.detail = `${st.lastError} — modo ${status().mode}, no se intenta rescate`;
        await reportarRendicion(st);
        return;
    }

    const espera = motivoParaEsperar(st, ahora);
    if (espera) {
        // Ya se confirmaron los STRIKES fallos: el servicio está abajo y se sabe. Que
        // estemos esperando no lo vuelve una sospecha — si ya hubo intentos es un
        // rescate en curso, y si no, está caído y esperando su turno.
        st.state = st.attempts > 0 ? 'rescatando' : 'caido';
        st.detail = `${st.lastError} — en espera: ${espera}`;
        return;
    }

    podarRescates(st);
    if (st.rescues.length >= MAX_RESCUES_PER_HOUR) {
        st.state = 'rendido';
        st.detail = `${st.rescues.length} rescates en la última hora sin que se sostenga. `
            + 'Esto ya no se arregla reiniciando: hay que revisar la caja.';
        log(`[${st.id}] RENDIDO: ${st.detail}`);
        await reportarRendicion(st);
        return;
    }

    // ── Rescate ─────────────────────────────────────────────────────────────────
    st.state = 'rescatando';
    st.attempts++;
    st.rescues.push(ahora);
    st.rescuesTotal++;
    st.lastRescueAt = ahora;
    st.detail = `intento ${st.attempts}: ${st.lastError}`;
    broadcast();

    log(`[${st.id}] intento de rescate #${st.attempts} — ${st.lastError}`);

    let res;
    try {
        res = await RESCATES[st.id](st);
    } catch (e) {
        res = { ok: false, step: 'excepción', error: e && e.message ? e.message : String(e) };
    }

    st.lastRescueStep = res.step || '';
    st.lastRescueError = res.ok ? '' : (res.error || '');

    if (!res.ok) {
        log(`[${st.id}] el rescate falló en "${res.step}": ${res.error}`);
        if (res.fatal) {
            // Un fallo estructural (no está el servicio, no está la tarea, no hay
            // permisos) no mejora por reintentar: se declara perdido de una vez y se
            // reporta, en vez de gastar la hora entera de intentos.
            st.state = 'rendido';
            st.detail = res.error || 'el rescate no es posible en esta caja';
            await reportarRendicion(st);
            return;
        }
        st.nextAttemptAt = ahora + BACKOFF_MS[Math.min(st.attempts - 1, BACKOFF_MS.length - 1)];
        st.detail = `el rescate falló: ${res.error}`;
        return;
    }

    log(`[${st.id}] rescate lanzado (${res.step}); esperando a que conteste`);

    // Esperar a que arranque de verdad. El EMV tarda: login contra el host y detección
    // de puertos COM. Declararlo fallido a los 5 s sería pedir otro rescate encima del
    // que está arrancando — y en el EMV eso mata el proceso que acaba de nacer.
    const limite = Date.now() + SETTLE_MS[st.id];
    while (Date.now() < limite) {
        await sleep(2000);
        let s;
        try { s = await SONDAS[st.id](); } catch { s = { alive: false }; }
        if (s.alive) {
            st.state = 'ok';
            st.warn = s.warn || '';
            st.info = s.info || st.info;
            st.detail = st.warn || `restablecido con ${res.step}`;
            st.strikes = 0;
            st.lastOkAt = Date.now();
            st.lastError = '';
            st.attempts = 0;
            st.nextAttemptAt = 0;
            st.reported = false;
            log(`[${st.id}] restablecido con ${res.step}`);
            return;
        }
    }

    st.nextAttemptAt = Date.now() + BACKOFF_MS[Math.min(st.attempts - 1, BACKOFF_MS.length - 1)];
    st.detail = `se lanzó ${res.step} pero el servicio no contestó en ${Math.round(SETTLE_MS[st.id] / 1000)} s`;
    log(`[${st.id}] ${st.detail}`);
}

/**
 * Una vuelta completa. Serializada en `busy`: el renderer puede pedir diez
 * reparaciones a la vez (una por petición caída) y aquí se atiende una sola.
 */
function tick(motivo) {
    if (busy) return busy;
    if (!ENABLED || initError) return Promise.resolve(status());

    busy = (async () => {
        const antes = firma();
        for (const st of Object.values(servicios)) {
            try {
                await ronda(st);
            } catch (e) {
                log(`[${st.id}] la ronda falló: ${e && e.message ? e.message : e}`);
            }
        }
        if (firma() !== antes) broadcast();
        return status();
    })().finally(() => { busy = null; });

    return busy;
}

// ── API pública ─────────────────────────────────────────────────────────────────

/**
 * Registra un servicio para que se vigile y lo comprueba AHORA.
 *
 * Es la puerta por la que el POS enciende el EMV al entrar a /pos, y también el
 * arranque del microservicio: si no está, aquí mismo se lanza. Esto reemplaza al .ps1
 * que había que correr a mano en la caja.
 */
async function ensure(id, options) {
    const st = servicios[String(id || '')];
    if (!st) return { ok: false, error: `servicio desconocido: ${id}` };
    if (!ENABLED) return { ok: false, error: 'daemon de servicios apagado', service: payloadDe(st) };

    const yaEstaba = st.supervised;
    st.supervised = true;

    if (!yaEstaba) {
        log(`[${st.id}] el POS lo puso bajo vigilancia`);
        // Servicio recién adoptado: no arrastrar el historial de una sesión anterior.
        st.strikes = 0;
        st.attempts = 0;
        st.nextAttemptAt = 0;
        st.reported = false;
        broadcast();
    }

    // `immediate:false` sólo lo registra (para un POS que sólo quiere el estado).
    if (options && options.immediate === false) return { ok: true, service: payloadDe(st) };

    // Un ensure() explícito es una orden de una persona o del arranque de la caja: no
    // tiene por qué esperar los 3 fallos seguidos que protegen a la ronda periódica.
    st.strikes = Math.max(st.strikes, STRIKES - 1);
    await tick(`ensure:${st.id}`);
    return { ok: st.state === 'ok', service: payloadDe(st) };
}

/** Deja de vigilar (el POS salió de /pos). No apaga nada: sólo deja de mirar. */
function release(id) {
    const st = servicios[String(id || '')];
    if (!st) return { ok: false, error: `servicio desconocido: ${id}` };
    // El printer se vigila siempre: imprimir no es exclusivo del punto de venta.
    if (st.id === 'printer') return { ok: true, service: payloadDe(st) };
    if (st.supervised) {
        st.supervised = false;
        log(`[${st.id}] fuera de vigilancia`);
        broadcast();
    }
    return { ok: true, service: payloadDe(st) };
}

/**
 * Reparación pedida por una persona (el botón de la barra de estado). Se salta el
 * backoff y el tope por hora: el momento lo está eligiendo alguien que está viendo la
 * caja. NO se salta la compuerta de trabajo en vuelo — eso nunca.
 */
async function repair(id) {
    const st = servicios[String(id || '')];
    if (!st) return { ok: false, error: `servicio desconocido: ${id}` };
    if (!ENABLED) return { ok: false, error: 'daemon de servicios apagado' };

    log(`[${st.id}] reparación pedida a mano`);
    st.supervised = true;
    st.rescues = [];
    st.attempts = 0;
    st.nextAttemptAt = 0;
    st.strikes = Math.max(st.strikes, STRIKES - 1);
    st.reported = false;
    await tick(`repair:${st.id}`);
    return { ok: st.state === 'ok', service: payloadDe(st) };
}

/**
 * "No toques este servicio durante los próximos N ms."
 *
 * Lo toma el POS alrededor de un cobro con tarjeta o de una impresión larga. La
 * compuerta automática (tráfico observado) cubre el caso normal; esto es para la
 * operación que se queda callada mucho rato — una venta EMV bloquea hasta 75 s
 * esperando a que el cliente presente la tarjeta, y en ese silencio el daemon podría
 * concluir que el servicio murió y matarlo justo a media autorización.
 */
function hold(id, ms) {
    const st = servicios[String(id || '')];
    if (!st) return { ok: false, error: `servicio desconocido: ${id}` };
    const dura = Math.max(1000, Math.min(300000, parseInt(ms, 10) || 90000));
    st.holdUntil = Math.max(st.holdUntil, Date.now() + dura);
    return { ok: true, until: st.holdUntil };
}

/** Suelta el `hold` antes de tiempo (la venta terminó). */
function unhold(id) {
    const st = servicios[String(id || '')];
    if (!st) return { ok: false, error: `servicio desconocido: ${id}` };
    st.holdUntil = 0;
    return { ok: true };
}

/**
 * ¿Esta petición es TRABAJO o sólo un latido?
 *
 * Distinguirlo es indispensable, no un refinamiento: el indicador de la barra de
 * estado del POS consulta /api/health del EMV CADA 3 SEGUNDOS. Si esos latidos
 * contaran como tráfico, la compuerta de silencio nunca se abriría y el daemon jamás
 * podría rescatar la terminal — vigilaría para siempre sin poder actuar, que es el
 * peor de los mundos porque además se vería como si funcionara.
 *
 * Se excluye por lista (health y la "cara" del printer) y no al revés: así una ruta de
 * trabajo nueva cuenta sola, sin que nadie tenga que acordarse de venir a apuntarla.
 */
function esLatido(pathname) {
    const p = String(pathname || '').toLowerCase().replace(/\/+$/, '');
    if (p.endsWith('/health')) return true;      // /api/health (EMV), /api/v1/health
    if (p === '/api/v1') return true;            // la "cara" del printer (HWID)
    return false;
}

/**
 * Anota que la ventana está USANDO uno de estos servicios.
 *
 * Lo alimenta el observador de peticiones de main.js. Es la compuerta automática: sin
 * pedirle nada al frontend, el daemon sabe que la caja está imprimiendo o cobrando
 * ahora mismo y se aparta. Cubre el caso normal; para las operaciones que se quedan
 * calladas mucho rato —una venta EMV bloquea hasta 75 s— el POS toma además un `hold`
 * explícito.
 */
function noteTraffic(url) {
    const u = String(url || '');
    let pathname = '';
    try { pathname = new URL(u).pathname; } catch { pathname = u; }
    if (esLatido(pathname)) return;

    if (u.includes(':8331')) servicios.printer.lastTrafficAt = Date.now();
    else if (u.includes(':5000')) servicios.emv.lastTrafficAt = Date.now();
}

function init(userDataDir, options) {
    const opts = options || {};
    onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    report = typeof opts.report === 'function' ? opts.report : null;

    if (!ENABLED) {
        console.log('[servicios] daemon apagado (NESTOR_SERVICES=0)');
        return status();
    }

    dir = resolveDir(userDataDir);
    if (!dir) initError = 'no se encontró un directorio donde escribir la bitácora';
    abrirLog();

    log(`daemon de servicios iniciado — modo ${status().mode}, ronda cada ${WATCH_MS / 1000} s`);
    if (IS_WIN) log(`servicio de impresión: ${resolvePrinterService()} · tarea EMV: ${EMV_TASK}`);

    // Primera vuelta diferida: el arranque del cliente ya trae bastante trabajo
    // síncrono (descomprimir el bundle bloquea el bucle de eventos varios segundos) y
    // un sondeo ahí se vencería solo, contando un fallo que no existe.
    setTimeout(() => { tick('arranque').catch(() => { }); }, 4000);

    timer = setInterval(() => { tick('ronda').catch(() => { }); }, WATCH_MS);
    if (timer.unref) timer.unref();

    return status();
}

function shutdown() {
    if (timer) clearInterval(timer);
    timer = null;
    if (logStream) {
        try { logStream.end(); } catch { }
        logStream = null;
    }
}

module.exports = {
    init,
    shutdown,
    status,
    ensure,
    release,
    repair,
    hold,
    unhold,
    noteTraffic,
    directory: () => dir
};
