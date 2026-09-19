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
const { execFile, spawn } = require('child_process');
const configStore = require('./services.config');
// Diagnóstico y reparación de tareas programadas. Vive aparte porque es lo único de
// aquí que necesita PowerShell y una elevación, y porque el asistente lo usa sin pasar
// por el daemon. Ver su cabecera: ahí está explicado por qué `schtasks /Run`
// devolviendo 0 no significa que haya arrancado nada.
const tasks = require('./services.tasks');

// ── Configuración ───────────────────────────────────────────────────────────────
//
// Se sintoniza desde la ventana de Configuración del cliente (Servicios de la caja →
// asistente) y se guarda junto a la bitácora. Las variables de entorno siguen ganando
// siempre: son la vía de emergencia (arrancar una caja rota con NESTOR_SERVICES=0) y
// la de desarrollo. Ver src/services.config.js para el esquema y la precedencia.
//
// Son `let` y no `const` A PROPÓSITO: aplicaConfig() las reescribe cuando alguien
// guarda desde el asistente, para que el cambio surta efecto SIN reiniciar el cliente.
// Pedir un reinicio de la caja para mover un umbral es justo la clase de viaje que
// este daemon existe para evitar.
let cfg = configStore.resolve('');

// NESTOR_SERVICES=0        apaga el daemon entero (ni sondea).
// NESTOR_SERVICES_RESCUE=0 modo OBSERVACIÓN: sondea, registra y reporta, pero no
//                          toca nada. Es el modo con el que conviene pilotear en
//                          flota: desplegar rescate automático con un error adentro
//                          es una caída de flota.
let ENABLED = cfg.valores.enabled;
let RESCUE_ENABLED = cfg.valores.rescue;

// Sólo Windows tiene servicios y tareas que rescatar. En macOS/Linux (desarrollo) el
// daemon corre igual, pero en observación: sirve para probar sondas y estados.
const IS_WIN = process.platform === 'win32';

let WATCH_MS = cfg.valores.watch_ms;
let PROBE_TIMEOUT_MS = cfg.valores.probe_ms;

// Fallos SEGUIDOS antes de mover un dedo. Un timeout suelto es normal: el printer
// renderiza PDFs en el mismo hilo y el EMV bloquea hasta 60 s esperando la tarjeta.
let STRIKES = cfg.valores.strikes;

// Silencio exigido tras un uso que TERMINÓ BIEN. La operación en curso ya protege sola
// mientras dura (ver `enVuelo`), así que esto sólo cubre el hueco entre dos operaciones
// seguidas — no hace falta que dure lo que la más larga.
let QUIET_MS = cfg.valores.quiet_ms;

// Espera entre intentos del MISMO episodio. Después del último valor se repite.
const BACKOFF_MS = [10000, 30000, 120000, 300000];

// Tope de rescates por hora y por servicio. Al pasarlo se declara `rendido` y se
// sube la incidencia: ya no es algo que se arregle reiniciando.
let MAX_RESCUES_PER_HOUR = cfg.valores.max_per_hour;

// Cuánto se espera a que un servicio recién lanzado empiece a contestar. El EMV es
// LENTO de verdad: hace login contra el host de Santander y detecta puertos COM.
let SETTLE_MS = { printer: cfg.valores.settle_printer_ms, emv: cfg.valores.settle_emv_ms };

// Puertos donde escucha cada servicio. Configurables porque una instancia adicional
// de NestorPOS en la misma máquina corre su printer en otro puerto.
let PUERTOS = { printer: cfg.valores.printer_port, emv: cfg.valores.emv_port };

// Nombres. El del printer se descubre de instance.json (ver resolvePrinterService);
// esto es el respaldo y el override manual.
let PRINTER_SERVICE_DEFAULT = cfg.valores.printer_service || 'NestorPrinter';
let PRINTER_RESCUE_TASK = cfg.valores.printer_rescue_task;
let PRINTER_INSTANCE_FILE = cfg.valores.printer_instance_file;
let EMV_TASK = cfg.valores.emv_task;
let EMV_EXE_NAME = cfg.valores.emv_exe;
// Ruta del ejecutable del EMV. Vacía = se descubre de la propia tarea programada, y si
// no, de la carpeta que deja el instalador.
let EMV_EXE_PATH = cfg.valores.emv_exe_path;
// ¿Se puede lanzar el ejecutable DIRECTAMENTE cuando la tarea no arranca nada? Es el
// último escalón, y el que convierte «Rescatando» para siempre en un rescate de verdad
// en la caja cuya tarea quedó mal registrada.
let EMV_DIRECT = cfg.valores.emv_direct_launch;

const LOG_MAX_BYTES = 2 * 1024 * 1024;

// Cuánto puede durar una petición antes de dejar de contarla como "en curso". Cubre de
// sobra la más larga que existe —una venta EMV bloquea hasta 75 s esperando la
// tarjeta— y evita que una petición que nunca notifique su final blinde el servicio.
const EN_VUELO_MAX_MS = 150000;

// Cuánto vale una petición fallida vista por la ventana como prueba de que el servicio
// está caído. Pasado esto vuelve a mandar sólo lo que digan las sondas.
const EVIDENCIA_MS = 15000;

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
        // Hasta cuándo se le da margen a un servicio RECIÉN LANZADO para que empiece a
        // contestar. Antes esto era un bucle con await dentro de la ronda: bloqueaba el
        // daemon entero hasta un minuto —sin sondear el printer, sin difundir estado y
        // con el botón de reparar de la barra colgado de la misma promesa—, de modo que
        // la caja veía «Rescatando» congelado aunque ya se hubiera arreglado. Ahora es
        // una marca de tiempo, y las rondas normales siguen su curso mientras arranca.
        settleUntil: 0,
        settleStep: '',
        // Un fallo ESTRUCTURAL: no está la tarea, no está el ejecutable, no hay permisos.
        // No mejora por reintentar, así que se recuerda y se deja de intentar hasta que
        // alguien cambie algo (reparar a mano, guardar configuración, o que el servicio
        // vuelva solo). Sin esto la caja alternaba entre «rendido» y «rescatando» cada
        // vez que el tope por hora dejaba hueco, y desde fuera eso se ve exactamente
        // igual que un rescate que sigue intentándolo.
        fatal: false,
        fatalMotivo: '',
        rescues: [],
        lastRescueAt: 0,
        lastRescueStep: '',
        lastRescueError: '',
        rescuesTotal: 0,
        // Compuertas
        holdUntil: 0,
        // Última petición que TERMINÓ BIEN. No "la última que salió": ver noteTraffic.
        lastTrafficAt: 0,
        // Peticiones en curso ahora mismo (id → cuándo empezó). Mientras haya una, el
        // servicio se está usando de verdad y no se toca.
        enVuelo: new Map(),
        // Última vez que la VENTANA se estrelló contra este servicio (conexión
        // rechazada). Es evidencia de primera mano de que está caído: la sonda del
        // daemon pregunta cada pocos segundos, pero el cajero que pulsa "imprimir" lo
        // descubre en el acto.
        lastFailAt: 0,
        lastFailError: '',
        // Se reportó ya la rendición de este episodio (una sola incidencia por caída,
        // no una por ronda).
        reported: false
    };
}

const servicios = {
    printer: nuevoEstado('printer', 'Servicio de impresión'),
    emv: nuevoEstado('emv', 'Terminal Santander EMV')
};

/**
 * Quién se vigila, según la configuración.
 *
 * El printer se vigila desde el arranque —toda caja con cliente tiene el suyo (ver
 * NeedServerStack en el instalador)— salvo que el asistente lo ponga en "nunca", que
 * es la caja que no imprime aquí.
 *
 * El EMV en "auto" NO se toca desde aquí: lo enciende el POS con ensure() cuando el
 * paquete dice que esta caja tiene terminal, y apagarlo aquí en cada reaplicación de
 * configuración le quitaría al POS lo que acaba de encender.
 */
function aplicaVigilancia() {
    servicios.printer.supervised = cfg.valores.printer_watch === 'siempre';

    if (cfg.valores.emv_watch === 'siempre') servicios.emv.supervised = true;
    else if (cfg.valores.emv_watch === 'nunca') servicios.emv.supervised = false;
}

aplicaVigilancia();

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

    // Configurado a mano (asistente o variable de entorno): manda y no se descubre.
    // Salvo que sea un servicio del sistema: ahí se ignora y se sigue descubriendo,
    // porque el daño de obedecer es dejar la máquina sin imprimir nada.
    if (cfg.valores.printer_service) {
        const veto = configStore.motivoProhibido('printer_service', cfg.valores.printer_service);
        if (!veto) {
            printerServiceCache = cfg.valores.printer_service;
            return printerServiceCache;
        }
        log(`[printer] se ignora el servicio configurado: ${veto}`);
    }

    const candidatos = PRINTER_INSTANCE_FILE
        ? [PRINTER_INSTANCE_FILE]
        : [
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

/**
 * Ejecutable detrás de un servicio, según el SCM.
 *
 * Es lo que permite contestar la única pregunta que importa antes de un `sc stop`:
 * ¿este servicio es NUESTRO? Windows en español imprime NOMBRE_RUTA_BINARIO; el nombre
 * del campo se traduce, así que se aceptan los dos y, si no aparece ninguno, se cae a
 * la primera línea que tenga un .exe.
 */
async function serviceBinary(nombre) {
    if (!IS_WIN) return '';
    const r = await run(sysExe('sc.exe'), ['qc', nombre], 8000);
    const salida = `${r.stdout}\n${r.stderr}`;
    const m = /(?:BINARY_PATH_NAME|NOMBRE_RUTA_BINARIO)\s*:\s*(.+)/i.exec(salida);
    if (m) return m[1].trim();
    const alt = /^.*\.exe.*$/im.exec(salida);
    return alt ? alt[0].trim() : '';
}

/**
 * ¿Se puede reiniciar este servicio? '' si sí; si no, por qué no.
 *
 * El daemon existe para reiniciar EL PRINTER DE NESTOR. Si la configuración apunta a
 * otra cosa, la respuesta correcta es decirlo, no ejecutarlo: `sc stop` sobre un
 * servicio ajeno hace un daño que el daemon no puede deshacer y que además no se
 * parece en nada al síntoma que lo provocó.
 *
 * Caso real: con el Spooler configurado por error, cada fallo de nestor_printer
 * terminaba en `sc stop Spooler` — y la máquina dejaba de imprimir por completo.
 */
async function puedeReiniciarServicio(nombre) {
    const veto = configStore.motivoProhibido('printer_service', nombre);
    if (veto) return veto;

    if (/^nestor/i.test(String(nombre || '').trim())) return '';

    // El nombre no lo delata: se mira de quién es el ejecutable. El instalador lo deja
    // bajo C:\NestorMX (con NSSM), así que la ruta lleva "nestor" aunque el servicio se
    // llame de otra forma en una instancia adicional.
    const binario = await serviceBinary(nombre);
    if (!binario) {
        return `no se pudo comprobar de quién es el servicio "${nombre}" (sc qc no contestó); no se toca`;
    }
    if (/nestor/i.test(binario)) return '';

    return `el servicio "${nombre}" no es de Nestor (${binario.slice(0, 120)}): reiniciarlo no arreglaría la impresión `
        + 'y sí puede romper otra cosa. Corrige el servicio en Configuración → Servicios de la caja.';
}

/** ¿Está vivo el proceso del EMV? El servicio no es un servicio de Windows: es un exe. */
async function emvProcessAlive() {
    if (!IS_WIN) return false;
    const r = await run(sysExe('tasklist.exe'), ['/FI', `IMAGENAME eq ${EMV_EXE_NAME}`, '/NH'], 8000);
    return r.stdout.toLowerCase().includes(EMV_EXE_NAME.toLowerCase());
}

let emvExeCache = '';

// El ejecutable del EMV pide administrador y este cliente no corre elevado: Windows
// devuelve ERROR_ELEVATION_REQUIRED en CreateProcess sin abrir ningún UAC. Se recuerda
// tras el primer intento porque el manifiesto de un .exe no cambia mientras corre el
// cliente, y reintentarlo en cada rescate sólo llena la bitácora de la misma línea. Se
// olvida al guardar configuración o al instalar requisitos: ahí sí pudo cambiar la ruta.
let emvDirectoNecesitaAdmin = false;

/**
 * Dónde está el ejecutable del EMV en ESTA caja.
 *
 * Por orden: lo que diga la configuración, lo que diga la ACCIÓN de la tarea programada
 * —que es la fuente más fiable, porque es literalmente lo que Windows va a ejecutar— y
 * por último la carpeta de fábrica del instalador.
 *
 * Leerlo de la tarea no es un lujo: cuando el componente se reinstala en otra carpeta,
 * la tarea se actualiza y una ruta quemada aquí apuntaría al sitio de antes. Y es
 * justamente ese desajuste el que deja la tarea devolviendo 0x2 sin decírselo a nadie.
 */
async function emvExePath(tareaInfo) {
    const configurada = String(EMV_EXE_PATH || '').trim();
    if (configurada) return configurada;

    if (tareaInfo && tareaInfo.comando) {
        emvExeCache = tareaInfo.comando;
        return emvExeCache;
    }
    if (emvExeCache) return emvExeCache;

    if (IS_WIN) {
        const info = await tasks.taskInfo(EMV_TASK, {});
        if (info.comando) {
            emvExeCache = info.comando;
            return emvExeCache;
        }
    }
    return tasks.EMV_EXE_DEFAULT;
}

function existeArchivo(ruta) {
    try { return !!ruta && fs.existsSync(ruta); } catch { return false; }
}

/**
 * Espera a que APAREZCA el proceso del EMV, hasta `ms`.
 *
 * Es la comprobación que faltaba y que explica el atasco. `schtasks /Run` devuelve 0 en
 * cuanto el Programador acepta la petición: no espera al proceso ni mira si llegó a
 * arrancar. El daemon lo tomaba como éxito y se iba a esperar 60 s al puerto 5000 — y
 * cuando la tarea había descartado el arranque en silencio (IgnoreNew, usuario sin
 * sesión, .exe que ya no está), ahí se quedaba, intento tras intento.
 *
 * Mirar el PROCESO en vez del puerto separa dos preguntas que no son la misma: «¿llegó
 * a arrancar?» se contesta en segundos, «¿ya está listo para cobrar?» tarda hasta un
 * minuto porque el EMV hace login contra el host y detecta el puerto COM.
 */
async function esperarProcesoEmv(ms) {
    const limite = Date.now() + Math.max(1000, ms || 8000);
    while (Date.now() < limite) {
        if (await emvProcessAlive()) return true;
        await sleep(700);
    }
    return false;
}

/**
 * Lanza el ejecutable del EMV directamente, sin pasar por el Programador.
 *
 * Es el último escalón. Falla si el ejecutable pide administrador y esta caja no corre
 * elevada: Windows NO abre un UAC desde CreateProcess, simplemente devuelve
 * ERROR_ELEVATION_REQUIRED (740). Eso no es un problema — es información, y decirlo con
 * esas palabras es mejor que dejar la caja en «Rescatando».
 */
function lanzarEmvDirecto(exe) {
    return new Promise((resolve) => {
        let hecho = false;
        const fin = (r) => { if (!hecho) { hecho = true; resolve(r); } };
        try {
            const hijo = spawn(exe, [], {
                cwd: path.dirname(exe),
                detached: true,
                stdio: 'ignore',
                // El EMV tiene ícono de bandeja: esconder su ventana lo dejaría corriendo
                // sin que el cajero pueda verlo ni cerrarlo.
                windowsHide: false
            });
            hijo.once('error', (e) => {
                const msg = e && e.message ? e.message : String(e);
                // 740 llega como EACCES/EPERM según la versión de libuv, y el número
                // aparece en el texto. Se mira todo, porque distinguirlo cambia el
                // consejo: no es «falló», es «hace falta administrador».
                const elevacion = /740|elevat|EACCES|EPERM/i.test(msg);
                fin({ ok: false, elevacion, error: msg });
            });
            hijo.once('spawn', () => {
                try { hijo.unref(); } catch { }
                fin({ ok: true, pid: hijo.pid, error: '' });
            });
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            fin({ ok: false, elevacion: /740|elevat|EACCES|EPERM/i.test(msg), error: msg });
        }
    });
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
 * como latido cada 3 s eso es martillar la máquina, y puede colgarse justo por lo
 * mismo que se intenta detectar. Con un printer viejo (sin /health) esa ruta contesta
 * 404 y el sondeo se conforma con que el puerto conteste — que es la pregunta que de
 * verdad importa para decidir el rescate.
 */
async function probePrinter(puerto) {
    const port = puerto || PUERTOS.printer;
    const tcp = await tcpPing(port, PROBE_TIMEOUT_MS);
    if (!tcp.open) {
        return { alive: false, error: `nadie escucha en 127.0.0.1:${port} (${tcp.error})`, warn: '', info: null };
    }

    const r = await httpGet(`http://127.0.0.1:${port}/api/v1/health`, PROBE_TIMEOUT_MS);
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
async function probeEmv(puerto) {
    const port = puerto || PUERTOS.emv;
    const tcp = await tcpPing(port, PROBE_TIMEOUT_MS);
    if (!tcp.open) {
        return { alive: false, error: `nadie escucha en 127.0.0.1:${port} (${tcp.error})`, warn: '', info: null };
    }

    const r = await httpGet(`http://127.0.0.1:${port}/api/health`, PROBE_TIMEOUT_MS);
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

    // Antes que nada: ¿es nuestro? Un `sc stop` sobre un servicio ajeno no se puede
    // deshacer, y el rescate se repetiría cada hora sin arreglar jamás el síntoma.
    const veto = await puedeReiniciarServicio(svc);
    if (veto) {
        return { ok: false, step: 'comprobación de identidad', fatal: true, error: veto };
    }

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
        if (r.code === 0) {
            // Mismo error que en el EMV, y por eso se comprueba igual: `schtasks /Run`
            // devuelve 0 en cuanto el Programador acepta la petición. Que la tarea llegue
            // a ejecutar el `sc start` es otra cosa, y el SCM sí lo sabe decir.
            for (let i = 0; i < 10; i++) {
                await sleep(1000);
                const e = await serviceState(svc);
                if (e.state === 'running') return { ok: true, step: `schtasks /Run ${PRINTER_RESCUE_TASK}` };
            }
            const info = await tasks.taskInfo(PRINTER_RESCUE_TASK, {});
            return {
                ok: false,
                step: `schtasks /Run ${PRINTER_RESCUE_TASK}`,
                error: `la tarea de respaldo aceptó el disparo y el servicio ${svc} sigue sin arrancar`
                    + (info.problemas && info.problemas.length ? `: ${info.problemas.join('; ')}` : '')
                    + (info.ultimoResultadoTexto ? ` (${info.ultimoResultadoTexto})` : '')
            };
        }
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
            ? `este usuario no puede controlar el servicio ${svc} y no existe la tarea ${PRINTER_RESCUE_TASK}. `
              + 'Configuración → Servicios de la caja → paso 5 «Requisitos» registra la tarea y concede el permiso, '
              + 'sin reinstalar.'
            : `no se pudo arrancar ${svc}`
    };
}

/**
 * Rescate de la terminal EMV, de menos a más invasivo.
 *
 * ── Lo que estaba mal ───────────────────────────────────────────────────────────
 *
 * Había un solo escalón —`schtasks /Run`— y se daba por bueno con que devolviera 0.
 * Ese código de salida sólo dice que el Programador ACEPTÓ la petición: no espera al
 * proceso, no comprueba que arrancara y no dice por qué no. Cuando la tarea descartaba
 * el arranque en silencio (MultipleInstances=IgnoreNew, que es lo que deja
 * `schtasks /Create`; el usuario registrado sin sesión iniciada; el .exe movido por el
 * antivirus), el daemon se iba a esperar sesenta segundos al puerto 5000, no pasaba
 * nada, y volvía a intentarlo. Para siempre. Desde la caja: «Rescatando» fijo.
 *
 * Y encima mataba el proceso colgado ANTES de saber si tenía con qué relanzarlo, así
 * que cada intento dejaba la caja peor de lo que estaba: sin terminal y sin el ícono de
 * bandeja con el que el cajero podía arrancarla a mano.
 *
 * ── Lo que hace ahora ───────────────────────────────────────────────────────────
 *
 *   0. Averigua qué vías hay ANTES de tocar nada. Si no hay ninguna, lo dice con el
 *      motivo concreto y se declara perdido — sin matar el proceso.
 *   1. La tarea programada, si no tiene un problema que la inutilice. Y después
 *      COMPRUEBA que el proceso apareciera, que es lo que faltaba.
 *   2. El ejecutable, lanzado directamente. Sigue siendo cierto que el exe pide
 *      administrador y que este cliente no corre elevado — pero eso hace que
 *      CreateProcess devuelva ERROR_ELEVATION_REQUIRED, no que aparezca un UAC en la
 *      cara del cajero. Si la caja sí es administradora, este escalón la rescata; si
 *      no, se dice con esas palabras.
 */
async function rescueEmv(st) {
    const usuario = tasks.usuarioActual();
    const tarea = IS_WIN
        ? await tasks.taskInfo(EMV_TASK, { usuarioEsperado: usuario, procesoLargo: true })
        : { existe: false, problemas: [], bloqueantes: [] };

    const exe = await emvExePath(tarea);
    const hayExe = existeArchivo(exe);

    // Una tarea con un problema BLOQUEANTE no se intenta: dispararla sólo gasta el rato
    // que la caja pasa sin poder cobrar. Un problema no bloqueante (IgnoreNew) sí se
    // intenta, porque a veces arranca — y para eso está la comprobación del paso 1.
    const viaTarea = tarea.existe && !(tarea.bloqueantes || []).length;
    const viaExe = EMV_DIRECT && hayExe && !emvDirectoNecesitaAdmin;

    // ── 0. ¿Hay alguna vía? ─────────────────────────────────────────────────────
    if (!viaTarea && !viaExe) {
        const motivos = [];
        if (!tarea.existe) {
            motivos.push(`no existe la tarea ${EMV_TASK} en esta caja`);
        } else if ((tarea.bloqueantes || []).length) {
            motivos.push(`la tarea ${EMV_TASK} no puede arrancar nada: ${tarea.bloqueantes.join('; ')}`);
        }
        if (!hayExe) {
            motivos.push(`tampoco está el ejecutable en ${exe}`);
        } else if (!EMV_DIRECT) {
            motivos.push('y lanzar el ejecutable directamente está desactivado en la configuración de esta caja');
        }
        return {
            ok: false,
            step: 'comprobación previa',
            fatal: true,
            // Se dice qué hacer, no sólo qué pasa. Este texto acaba en la barra del POS
            // y en la incidencia que sube a la nube: es lo que va a leer quien atienda.
            error: `${motivos.join('; ')}. Abre Configuración → Servicios de la caja → paso 5 `
                + '«Requisitos» y pulsa «Revisar e instalar»: desde ahí se registra la tarea correctamente. '
                + 'Si falta el ejecutable, hay que reinstalar el componente EMV Santander.'
        };
    }

    // Colgado: el puerto no contesta pero el proceso vive. AHORA sí se termina, porque
    // ya sabemos que hay con qué relanzarlo.
    const vivo = await emvProcessAlive();
    if (vivo) {
        log(`[emv] el proceso vive pero :${PUERTOS.emv} no contesta; se termina antes de relanzar`);
        await run(sysExe('taskkill.exe'), ['/IM', EMV_EXE_NAME, '/F'], 15000);
        // El Programador tarda en darse cuenta de que la instancia murió, y hasta que se
        // entera una tarea en IgnoreNew descarta cada relanzamiento devolviendo 0. Segundo
        // y medio no le bastaba.
        await sleep(3000);
    }

    // ── 1. La tarea programada ──────────────────────────────────────────────────
    if (viaTarea) {
        const r = await run(sysExe('schtasks.exe'), ['/Run', '/TN', EMV_TASK], 20000);
        const salida = `${r.stdout}${r.stderr}`.trim().slice(0, 300);

        if (r.code === 0) {
            // Un 0 no es un arranque: se comprueba que el proceso exista de verdad. Esto
            // es lo que faltaba y lo que dejaba la caja en «Restableciendo…».
            if (await esperarProcesoEmv(8000)) {
                return { ok: true, step: `schtasks /Run ${EMV_TASK}` };
            }

            // Que no haya aparecido en ocho segundos NO prueba que no vaya a arrancar.
            // Con la tarea bien registrada (usuario correcto, StopExisting) el
            // Programador todavía tiene que localizar la sesión interactiva del usuario,
            // y el antivirus escanea el ejecutable la primera vez tras registrarla. En
            // una caja real eso tardó más de diez segundos y acabó arrancando bien.
            log(`[emv] la tarea ${EMV_TASK} aceptó el disparo y el proceso aún no aparece`);

            if (viaExe) {
                const d = await lanzarEmvDirecto(exe);
                if (d.ok) return { ok: true, step: `arranque directo de ${path.basename(exe)}` };
                if (d.elevacion) {
                    // Una vez basta para saberlo: el manifiesto del ejecutable no cambia
                    // mientras corra este cliente. Reintentarlo en cada rescate sólo
                    // llena la bitácora de la misma línea.
                    emvDirectoNecesitaAdmin = true;
                    log(`[emv] el ejecutable pide administrador y este cliente no corre elevado; `
                        + 'no se vuelve a intentar el arranque directo. La vía es la tarea programada.');
                } else {
                    log(`[emv] el arranque directo no funcionó: ${d.error}`);
                }
            }

            // La tarea ACEPTÓ el disparo. Eso es un lanzamiento, y lo que sigue es
            // esperar — que es justo para lo que existe la ventana de arranque, y que no
            // bloquea el daemon.
            //
            // Antes aquí se declaraba `fatal`, y esa era la trampa: una caja cuya tarea
            // funcionaba (sólo que tardaba) se daba por irrecuperable para siempre y
            // subía una incidencia. O sea, el mismo fallo de antes con otra cara — dar
            // por bueno lo que no se ha comprobado, sólo que al revés.
            return {
                ok: true,
                step: `schtasks /Run ${EMV_TASK}`,
                lento: true
            };
        }

        const denegado = /denegado|denied|0x80070005|acceso/i.test(salida);
        log(`[emv] schtasks /Run falló (${r.code}): ${salida}`);
        if (!viaExe) {
            return {
                ok: false,
                step: `schtasks /Run ${EMV_TASK}`,
                fatal: denegado,
                error: denegado
                    ? `este usuario no tiene permiso para disparar la tarea ${EMV_TASK}. `
                      + 'Configuración → Servicios de la caja → paso 5 «Requisitos» se lo concede.'
                    : `la tarea no arrancó (${r.code}): ${salida}`
            };
        }
    }

    // ── 2. El ejecutable, directo ───────────────────────────────────────────────
    // Sólo se llega aquí cuando la tarea NO era una vía (no existe, o tiene un problema
    // que la inutiliza). Si la tarea aceptó el disparo, arriba ya se decidió.
    if (viaExe) {
        log(`[emv] se lanza el ejecutable directamente: ${exe}`);
        const r = await lanzarEmvDirecto(exe);
        if (r.ok) return { ok: true, step: `arranque directo de ${path.basename(exe)}` };

        if (r.elevacion) emvDirectoNecesitaAdmin = true;

        const admin = await tasks.esAdministrador();
        const porTarea = tarea.existe
            ? `La tarea ${EMV_TASK} no sirve (${(tarea.bloqueantes || []).join('; ') || 'sin diagnóstico'}). `
            : `No existe la tarea ${EMV_TASK}. `;

        return {
            ok: false,
            step: `arranque directo de ${path.basename(exe)}`,
            fatal: true,
            error: r.elevacion
                ? `${porTarea}Y el ejecutable pide permisos de administrador, que este cliente no tiene`
                  + `${admin ? '' : ` (${usuario || 'este usuario'} tampoco es administrador de la máquina)`}. `
                  + 'La vía tiene que ser la tarea programada: Configuración → Servicios de la caja → '
                  + 'paso 5 «Requisitos» la registra bien.'
                : `${porTarea}Y no se pudo lanzar ${exe}: ${r.error}`
        };
    }

    return {
        ok: false,
        step: 'sin escalones',
        fatal: true,
        error: emvDirectoNecesitaAdmin
            ? `la tarea ${EMV_TASK} no puede arrancar la terminal y el ejecutable pide administrador. `
              + 'Configuración → Servicios de la caja → paso 5 «Requisitos» vuelve a registrar la tarea.'
            : 'no quedó ninguna vía de rescate para la terminal'
    };
}

const RESCATES = { printer: rescuePrinter, emv: rescueEmv };
const SONDAS = { printer: probePrinter, emv: probeEmv };

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
        // Hasta cuándo se le está dando margen a un arranque en curso. Es la diferencia
        // entre «se está levantando ahora mismo» y «lleva media hora diciendo lo mismo»,
        // que desde la barra del POS se veían idénticas.
        settleUntil: st.settleUntil,
        // El rescate no es posible en esta caja y ya se sabe por qué (`detail` lo dice).
        // No va a haber más intentos hasta que alguien cambie algo.
        fatal: st.fatal,
        // Las dos compuertas, visibles. Sin esto, "el daemon no hizo nada" es
        // indistinguible de "el daemon está roto", y la respuesta suele ser la primera:
        // no se toca un servicio que se está usando.
        lastTrafficAt: st.lastTrafficAt,
        enVuelo: st.enVuelo.size,
        lastFailAt: st.lastFailAt,
        holdUntil: st.holdUntil,
        // Por qué no se tocaría este servicio AHORA MISMO, en una frase. Casi siempre
        // la respuesta es "porque se está usando", y tenerla escrita convierte media
        // hora de investigación en un renglón.
        esperaPor: motivoParaEsperar(st, Date.now())
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
        // Para que la barra del POS y el asistente puedan decir "esto está así porque
        // alguien lo configuró" en vez de dejarlo como un misterio.
        configurado: Object.values(cfg.fuentes).some((f) => f !== 'fábrica'),
        configFile: cfg.archivo,
        // Ajustes guardados que NO se están aplicando (un servicio del sistema que
        // quedó en el archivo de una versión anterior). Se enseña donde se vea.
        vetados: cfg.vetados || [],
        services: Object.values(servicios).map(payloadDe)
    };
}

function broadcast() {
    if (typeof onChange !== 'function') return;
    try { onChange(status()); } catch { }
}

// Firma de lo que se ve desde afuera. Difundir en cada ronda sería un evento cada 3 s
// por caja —20 por minuto, y ninguno diría nada nuevo—; sólo interesa el cambio (mismo
// criterio que setLocalServerState en main.js).
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

    // Trabajo AHORA MISMO. Esta es la compuerta que de verdad protege una impresión o
    // un cobro a medias: mientras la petición no haya terminado, el servicio se está
    // usando, dure lo que dure (una venta EMV bloquea hasta 75 s esperando la tarjeta).
    const vuelo = purgarEnVuelo(st, ahora);
    if (vuelo > 0) {
        return `hay ${vuelo} petición(es) en curso hacia el servicio`;
    }

    // Silencio tras un uso que SALIÓ BIEN.
    //
    // Aquí estaba el fallo que hacía que el rescate llegara tardísimo, o nunca: se
    // anotaba el tráfico al SALIR la petición, sin mirar cómo terminaba. Con el
    // servicio caído, cada intento de imprimir del cajero contaba como "se está
    // usando" y empujaba la espera otros 90 s — de modo que cuanto más intentaba
    // imprimir, más se retrasaba el arreglo. Una petición que se estrella contra un
    // puerto cerrado no es uso: es la prueba de la caída.
    if (QUIET_MS && st.lastTrafficAt && (ahora - st.lastTrafficAt) < QUIET_MS) {
        return `se usó con éxito hace ${Math.round((ahora - st.lastTrafficAt) / 1000)} s`;
    }

    if (st.nextAttemptAt > ahora) {
        return `espera entre intentos (${Math.round((st.nextAttemptAt - ahora) / 1000)} s)`;
    }
    return '';
}

/**
 * Peticiones realmente en curso, descartando las que se quedaron colgadas.
 *
 * El contador se lleva por id de petición y no como un número suelto: si una petición
 * no llegara a notificar su final (la ventana se recarga a media impresión), un
 * contador nunca volvería a cero y el servicio quedaría blindado PARA SIEMPRE — vigilado
 * y nunca rescatado, que es el peor de los mundos porque se ve como si funcionara.
 */
function purgarEnVuelo(st, ahora) {
    const limite = (ahora || Date.now()) - EN_VUELO_MAX_MS;
    for (const [id, ts] of st.enVuelo) {
        if (ts < limite) st.enVuelo.delete(id);
    }
    return st.enVuelo.size;
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
            const como = st.settleStep ? ` con ${st.settleStep}` : '';
            log(`[${st.id}] restablecido${como} tras ${st.attempts} intento(s) de rescate`);
        }
        st.state = 'ok';
        st.detail = st.warn || (st.settleStep ? `restablecido con ${st.settleStep}` : 'atendiendo');
        st.strikes = 0;
        st.lastOkAt = ahora;
        st.lastError = '';
        st.attempts = 0;
        st.nextAttemptAt = 0;
        st.settleUntil = 0;
        st.settleStep = '';
        st.reported = false;
        st.fatal = false;
        st.fatalMotivo = '';
        st.lastFailAt = 0;
        st.lastFailError = '';
        return;
    }

    // ── Arrancando ──────────────────────────────────────────────────────────────
    //
    // Se acaba de lanzar y todavía está dentro de su margen. NO cuenta como fallo nuevo
    // ni dispara otro rescate: el EMV tarda de verdad —login contra el host de Santander
    // y detección del puerto COM— y pedir otro rescate encima mata el proceso que acaba
    // de nacer.
    //
    // Esto era un bucle con await dentro de la propia ronda. Bloqueaba el daemon entero
    // hasta un minuto: el printer no se sondeaba, no se difundía nada y el botón de
    // reparar de la barra se quedaba esperando la misma promesa. Ahora es una marca de
    // tiempo, y cada ronda —cada 3 s— vuelve por aquí, actualiza el detalle y lo difunde.
    if (st.settleUntil > ahora) {
        const quedan = Math.round((st.settleUntil - ahora) / 1000);
        st.state = 'rescatando';
        st.detail = `arrancando con ${st.settleStep}: ${quedan} s más antes de darlo por fallido`;
        return;
    }
    if (st.settleUntil) {
        // Se agotó el margen sin que contestara. El intento se da por fallido AQUÍ, no
        // dentro del rescate, y a partir de ahora vuelven a contar las reglas normales.
        st.settleUntil = 0;
        st.nextAttemptAt = ahora + BACKOFF_MS[Math.min(Math.max(st.attempts - 1, 0), BACKOFF_MS.length - 1)];
        st.lastRescueError = `se lanzó ${st.settleStep} pero el servicio no contestó en `
            + `${Math.round(SETTLE_MS[st.id] / 1000)} s`;
        log(`[${st.id}] ${st.lastRescueError}`);
        st.settleStep = '';
    }

    // ── No contesta ─────────────────────────────────────────────────────────────
    st.lastError = sonda.error || 'no responde';
    // Tope: pasado el umbral el contador ya no dice nada nuevo, y se muestra en la UI
    // ("sin respuesta 7/3" no significa nada). Lo que cuenta a partir de ahí son los
    // intentos de rescate.
    st.strikes = Math.min(st.strikes + 1, STRIKES);

    // Dos fuentes independientes diciendo lo mismo valen más que tres sondeos seguidos
    // de una sola. Si la VENTANA acaba de estrellarse contra el puerto —el cajero pulsó
    // imprimir y no pasó nada— la caída ya está confirmada: esperar los fallos que
    // faltan sólo alarga el rato que la caja pasa sin imprimir.
    if (st.strikes < STRIKES && st.lastFailAt && (ahora - st.lastFailAt) < EVIDENCIA_MS) {
        log(`[${st.id}] la ventana también falló contra el servicio (${st.lastFailError}); no se esperan más sondeos`);
        st.strikes = STRIKES;
    }

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

    // ── Ya se sabe que no hay nada que hacer ────────────────────────────────────
    //
    // Un fallo estructural —no está la tarea, no está el ejecutable, no hay permisos— no
    // mejora por reintentar. Antes se declaraba `rendido` una vez y luego el tope por
    // hora, que es una ventana DESLIZANTE, dejaba hueco al cabo de un rato y la caja
    // volvía a «rescatando»: alternaba entre los dos estados para siempre, gastando
    // intentos contra una tarea que no existe y enseñando «Rescatando» a quien mirara.
    // Se recuerda, y se sale de aquí sólo cuando alguien cambia algo (reparar, guardar
    // configuración) o cuando el servicio vuelve solo.
    if (st.fatal) {
        st.state = 'rendido';
        st.detail = st.fatalMotivo || st.detail || 'el rescate no es posible en esta caja';
        await reportarRendicion(st);
        return;
    }

    podarRescates(st);
    const agotado = st.rescues.length >= MAX_RESCUES_PER_HOUR;

    const espera = motivoParaEsperar(st, ahora);
    if (espera) {
        // Ya se confirmaron los STRIKES fallos: el servicio está abajo y se sabe. Que
        // estemos esperando NO es rescatar — antes esto ponía «rescatando» mientras el
        // daemon no hacía absolutamente nada durante cinco minutos de backoff, que es
        // media explicación de por qué la caja parecía atascada en ese estado.
        st.state = agotado ? 'rendido' : 'caido';
        st.detail = `${st.lastError} — en espera: ${espera}`;
        return;
    }

    if (agotado) {
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
            st.fatal = true;
            st.fatalMotivo = res.error || 'el rescate no es posible en esta caja';
            st.state = 'rendido';
            st.detail = st.fatalMotivo;
            await reportarRendicion(st);
            return;
        }
        st.nextAttemptAt = ahora + BACKOFF_MS[Math.min(st.attempts - 1, BACKOFF_MS.length - 1)];
        st.detail = `el rescate falló: ${res.error}`;
        st.state = 'caido';
        return;
    }

    // Lanzado. El margen de arranque se lleva por marca de tiempo y lo vigilan las
    // rondas siguientes (ver «Arrancando», arriba): así el daemon sigue sondeando el
    // otro servicio, difunde el estado cada 3 s y no deja colgado el botón de reparar.
    st.settleUntil = Date.now() + SETTLE_MS[st.id];
    st.settleStep = res.step || 'el rescate';
    st.detail = `arrancando con ${st.settleStep}: hasta ${Math.round(SETTLE_MS[st.id] / 1000)} s`;
    log(`[${st.id}] rescate lanzado (${res.step}); esperando a que conteste`);
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

// ── Configuración en caliente y descubrimiento ──────────────────────────────────
//
// Lo que sigue es lo que consume el asistente de la ventana de Configuración. Su
// razón de ser: nombres como "NestorPrinter" o "NestorSantanderEMV" no son universales
// —el instalador los escribe en instance.json y una instancia adicional los cambia—,
// así que pedirle a quien configura la caja que los TECLEE de memoria es pedirle que
// se equivoque. Se le enseña lo que la máquina realmente tiene y elige de una lista.

/**
 * Reaplica la configuración SIN reiniciar el cliente.
 *
 * El orden importa: primero los valores, luego la vigilancia, y el temporizador al
 * final. Reprogramarlo antes de tener WATCH_MS nuevo dejaría el intervalo viejo hasta
 * el siguiente guardado, y eso se ve exactamente como "la configuración no sirve".
 */
function aplicaConfig(nueva) {
    cfg = nueva;
    aplicaConfigValores();

    // El nombre del servicio se cachea tras descubrirlo; si acaban de cambiarlo (o de
    // cambiar de dónde se lee), la caché es justo la respuesta equivocada.
    printerServiceCache = null;

    aplicaVigilancia();

    // Un servicio que se acaba de reapuntar arrastra los fallos del anterior. Contarlos
    // como propios haría que el primer sondeo con la configuración nueva ya llegara al
    // umbral y rescatara sin haber fallado una sola vez.
    for (const st of Object.values(servicios)) {
        st.strikes = 0;
        st.attempts = 0;
        st.nextAttemptAt = 0;
        st.reported = false;
        // Guardar configuración es exactamente lo que hace alguien DESPUÉS de leer por
        // qué el rescate era imposible. Seguir dando la caja por perdida con la razón
        // vieja convertiría el arreglo en «no sirvió de nada».
        st.fatal = false;
        st.fatalMotivo = '';
        st.settleUntil = 0;
        st.settleStep = '';
    }

    if (timer) clearInterval(timer);
    timer = null;
    if (ENABLED && !initError) {
        timer = setInterval(() => { tick('ronda').catch(() => { }); }, WATCH_MS);
        if (timer.unref) timer.unref();
    }

    broadcast();
}

/** Los valores sueltos, sin efectos. Lo comparten init() y aplicaConfig(). */
function aplicaConfigValores() {
    ENABLED = cfg.valores.enabled;
    RESCUE_ENABLED = cfg.valores.rescue;
    WATCH_MS = cfg.valores.watch_ms;
    PROBE_TIMEOUT_MS = cfg.valores.probe_ms;
    STRIKES = cfg.valores.strikes;
    QUIET_MS = cfg.valores.quiet_ms;
    MAX_RESCUES_PER_HOUR = cfg.valores.max_per_hour;
    SETTLE_MS = { printer: cfg.valores.settle_printer_ms, emv: cfg.valores.settle_emv_ms };
    PUERTOS = { printer: cfg.valores.printer_port, emv: cfg.valores.emv_port };
    PRINTER_SERVICE_DEFAULT = cfg.valores.printer_service || 'NestorPrinter';
    PRINTER_RESCUE_TASK = cfg.valores.printer_rescue_task;
    PRINTER_INSTANCE_FILE = cfg.valores.printer_instance_file;
    EMV_TASK = cfg.valores.emv_task;
    EMV_EXE_NAME = cfg.valores.emv_exe;
    EMV_EXE_PATH = cfg.valores.emv_exe_path;
    EMV_DIRECT = cfg.valores.emv_direct_launch;
    emvExeCache = '';
    emvDirectoNecesitaAdmin = false;
    // Cambiar un puerto o la ruta del EMV cambia DE QUÉ componente se está hablando:
    // una versión cacheada de antes sería la de otra cosa.
    versionesCache = { at: 0, datos: null };
}

/** La configuración efectiva, con la procedencia de cada valor y el esquema. */
function config() {
    return {
        ok: true,
        esquema: configStore.ESQUEMA,
        valores: cfg.valores,
        fuentes: cfg.fuentes,
        // Qué está fijado por entorno y con qué variable. El asistente bloquea esos
        // campos: configurar algo que no va a surtir efecto es peor que no poder.
        env: cfg.env,
        archivo: cfg.archivo,
        error: cfg.error,
        plataforma: process.platform,
        esWindows: IS_WIN,
        modo: status().mode
    };
}

/** Guarda un cambio parcial y lo aplica en el acto. */
function configure(parcial) {
    if (!dir) return { ok: false, error: 'no hay dónde escribir la configuración (bitácora sin directorio)' };

    const res = configStore.save(dir, parcial || {});
    if (!res.ok) return res;

    const antes = JSON.stringify(cfg.valores);
    aplicaConfig(res.config);
    if (JSON.stringify(cfg.valores) !== antes) {
        log(`configuración actualizada desde el asistente: ${res.aplicadas.join(', ') || '(sin cambios efectivos)'}`);
    }

    // Un sondeo inmediato: quien acaba de configurar está mirando la pantalla y espera
    // ver el resultado, no esperar hasta la siguiente ronda.
    tick('configuración').catch(() => { });

    return { ok: true, aplicadas: res.aplicadas, ignoradas: res.ignoradas, config: config() };
}

/** Vuelve a los valores de fábrica (borra el archivo). */
function resetConfig() {
    if (!dir) return { ok: false, error: 'no hay archivo de configuración' };
    const res = configStore.reset(dir);
    if (!res.ok) return res;
    log('configuración devuelta a valores de fábrica');
    aplicaConfig(res.config);
    tick('configuración').catch(() => { });
    return { ok: true, config: config() };
}

/**
 * Servicios de Windows instalados en esta máquina.
 *
 * `sc query type= service state= all` con los espacios EXACTAMENTE así: sc.exe espera
 * "clave= valor" (espacio DESPUÉS del igual, no antes), y escrito de cualquier otra
 * forma devuelve la ayuda de uso en vez de la lista, en silencio.
 */
async function listWindowsServices() {
    if (!IS_WIN) return [];
    const r = await run(sysExe('sc.exe'), ['query', 'type=', 'service', 'state=', 'all'], 20000);
    const salida = `${r.stdout}\n${r.stderr}`;

    // Windows en español imprime NOMBRE_SERVICIO / NOMBRE_PARA_MOSTRAR. Los nombres de
    // los CAMPOS sí se traducen (los del enum de estado no), así que se aceptan ambos.
    const out = [];
    let actual = null;
    for (const linea of salida.split(/\r?\n/)) {
        const m = /^\s*(SERVICE_NAME|NOMBRE_SERVICIO)\s*:\s*(.+?)\s*$/i.exec(linea);
        if (m) {
            actual = { name: m[2], display: '', state: '' };
            out.push(actual);
            continue;
        }
        if (!actual) continue;
        const d = /^\s*(DISPLAY_NAME|NOMBRE_PARA_MOSTRAR)\s*:\s*(.+?)\s*$/i.exec(linea);
        if (d) { actual.display = d[2]; continue; }
        const e = /\b(STOPPED|RUNNING|START_PENDING|STOP_PENDING|PAUSED)\b/i.exec(linea);
        if (e && !actual.state) actual.state = e[1].toUpperCase();
    }
    return out;
}

/**
 * Tareas programadas. `/FO CSV /NH` porque la salida en tabla se trunca a lo ancho de
 * la consola y parte los nombres largos justo por la mitad.
 */
async function listScheduledTasks() {
    if (!IS_WIN) return [];
    const r = await run(sysExe('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH'], 25000);
    const out = [];
    for (const linea of String(r.stdout || '').split(/\r?\n/)) {
        const t = linea.trim();
        if (!t || !t.startsWith('"')) continue;
        // Primera columna del CSV. Puede traer comas dentro de las comillas.
        const m = /^"((?:[^"]|"")*)"/.exec(t);
        if (!m) continue;
        const nombre = m[1].replace(/""/g, '"');
        if (!nombre || nombre.toLowerCase() === 'tasknamex') continue;
        // Se guarda sin la barra inicial: es como se teclea en `schtasks /Run /TN`.
        out.push(nombre.replace(/^\\/, ''));
    }
    return [...new Set(out)];
}

/** Qué dice cada instance.json candidato (y el que se haya configurado a mano). */
function readInstanceFiles() {
    const candidatos = [];
    if (PRINTER_INSTANCE_FILE) candidatos.push(PRINTER_INSTANCE_FILE);
    candidatos.push('C:\\NestorMX\\NestorPOS\\instance.json');
    candidatos.push('C:\\NestorMX\\NestorComplementos\\instance.json');

    const out = [];
    for (const ruta of [...new Set(candidatos)]) {
        try {
            const cfgJson = JSON.parse(fs.readFileSync(ruta, 'utf8'));
            out.push({
                ruta,
                existe: true,
                // "" no es un error: una instancia adicional lo deja vacío a propósito
                // porque comparte el servicio de la principal.
                printer_service: String(cfgJson.printer_service || '').trim(),
                instancia: String(cfgJson.instance || cfgJson.name || '').trim()
            });
        } catch (e) {
            out.push({ ruta, existe: false, printer_service: '', instancia: '', error: e && e.code === 'ENOENT' ? 'no existe' : String(e && e.message || e) });
        }
    }
    return out;
}

/**
 * ¿Este servicio de Windows parece uno nuestro? Decide qué se destaca en el asistente.
 *
 * Por el NOMBRE, nunca por el nombre visible. Aquí había un
 * `/nestor|printer|impres|emv|santander/i` aplicado a "nombre + nombre visible", y el
 * Spooler de Windows se llama «Cola de impresión»: encajaba con "impres" y subía al
 * grupo de arriba del desplegable, junto a los nuestros. Elegirlo era lo natural —dice
 * impresión— y a partir de ahí el rescate le hacía `sc stop` cada vez que
 * nestor_printer no contestaba. Destacar de más aquí no es una molestia: es una trampa.
 */
function pareceServicioNuestro(name, display) {
    return /^nestor/i.test(String(name || '').trim()) || /nestor/i.test(String(display || ''));
}

/**
 * Todo lo que el asistente necesita para ofrecer listas en vez de campos vacíos.
 *
 * Se marca lo que "parece" nuestro (nestor / printer / emv / santander) para poder
 * enseñarlo arriba: en una máquina con 250 servicios, una lista alfabética es lo mismo
 * que no tener lista.
 */
async function discover() {
    const [servs, tareas] = await Promise.all([listWindowsServices(), listScheduledTasks()]);

    const protegido = (n) => configStore.SERVICIOS_PROTEGIDOS.includes(String(n).toLowerCase());

    return {
        ok: true,
        esWindows: IS_WIN,
        // En macOS/Linux esto viene vacío y el asistente lo dice, en vez de enseñar
        // listas vacías que parecen un error.
        servicios: servs.map((x) => ({
            ...x,
            sugerido: pareceServicioNuestro(x.name, x.display),
            // El asistente los enseña, pero no deja elegirlos: verlos y entender por qué
            // no valen es mejor que no encontrarlos y pensar que la lista está mal.
            protegido: protegido(x.name)
        })),
        tareas: tareas.map((name) => ({ name, sugerido: /nestor|santander/i.test(name) })),
        instancias: readInstanceFiles(),
        servicioResuelto: IS_WIN ? resolvePrinterService() : ''
    };
}

// ── Versiones de los componentes de la caja ─────────────────────────────────────
//
// QUÉ VERSIÓN CORRE CADA PIEZA DE ESTA CAJA, con su fecha de compilación.
//
// Lo pinta la pantalla de acceso del POS debajo del número de licencia, y existe para
// la primera pregunta de casi cualquier reporte de soporte: "¿esta caja está al día?".
// Hoy eso se contesta entrando a la máquina, o esperando al latido de topología que
// sube a la nube (topology.report.js) y mirando el panel — con el cajero al teléfono.
//
// Tres decisiones que no son obvias:
//
// 1. Se aprovecha lo que el daemon YA sabe: `st.info` es el cuerpo del último sondeo
//    de salud, de hace segundos. Sólo se sale a preguntar lo que falte. En la pantalla
//    de acceso el EMV todavía no está bajo vigilancia —lo enciende el POS al entrar a
//    vender—, así que ahí sí hay que sondearlo: /api/health es su puerta barata, la
//    única que contesta sin activación ni emparejamiento.
//
// 2. La fecha del printer sale de /api/v1/health. Un printer anterior no la trae (se
//    agregó junto con esta pantalla) y entonces se cae a /api/v1, la "cara", que sí la
//    ha tenido siempre — pero calcula el HWID en cada llamada, entrando al hardware.
//    Por eso es el RESPALDO y no la vía, y por eso todo esto se cachea: como latido
//    sería martillar la máquina; una vez cada diez minutos no es nada.
//
// 3. La versión del EMV no sale de su ensamblado (AssemblyVersion lleva años en
//    1.0.0.0): la estampa el Fact al publicar, en un version.txt junto al .exe, y el
//    microservicio la devuelve en /api/health. La FECHA no la estampa nadie, así que
//    se usa la del EJECUTABLE instalado — el mismo criterio que el `binary_built_at`
//    del servidor, y lo más cercano a la verdad que hay sin recompilar el componente.
//
// Como todo lo de este archivo: no lanza nunca. Un dato que no se pudo averiguar va
// vacío, y la pantalla enseña la versión sin fecha en vez de no enseñar nada.
const VERSIONES_TTL_MS = 10 * 60 * 1000;
let versionesCache = { at: 0, datos: null };

async function versiones(opts) {
    const forzar = !!(opts && opts.force);
    const ahora = Date.now();
    if (!forzar && versionesCache.datos && (ahora - versionesCache.at) < VERSIONES_TTL_MS) {
        return { ...versionesCache.datos, cacheada: true };
    }

    const [printer, emv] = await Promise.all([versionPrinter(), versionEmv()]);
    const datos = { ok: true, at: ahora, printer, emv };
    versionesCache = { at: ahora, datos };
    return { ...datos, cacheada: false };
}

/** Sello del microservicio de impresión de ESTA caja (el que el daemon vigila). */
async function versionPrinter() {
    const st = servicios.printer;
    const out = {
        puerto: PUERTOS.printer,
        version: '',
        commit: '',
        branch: '',
        buildDate: '',
        layoutVersion: 0,
        contesta: false,
        fuente: '',
        // "nunca" es una caja que no imprime aquí (imprime en otra máquina, o no
        // imprime). Mismo criterio que el EMV: donde no hay componente no hay versión
        // de la que hablar, y un renglón vacío se lee como una falla.
        aplica: String(cfg.valores.printer_watch || '') !== 'nunca'
    };
    if (!out.aplica) return out;

    // El sondeo vivo, si lo hay. Con la vigilancia apagada (o antes de la primera
    // ronda) no hay nada guardado y se pregunta aquí mismo: /api/v1/health no toca la
    // DLL ni la impresora.
    let salud = (st && st.info) || null;
    if (salud && salud.build_version) {
        out.contesta = true;
    } else {
        const sonda = await probePrinter();
        salud = (sonda && sonda.info) || null;
        out.contesta = !!(sonda && sonda.alive);
    }

    if (salud) {
        out.version = String(salud.build_version || '');
        out.commit = String(salud.build_commit || '');
        out.buildDate = String(salud.build_date || '');
        out.layoutVersion = Number(salud.layout_version) || 0;
        if (out.version) out.fuente = 'health';
    }

    // Respaldo para un printer anterior a que /health llevara la fecha. Se paga el HWID
    // una vez por ventana de caché, y sólo cuando hay alguien contestando al otro lado.
    if (!out.buildDate && out.contesta) {
        const r = await httpGet(`http://127.0.0.1:${PUERTOS.printer}/api/v1`, PROBE_TIMEOUT_MS);
        const cara = (r && r.ok && r.status === 200 && r.body) || null;
        if (cara) {
            out.version = String(cara.build_version || out.version || '');
            out.commit = String(cara.build_commit || out.commit || '');
            out.branch = String(cara.build_branch || '');
            out.buildDate = String(cara.build_date || '');
            out.layoutVersion = Number(cara.layout_version) || out.layoutVersion;
            out.fuente = 'index';
        }
    }

    return out;
}

/** Sello del microservicio EMV Santander, si esta caja lo tiene. */
async function versionEmv() {
    const st = servicios.emv;
    const out = {
        puerto: PUERTOS.emv,
        version: '',
        dllVersion: '',
        exe: '',
        instalado: false,
        builtAt: '',
        contesta: false,
        // "nunca" es lo que se pone en una caja SIN terminal. No es que no se sepa la
        // versión: es que aquí no hay componente del que hablar, y la pantalla no debe
        // enseñar un renglón en gris que parezca una falla.
        aplica: String(cfg.valores.emv_watch || '') !== 'nunca'
    };
    if (!out.aplica) return out;

    let salud = (st && st.info) || null;
    if (salud && salud.service_version) {
        out.contesta = true;
    } else {
        const sonda = await probeEmv();
        salud = (sonda && sonda.info) || null;
        out.contesta = !!(sonda && sonda.alive);
    }

    if (salud) {
        out.version = String(salud.service_version || '');
        const detalle = salud.detail || {};
        out.dllVersion = String(detalle.version || '');
    }

    // El ejecutable instalado: es lo que distingue "la terminal está apagada" de "en
    // esta caja no hay componente EMV", y de él sale la fecha.
    if (IS_WIN) {
        try {
            out.exe = await emvExePath(null);
            out.instalado = existeArchivo(out.exe);
            out.builtAt = fechaDeArchivo(out.exe);
        } catch { /* se queda sin ruta: la versión igual vale */ }
    }

    return out;
}

/** Fecha de modificación de un archivo, en ISO. '' si no se pudo leer. */
function fechaDeArchivo(ruta) {
    try {
        if (!ruta) return '';
        const st = fs.statSync(ruta);
        return st && st.mtime ? new Date(st.mtime).toISOString() : '';
    } catch { return ''; }
}

/**
 * Prueba un destino CANDIDATO sin guardarlo.
 *
 * Es la mitad del valor del asistente: contestar "sí, ahí está" antes de guardar, en
 * vez de guardar, esperar la siguiente ronda y deducirlo de un estado en la barra.
 */
async function probeTarget(arg) {
    const a = arg || {};
    const id = String(a.id || '');
    if (id !== 'printer' && id !== 'emv') return { ok: false, error: `servicio desconocido: ${id}` };

    const puerto = configStore.sanea(id === 'printer' ? 'printer_port' : 'emv_port', a.port);
    const port = puerto || PUERTOS[id];

    const sonda = id === 'printer' ? await probePrinter(port) : await probeEmv(port);
    const out = {
        ok: true,
        id,
        puerto: port,
        contesta: sonda.alive,
        error: sonda.error || '',
        aviso: sonda.warn || '',
        info: sonda.info || null,
        pasos: []
    };

    if (!IS_WIN) {
        out.pasos.push({ paso: 'servicios de Windows', ok: false, detalle: `no aplica en ${process.platform}` });
        return out;
    }

    if (id === 'printer') {
        const nombre = String(a.service || '').trim() || resolvePrinterService();
        const st = await serviceState(nombre);
        out.servicio = nombre;
        out.pasos.push({
            paso: `sc query ${nombre}`,
            ok: st.state === 'running',
            detalle: st.state === 'ausente' ? 'no está registrado en esta máquina (hay que reinstalar el componente)'
                : st.state === 'sin-permiso' ? 'existe, pero este usuario no puede consultarlo'
                    : st.state
        });

        const tarea = String(a.rescueTask || '').trim() || PRINTER_RESCUE_TASK;
        const hay = await taskExists(tarea);
        out.pasos.push({
            paso: `tarea de respaldo ${tarea}`,
            ok: hay,
            detalle: hay ? 'registrada' : 'no existe: sin ella, una caja sin permisos no se puede rescatar'
        });
        return out;
    }

    const tarea = String(a.task || '').trim() || EMV_TASK;
    out.tarea = tarea;

    // Antes esto sólo decía «registrada» o «no existe», y ninguna de las dos contestaba
    // la pregunta que importa: si esa tarea VA A ARRANCAR algo. Una tarea registrada a
    // nombre de quien instaló, o en IgnoreNew, o apuntando a un .exe que el antivirus se
    // llevó, sale «registrada» y no rescata nunca.
    const info = await tasks.taskInfo(tarea, {
        usuarioEsperado: tasks.usuarioActual(),
        procesoLargo: true
    });
    out.pasos.push({
        paso: `tarea ${tarea}`,
        ok: info.existe && !(info.problemas || []).length,
        detalle: !info.existe
            ? (info.error || 'no existe en esta caja')
            : ((info.problemas || []).length
                ? info.problemas.join(' · ')
                : `a nombre de ${info.usuario || '(sin usuario)'}${info.elevada ? ', elevada' : ''}`
                  + `${info.ultimoResultadoTexto ? ' — ' + info.ultimoResultadoTexto : ''}`)
    });

    const exe = await emvExePath(info);
    const hayExe = existeArchivo(exe);
    out.emvExe = exe;
    out.pasos.push({
        paso: 'ejecutable de la terminal',
        ok: hayExe,
        detalle: hayExe ? exe : `${exe} — no está: hay que reinstalar el componente EMV Santander`
    });

    const vivo = await emvProcessAlive();
    out.pasos.push({
        paso: `proceso ${EMV_EXE_NAME}`,
        ok: vivo,
        detalle: vivo ? 'corriendo' : 'no está corriendo'
    });
    return out;
}

/**
 * ¿Está esta caja en condiciones de rescatarse sola?
 *
 * Lo consume el paso «Requisitos» del asistente. Vale la pena que sea una pregunta
 * aparte de `probeTarget`: aquella comprueba un destino que se está CONFIGURANDO, y
 * esta comprueba la caja tal como está — que es lo que hay que saber antes de decidir
 * si hace falta pulsar el botón que instala lo que falte.
 */
async function requirements() {
    return tasks.requirements({
        emvTask: EMV_TASK,
        emvExePath: await emvExePath(null),
        printerRescueTask: PRINTER_RESCUE_TASK,
        printerService: IS_WIN ? resolvePrinterService() : '',
        vigilaEmv: cfg.valores.emv_watch !== 'nunca'
    });
}

/**
 * Instala/repara lo que falte. ABRE UN AVISO DE UAC.
 *
 * Sólo se llama desde el botón del asistente, con una persona delante: nunca desde el
 * daemon. Un UAC apareciendo solo a media venta sería peor que el fallo que viene a
 * arreglar — y además nadie estaría ahí para aceptarlo.
 */
async function installTasks(que) {
    const r = await tasks.installMissing({
        que,
        emvTask: EMV_TASK,
        emvExePath: await emvExePath(null),
        printerRescueTask: PRINTER_RESCUE_TASK,
        printerService: IS_WIN ? resolvePrinterService() : ''
    });

    for (const paso of (r.pasos || [])) {
        log(`[requisitos] ${paso.clave}: ${paso.ok ? 'ok' : 'FALLÓ'} — ${paso.detalle}`);
    }
    if (r.cancelado) log('[requisitos] la instalación se canceló en el aviso de Windows');

    if (r.ok) {
        // Lo que acaba de cambiar es justo lo que hacía imposible el rescate. Si no se
        // limpiara, la caja seguiría dándose por perdida con el motivo de antes y el
        // botón parecería no haber servido de nada.
        for (const st of Object.values(servicios)) {
            st.fatal = false;
            st.fatalMotivo = '';
            st.attempts = 0;
            st.nextAttemptAt = 0;
            st.rescues = [];
            st.reported = false;
        }
        emvExeCache = '';
        emvDirectoNecesitaAdmin = false;
        tick('requisitos instalados').catch(() => { });
    }

    return { ...r, requisitos: await requirements() };
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

    // "nunca" gana sobre el POS. El paquete dice si el NEGOCIO tiene terminal; esto
    // dice si ESTA caja la tiene enchufada, y sólo lo sabe quien está delante. Sin
    // este portillo, una caja sin PIN pad en un negocio que sí factura con tarjeta
    // intentaría lanzar el microservicio en cada arranque, para siempre.
    if (st.id === 'emv' && cfg.valores.emv_watch === 'nunca') {
        return {
            ok: false,
            error: 'la terminal EMV está en "nunca" en la configuración de esta caja',
            service: payloadDe(st)
        };
    }

    const yaEstaba = st.supervised;
    st.supervised = true;

    if (!yaEstaba) {
        log(`[${st.id}] el POS lo puso bajo vigilancia`);
        // Servicio recién adoptado: no arrastrar el historial de una sesión anterior.
        st.strikes = 0;
        st.attempts = 0;
        st.nextAttemptAt = 0;
        st.reported = false;
        st.fatal = false;
        st.fatalMotivo = '';
        st.settleUntil = 0;
        st.settleStep = '';
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
    // Quien pulsa el botón acaba de leer POR QUÉ no se podía rescatar, y lo más probable
    // es que venga de arreglarlo. Volver a darlo por imposible sin ni siquiera intentarlo
    // es lo que hace que un botón parezca roto.
    st.fatal = false;
    st.fatalMotivo = '';
    st.settleUntil = 0;
    st.settleStep = '';
    await tick(`repair:${st.id}`);
    return { ok: st.state === 'ok', service: payloadDe(st) };
}

// ── Candado de servicios del arranque ───────────────────────────────────────────
//
// Lo llama el POS al abrir /pos, EN PARALELO con la descarga del catálogo (que puede
// tardar minutos: el paquete pesa 11-30 MB). Ese rato es gratis, y es exactamente el
// rato que hace falta para levantar un servicio caído sin que nadie lo note.
//
// En qué se diferencia de `ensure()`, que es la pregunta obvia:
//
//   ensure()   comprueba, rescata si hace falta y DEVUELVE lo que haya. El POS abre
//              pase lo que pase. Es lo correcto para la vigilancia continua.
//   bootGate() NO devuelve hasta que el servicio de impresión contesta. Sin espera
//              entre intentos y sin tope por hora: insiste mientras haga falta.
//
// Es deliberadamente más duro, y la razón es que una caja que abre sin impresión no
// está "un poco peor": está emitiendo folios que nadie se lleva en papel, y eso se
// descubre al cobrar el primer ticket, con la fila hecha. Esperar en el arranque
// —donde la espera no le cuesta a nadie— es estrictamente mejor que fallar al cobrar.
//
// Tres salidas, para que "insiste mientras haga falta" no se convierta en una caja
// que no abre nunca:
//
//   1. La caja que no imprime AQUÍ se declara una vez: Configuración → Servicios de la
//      caja → "Vigilancia del servicio de impresión: nunca". Con eso el candado ni se
//      plantea. Es la misma llave que ya gobierna la vigilancia, no una nueva.
//   2. El modo OBSERVACIÓN (rescate apagado) es una decisión explícita de no tocar
//      nada; bloquear ahí la contradiría, así que se avisa y se sigue.
//   3. Nada de esto aplica fuera de Windows.
//
// La cola de impresión de Windows se revisa al final y NO frena: cinco sondeos, y si
// no levanta se devuelve un aviso y la caja abre igual.

// La cola de impresión de Windows. Sólo se ARRANCA, jamás se para: es justo el
// servicio que encabeza SERVICIOS_PROTEGIDOS en services.config.js, y lo que hacía
// daño en aquel incidente era el `sc stop` (una máquina que deja de imprimir del todo),
// no el `sc start`.
const SPOOLER_SERVICE = 'Spooler';
// INTENTOS, no sondeos. La diferencia costó un bug: se lanzaba `sc start` UNA vez y
// luego se sondeaba cinco veces sin volver a intentarlo, así que un arranque perdido
// —recién matado el proceso, el SCM todavía está cerrando el servicio y rechaza la
// petición— dejaba la cola muerta y en pantalla sólo "comprobando 1/5… 5/5".
const SPOOLER_INTENTOS = 5;
// Cuánto se espera, comprobando, a que el servicio esté de verdad en pie tras cada
// intento: `sc start` vuelve cuando el SCM ACEPTA la petición, no cuando arrancó.
const SPOOLER_ESPERA_MS = 6000;
const SPOOLER_PAUSA_MS = 1000;

// Respiro entre vueltas del candado. Crece y se estanca: es tiempo que alguien pasa
// mirando una pantalla, así que las primeras vueltas van rápido, pero martillear `sc`
// cada segundo durante media hora tampoco ayuda a nadie.
const GATE_PAUSAS_MS = [3000, 5000, 10000, 15000];

// Una sola corrida a la vez. El POS puede recargarse a media espera (o haber dos
// ventanas), y dos candados en paralelo se pisarían los rescates: se devuelve el que
// ya está corriendo. Los avisos se difunden a TODAS las ventanas, así que la que
// llegó después ve el progreso igual.
let gateEnCurso = null;

function gatePausa(vuelta) {
    return GATE_PAUSAS_MS[Math.min(vuelta - 1, GATE_PAUSAS_MS.length - 1)];
}

// ── El texto que ve el cajero ───────────────────────────────────────────────────
//
// Lo que el daemon se dice a sí mismo NO sirve para una pantalla de arranque. "nadie
// escucha en 127.0.0.1:8331 (ECONNREFUSED)" es exactamente el dato que hace falta en la
// bitácora —distingue "caído" de "arriba pero colgado", que es la mitad de la razón de
// existir de este archivo— y exactamente el dato que no significa nada para quien está
// esperando para abrir la caja.
//
// Así que el splash NO recibe `detail` ni `lastError`. Las frases se arman aquí, desde
// el estado, sin puertos, sin IPs, sin rutas, sin códigos de error y sin nombres de
// servicios de Windows. Lo técnico sigue entero en el log y en `payloadDe` (de donde
// beben la barra de estado y el modal de diagnóstico), que es donde se va a buscar.
// El nombre lleva su género porque las frases lo usan: "la terminal … Iniciándola",
// "el servicio … Iniciándolo". Un genérico para los dos sale mal en uno de ellos.
const NOMBRE_SENCILLO = {
    printer: { nombre: 'el servicio de impresión', iniciando: 'Iniciándolo' },
    emv: { nombre: 'la terminal de tarjetas', iniciando: 'Iniciándola' }
};
const SERVICIO_GENERICO = { nombre: 'un servicio de la caja', iniciando: 'Iniciándolo' };

/** Cómo se llama este servicio delante de una persona. */
function nombreSencillo(st) {
    return (NOMBRE_SENCILLO[st.id] || SERVICIO_GENERICO).nombre;
}

/** Primera mayúscula, para cuando la frase empieza por el nombre. */
function capitalizar(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * La frase del splash mientras se espera a un servicio.
 *
 * `intentos` es cuántas veces se ha intentado levantarlo ya (0 = todavía ninguna).
 */
function fraseDeEspera(st, intentos) {
    const voz = NOMBRE_SENCILLO[st.id] || SERVICIO_GENERICO;
    const nombre = voz.nombre;

    if (intentos === 0) {
        return `${capitalizar(nombre)} no responde. ${voz.iniciando}…`;
    }

    let frase = `${capitalizar(nombre)} sigue sin responder. Reintentando… (intento ${intentos})`;

    // A partir del tercero se dice CÓMO SALIR. Si el rescate no prende tres veces
    // seguidas casi nunca es mala suerte: o el componente no está instalado en esta
    // caja, o esta caja no imprime aquí. Ninguna de las dos se arregla esperando, y
    // quien está delante no tiene por qué adivinarlo.
    if (intentos >= 3 && st.id === 'printer') {
        frase += '. Si esta caja no imprime, puedes desactivarlo en Configuración → '
            + 'Servicios de la caja.';
    }
    return frase;
}

/**
 * Un aviso del daemon, dicho para una persona.
 *
 * Los `warn` de las sondas están escritos para diagnosticar —nombran el .dll, el estado
 * de la terminal— y acaban en un toast del POS que lee un cajero. Se traducen los casos
 * conocidos y el resto pasa tal cual: inventar una frase genérica para un aviso que no
 * se conoce sería cambiar información por nada.
 */
function avisoParaPersonas(warn) {
    const t = String(warn || '');
    if (!t) return '';
    if (/dll_loaded|nestor_printer\.dll/i.test(t)) {
        return 'El servicio de impresión está en pie pero no puede imprimir. '
            + 'Suele ser el antivirus: revisa Configuración → Servicios de la caja.';
    }
    return t;
}

/**
 * Espera a que un servicio conteste, rescatándolo tantas veces como haga falta.
 *
 * Se apoya en `tick()` para el rescate en vez de llamar a RESCATES[] directo, y eso es
 * a propósito: tick está serializado con la ronda periódica (dos rescates a la vez
 * sobre el EMV matarían el proceso que acaba de nacer), respeta las compuertas de
 * trabajo en vuelo y conoce las vías de rescate de cada servicio —que no son una sola:
 * el EMV puede ir por la tarea programada O por el ejecutable directo (ver rescueEmv).
 * Duplicar esa decisión aquí era quedarse desfasado a la primera.
 *
 * Lo que este bucle SÍ hace es quitarle a `tick` lo que le haría rendirse antes de
 * tiempo —la espera entre intentos y el tope por hora— y respetar dos cosas que el
 * daemon lleva por su cuenta:
 *
 *   settleUntil  el servicio se acaba de lanzar y todavía está arrancando. La ronda ya
 *                NO bloquea durante ese margen (bloquear el daemon un minuto dejaba al
 *                printer sin sondear), así que `tick` vuelve enseguida. Contar eso como
 *                "sigue caído" y pedir otro rescate mataría el proceso recién nacido:
 *                aquí se espera y se dice que está arrancando.
 *   fatal        no hay NINGUNA vía de rescate en esta caja (falta la tarea y falta el
 *                ejecutable). Es pegajoso a propósito. Ver `rendirseSiFatal`.
 */
async function esperarServicioDelArranque(st, aviso, opciones) {
    // `rendirseSiFatal` es lo que separa a los dos servicios que pasan por aquí.
    //
    // El printer NO se rinde: así se pidió, y tiene salida declarable ("vigilancia:
    // nunca"). El EMV sí, porque su fallo estructural —ni tarea programada ni
    // ejecutable— no se arregla esperando, y el rescate ya sabe decir con precisión
    // qué falta y a qué paso del asistente ir. Quedarse atorado ahí sería tener a
    // alguien mirando una caja que no puede abrir por un componente que no está.
    const rendirseSiFatal = !!(opciones && opciones.rendirseSiFatal);
    const t0 = Date.now();
    // Intentos de RESCATE. Aparte de las vueltas del bucle: mientras el servicio está
    // arrancando se dan vueltas que no son intentos, y contarlas diría "intento 12"
    // cuando sólo se ha lanzado una vez.
    let intentos = 0;

    // Bajo vigilancia desde YA, aunque conteste a la primera. Si sólo se marcara en la
    // rama del rescate, una terminal EMV que estaba en pie saldría del candado sin
    // vigilar: el candado la habría dado por buena y la ronda periódica ni la miraría.
    // (Es lo mismo que hace ensure(); aquí ya se comprobó el "nunca" de la
    // configuración antes de llamar.)
    st.supervised = true;

    for (;;) {
        let sonda;
        try {
            sonda = await SONDAS[st.id]();
        } catch (e) {
            sonda = { alive: false, error: e && e.message ? e.message : String(e), warn: '', info: null };
        }

        if (sonda.alive) {
            // Esta sonda vale como ronda: dejar el estado coherente evita que el
            // indicador de la barra siga enseñando "SIN SERVICIO" un rato después de
            // que el candado lo dio por bueno.
            st.state = 'ok';
            st.warn = sonda.warn || '';
            if (sonda.info) st.info = sonda.info;
            st.detail = st.warn || 'atendiendo';
            st.strikes = 0;
            st.lastOkAt = Date.now();
            st.lastError = '';
            st.attempts = 0;
            st.nextAttemptAt = 0;
            st.reported = false;
            broadcast();

            const ms = Date.now() - t0;
            const detalle = intentos === 0
                ? 'ya estaba atendiendo'
                : `restablecido tras ${intentos} intento(s) en ${Math.round(ms / 1000)} s`;
            log(`[${st.id}] candado de arranque: ${detalle}`);
            return { ok: true, intentos, ms, warn: sonda.warn || '', detalle };
        }

        // ── Está arrancando: esperar, no volver a lanzarlo ───────────────────────
        //
        // El EMV tarda de verdad (login contra el host de Santander y detección del
        // puerto COM). Pedir otro rescate dentro de su margen mata el proceso que
        // acaba de nacer — que es justo lo que este candado existe para evitar.
        const quedan = st.settleUntil - Date.now();
        if (quedan > 0) {
            // El paso técnico (`settleStep` = "schtasks /Run …") va al log, no aquí.
            aviso(`${capitalizar(nombreSencillo(st))} está iniciando… ${Math.ceil(quedan / 1000)} s`);
            await sleep(Math.min(2000, quedan));
            continue;
        }

        // ── No hay vía de rescate en esta caja ───────────────────────────────────
        if (st.fatal && rendirseSiFatal) {
            const motivo = st.fatalMotivo || st.detail || 'el rescate no es posible en esta caja';
            log(`[${st.id}] candado de arranque: no hay forma de levantarlo aquí — ${motivo}`);
            return {
                ok: false,
                intentos,
                ms: Date.now() - t0,
                // El aviso que va a leer el cajero dice qué pasa y a dónde ir; el motivo
                // exacto (qué tarea falta, en qué ruta se buscó el ejecutable) lo enseña
                // ese mismo paso del asistente, y ya está en la bitácora.
                warn: `No se pudo iniciar ${nombreSencillo(st)} en esta caja. `
                    + 'Revísalo en Configuración → Servicios de la caja → Requisitos.',
                detalle: motivo
            };
        }

        intentos++;
        aviso(fraseDeEspera(st, intentos - 1));

        // Lo que le haría rendirse, fuera. Un `repair()` pedido a mano hace lo mismo;
        // aquí además se repite, porque nadie va a volver a pulsar el botón. `fatal` se
        // limpia también: es pegajoso a propósito para que la barra del POS no alterne
        // entre "rendido" y "rescatando", pero este candado no se rinde con el printer
        // —y si alguien fue a instalar el componente mientras esperaba, el siguiente
        // intento tiene que verlo.
        st.rescues = [];
        st.attempts = 0;
        st.nextAttemptAt = 0;
        st.strikes = STRIKES;
        st.fatal = false;
        st.fatalMotivo = '';
        // `reported` NO se toca, y es la diferencia con repair(). Ahí lo limpia una
        // persona que acaba de actuar, así que un fallo posterior merece incidencia
        // nueva. Aquí el bucle no se rinde: limpiarlo en cada vuelta subiría una
        // incidencia cada pocos segundos mientras dure la espera. Una caída, una
        // incidencia.

        await tick(`arranque:${st.id}`);

        if (st.state === 'ok') {
            const ms = Date.now() - t0;
            log(`[${st.id}] candado de arranque: restablecido en ${Math.round(ms / 1000)} s`);
            return {
                ok: true,
                intentos,
                ms,
                warn: st.warn || '',
                detalle: `restablecido tras ${intentos} intento(s) en ${Math.round(ms / 1000)} s`
            };
        }

        // Se acaba de lanzar y quedó arrancando: se vuelve arriba SIN pausa, porque la
        // rama del margen ya cuenta los segundos en pantalla.
        if (st.settleUntil > Date.now()) continue;

        // El intento no prendió. El porqué exacto ya quedó en el log y en `st.detail`
        // (que es lo que leen la barra de estado y el diagnóstico); aquí va la frase.
        log(`[${st.id}] candado de arranque: el intento ${intentos} no prendió — `
            + `${st.detail || st.lastError || 'no responde'}`);
        aviso(fraseDeEspera(st, intentos));

        await sleep(gatePausa(intentos));
    }
}

/**
 * La cola de impresión de Windows (Spooler) tiene que estar corriendo.
 *
 * No se rescata como los nuestros: sólo se ARRANCA —nunca `sc stop`, ver
 * SERVICIOS_PROTEGIDOS— y se comprueba cinco veces. Si no levanta se devuelve un aviso
 * y la caja abre igual: sin el Spooler no imprime la impresora de Windows, pero el
 * ticket por ESC/POS a puerto puede seguir saliendo, así que frenar el arranque aquí
 * sería peor que el problema.
 */
async function asegurarColaDeWindows(aviso) {
    if (!IS_WIN) return { ok: true, detalle: 'no es Windows' };

    const inicial = await serviceState(SPOOLER_SERVICE);
    if (inicial.state === 'running') {
        return { ok: true, detalle: 'ya estaba corriendo' };
    }
    if (inicial.state === 'ausente') {
        return {
            ok: false,
            detalle: 'el servicio no existe en esta máquina',
            warn: 'La cola de impresión de Windows (Spooler) no existe en esta máquina. '
                + 'Las impresoras instaladas en Windows no van a imprimir.'
        };
    }

    log(`[spooler] la cola de impresión de Windows dice "${inicial.state}"; se intenta arrancar`);

    let ultimo = { code: -1, salida: '' };
    let rehabilitada = false;

    for (let i = 1; i <= SPOOLER_INTENTOS; i++) {
        aviso(i === 1
            ? 'Iniciando la cola de impresión de Windows…'
            : `Iniciando la cola de impresión de Windows… (intento ${i} de ${SPOOLER_INTENTOS})`);

        const r = await run(sysExe('sc.exe'), ['start', SPOOLER_SERVICE], 30000);
        const salida = `${r.stdout}${r.stderr}`.trim();
        ultimo = { code: r.code, salida: salida.slice(0, 200) };

        // 5 = ERROR_ACCESS_DENIED. Es determinista: insistir cuatro veces más no va a
        // conceder un permiso que no se tiene, sólo alarga el arranque de la caja.
        if (r.code === 5 || /denegado|denied|0x80070005/i.test(salida)) {
            log(`[spooler] sin permiso para arrancarlo (${r.code}): ${ultimo.salida}`);
            break;
        }

        // 1058 = ERROR_SERVICE_DISABLED. Arrancar un servicio deshabilitado no falla por
        // mala suerte: falla siempre. Se intenta rehabilitarlo UNA vez —también puede no
        // haber permiso— y se vuelve a probar en la siguiente vuelta.
        if (r.code === 1058 && !rehabilitada) {
            rehabilitada = true;
            log('[spooler] está DESHABILITADO; se intenta ponerlo en arranque automático');
            aviso('La cola de impresión de Windows está deshabilitada. Habilitándola…');
            const c = await run(sysExe('sc.exe'), ['config', SPOOLER_SERVICE, 'start=', 'auto'], 20000);
            if (c.code !== 0) {
                log(`[spooler] no se pudo rehabilitar (${c.code}): ${`${c.stdout}${c.stderr}`.trim().slice(0, 200)}`);
                break;
            }
            continue;
        }

        if (r.code !== 0 && r.code !== 1056) {
            // 1056 = ERROR_SERVICE_ALREADY_RUNNING (alguien se adelantó: es un éxito).
            // El resto suele ser transitorio y es la razón de que esto sea un bucle de
            // INTENTOS y no de sondeos: recién matado el proceso, el SCM todavía está
            // cerrando el servicio y devuelve 1053/1061 ("no acepta mensajes de control").
            // Un único `sc start` en ese instante se pierde, y antes el bucle sólo MIRABA
            // — la cola no revivía y en pantalla sólo se veía "comprobando 1/5… 5/5".
            log(`[spooler] "sc start" falló (${r.code}): ${ultimo.salida}`);
        }

        // Y ahora sí: esperar unos segundos a que arranque de verdad. `sc start` vuelve
        // en cuanto el SCM acepta la petición, no cuando el servicio está en pie.
        aviso(`Comprobando la cola de impresión de Windows… (${i} de ${SPOOLER_INTENTOS})`);
        const limite = Date.now() + SPOOLER_ESPERA_MS;
        while (Date.now() < limite) {
            await sleep(SPOOLER_PAUSA_MS);
            const e = await serviceState(SPOOLER_SERVICE);
            if (e.state === 'running') {
                log(`[spooler] corriendo (confirmado en el intento ${i}/${SPOOLER_INTENTOS})`);
                return { ok: true, detalle: `arrancada en el intento ${i}/${SPOOLER_INTENTOS}` };
            }
        }
    }

    const final = await serviceState(SPOOLER_SERVICE);
    // Una última mirada antes de dar el aviso: pudo levantar entre la última
    // comprobación y ahora (el SCM tiene además su propia recuperación automática).
    if (final.state === 'running') {
        log('[spooler] corriendo (levantó justo al final)');
        return { ok: true, detalle: 'arrancada' };
    }

    const porPermiso = final.state === 'sin-permiso' || ultimo.code === 5
        || /denegado|denied|0x80070005/i.test(ultimo.salida);
    // Sólo por el código de `sc start`: `sc query` NO distingue deshabilitado de
    // detenido (un servicio deshabilitado también reporta STOPPED).
    const deshabilitada = ultimo.code === 1058;

    // Estos textos los lee el cajero en un aviso del POS, así que dicen QUÉ pasa y QUÉ
    // hacer — sin códigos de error ni nombres de servicio de Windows. El detalle técnico
    // queda arriba, en la bitácora.
    const warn = porPermiso
        // Este es el caso REAL en las cajas, no una rareza: por defecto, un usuario que
        // no es administrador no puede arrancar el Spooler, así que el rescate se
        // estrella contra un "acceso denegado" y la caja se queda sin imprimir por
        // Windows. Tiene arreglo, y de una vez para siempre: el paso «Requisitos» del
        // asistente concede el permiso con UN aviso de administrador. Por eso el aviso
        // manda ahí en vez de pedir que alguien arranque el servicio a mano cada vez.
        ? 'La cola de impresión de Windows está detenida y esta caja no tiene permiso para iniciarla. '
        + 'Entra en Configuración → Servicios de la caja → Requisitos y pulsa «Revisar e instalar» '
        + 'para concedérselo; mientras tanto, las impresoras de Windows no van a imprimir.'
        : deshabilitada
            ? 'La cola de impresión de Windows está deshabilitada y no se pudo habilitar desde aquí. '
            + 'Hay que habilitarla como administrador: las impresoras de Windows no van a imprimir.'
            : 'No se pudo iniciar la cola de impresión de Windows. '
            + 'Las impresoras de Windows no van a imprimir hasta que alguien la inicie.';
    log(`[spooler] AVISO tras ${SPOOLER_INTENTOS} intento(s): ${warn} `
        + `[último sc start: código ${ultimo.code} ${ultimo.salida}] [estado: ${final.state}]`);
    return { ok: false, detalle: `no arrancó (${final.state})`, warn };
}

// ── Estado de la impresora asignada ─────────────────────────────────────────────
//
// El servicio de impresión puede estar perfecto y la caja no imprimir igual, porque el
// problema está un escalón más allá: la impresora sin papel, con la tapa abierta, con
// papel atascado o marcada "sin conexión" en Windows. Eso no lo ve ninguna de las
// sondas de este archivo —el puerto contesta, /health contesta— y el cajero se entera
// al cobrar el primer ticket.
//
// En Windows toda impresión no virtual de NestorPOS_Printer termina en la cola de
// Windows que nombra `printer_uri` (ver models/printer.go → SendRawToPrinter y
// printPagesGDI), así que preguntarle a esa cola es preguntar por la impresora que de
// verdad se va a usar.
//
// Esto NO frena el arranque: es un aviso. Una impresora sin papel se arregla en diez
// segundos y no hay ninguna razón para impedir abrir la caja mientras tanto.
const IMPRESORA_TIMEOUT_MS = 20000;

// Win32_Printer.DetectedErrorState. Lo que importa es la FRASE, no el número: esto lo
// lee un cajero. Los estados que no son un problema (2 = sin error) no están aquí.
const ERROR_IMPRESORA = {
    3: 'tiene poco papel',
    4: 'no tiene papel',
    5: 'tiene poco tóner',
    6: 'no tiene tóner',
    7: 'tiene la tapa abierta',
    8: 'tiene papel atascado',
    9: 'necesita servicio',
    10: 'tiene la bandeja de salida llena',
    11: 'tiene un problema con el papel',
    12: 'no puede imprimir la página',
    13: 'necesita que alguien la revise',
    14: 'se quedó sin memoria'
};

// Win32_Printer.PrinterStatus
const PRINTER_STATUS_DETENIDA = 6;
const PRINTER_STATUS_SIN_CONEXION = 7;

/** Lo que se le sugiere hacer a quien está delante de la caja. */
const CONSEJO_IMPRESORA = 'Reinicia la impresora: desconecta el cable de corriente, '
    + 'espera unos segundos, vuelve a conectarla y comprueba que tenga papel.';

/**
 * ¿Esta caja tiene una impresora de verdad asignada, con cola de Windows?
 *
 * `printer` es el objeto que el POS recibe en el paquete. Virtual (o sin nombre de
 * cola) significa que no hay nada que preguntarle a Windows.
 */
function colaDeWindowsDe(printer) {
    if (!printer || typeof printer !== 'object') return '';
    // PRINTER_TYPE_VIRTUAL = 0 (ver models/db.printer.go en el backend).
    if (Number(printer.printer_type) === 0) return '';

    // La caja puede imprimir por el :8331 de OTRA máquina (`printer_host`). Entonces la
    // cola vive allá, y mirar las impresoras de ESTA máquina sería preguntar por el
    // equipo equivocado. Pero "otra máquina" NO es "distinto de 127.0.0.1": lo normal en
    // estas cajas es que se nombren a sí mismas por su IP de la red local
    // (printer_host "192.168.10.118" apuntando a su propio equipo), y darlas por remotas
    // dejaba la comprobación apagada justo donde había impresora que comprobar.
    if (!esEsteEquipo(printer.printer_host)) return '';

    return String(printer.printer_uri || '').trim();
}

/**
 * ¿Esta dirección es ESTE equipo?
 *
 * Vacío cuenta como sí: es lo que asume el propio POS al imprimir
 * (`printer.printer_host || '127.0.0.1'`, ver print.dispatcher.js), y aquí tiene que
 * significar lo mismo o las dos piezas discreparían sobre a qué máquina le hablan.
 */
function esEsteEquipo(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    if (/^127\./.test(h)) return true;

    // El nombre de la máquina, con o sin dominio ("CAJA4" y "caja4.tienda.local").
    const yo = String(os.hostname() || '').trim().toLowerCase();
    if (yo && (h === yo || h === yo.split('.')[0] || h.split('.')[0] === yo.split('.')[0])) return true;

    // Y cualquiera de sus direcciones. Es el caso real de las cajas: se configuran con
    // su propia IP de la LAN en vez de con el bucle local.
    try {
        for (const lista of Object.values(os.networkInterfaces() || {})) {
            for (const ni of lista || []) {
                if (String(ni.address || '').trim().toLowerCase() === h) return true;
            }
        }
    } catch (e) { /* sin interfaces que mirar: se decide por lo de arriba */ }

    return false;
}

/**
 * Estado de la cola de Windows de la impresora asignada.
 *
 * Se pregunta por WMI y se filtran los resultados AQUÍ, por nombre, en vez de mandar un
 * filtro dentro del comando: el nombre de una impresora lo teclea una persona en la
 * configuración y puede llevar comillas, acentos o una barra invertida. Armar una
 * consulta con eso dentro es pedir que un día no case nada — o algo peor.
 */
async function comprobarImpresoraDeWindows(cola, aviso) {
    if (!IS_WIN) return { ok: true, detalle: 'no es Windows' };
    if (!cola) return { ok: true, detalle: 'esta caja no tiene impresora de Windows asignada' };

    aviso('Comprobando el estado de la impresora…');

    const ps = sysExe(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
    // Get-CimInstance no existe en las cajas más viejas; Get-WmiObject sigue estando en
    // todas las que traen Windows PowerShell. Se intenta el moderno y se cae al otro.
    const guion = '$ErrorActionPreference="SilentlyContinue";'
        + '$p = Get-CimInstance Win32_Printer; if(-not $p){$p = Get-WmiObject Win32_Printer};'
        + '$p | Select-Object Name,PrinterStatus,DetectedErrorState,WorkOffline | ConvertTo-Json -Compress';
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', guion], IMPRESORA_TIMEOUT_MS);

    let filas = [];
    try {
        const parsed = JSON.parse((r.stdout || '').trim() || 'null');
        // ConvertTo-Json devuelve un OBJETO cuando sólo hay una impresora, no un array
        // de uno. Con una sola impresora instalada —que es el caso de casi toda caja—
        // esto se traga el resultado entero si no se contempla.
        filas = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch (e) {
        filas = [];
    }

    if (!filas.length) {
        // Sin lista no se afirma nada: "no se pudo comprobar" es la verdad, y es muy
        // distinto de "la impresora está mal". Un aviso falso en cada arranque enseña
        // a ignorar los avisos.
        log(`[impresora] no se pudo consultar el estado (código ${r.code}): `
            + `${`${r.stdout}${r.stderr}`.trim().slice(0, 200)}`);
        return { ok: true, detalle: 'no se pudo consultar el estado de la impresora' };
    }

    const norm = (s) => String(s || '').trim().toLowerCase();
    const fila = filas.find((f) => norm(f.Name) === norm(cola));
    if (!fila) {
        log(`[impresora] la impresora asignada "${cola}" no está instalada en esta máquina `
            + `(hay: ${filas.map((f) => f.Name).join(', ').slice(0, 200)})`);
        return {
            ok: false,
            detalle: 'la impresora asignada no está instalada en Windows',
            warn: `La impresora configurada para esta caja ("${cola}") no está instalada en Windows. `
                + 'Revísala en el panel de impresoras o avisa a soporte.'
        };
    }

    const estado = Number(fila.PrinterStatus);
    const error = Number(fila.DetectedErrorState);
    const sinConexion = fila.WorkOffline === true || estado === PRINTER_STATUS_SIN_CONEXION;
    const motivo = ERROR_IMPRESORA[error];

    if (motivo) {
        log(`[impresora] "${cola}" ${motivo} (DetectedErrorState=${error} PrinterStatus=${estado})`);
        return {
            ok: false,
            detalle: motivo,
            warn: `La impresora ${motivo}. ${CONSEJO_IMPRESORA}`
        };
    }
    if (sinConexion) {
        log(`[impresora] "${cola}" está sin conexión (WorkOffline=${fila.WorkOffline} PrinterStatus=${estado})`);
        return {
            ok: false,
            detalle: 'sin conexión',
            warn: `La impresora aparece como desconectada en Windows. ${CONSEJO_IMPRESORA}`
        };
    }
    if (estado === PRINTER_STATUS_DETENIDA) {
        log(`[impresora] "${cola}" está detenida (PrinterStatus=${estado})`);
        return {
            ok: false,
            detalle: 'detenida',
            warn: `La impresora está detenida en Windows. ${CONSEJO_IMPRESORA}`
        };
    }

    log(`[impresora] "${cola}" lista (PrinterStatus=${estado} DetectedErrorState=${error})`);
    return { ok: true, detalle: 'lista' };
}

/**
 * Comprobación de servicios del arranque de la caja. Ver el bloque de arriba.
 *
 * `opciones.emv`    ¿esta caja tiene terminal Santander? (lo dice /pos/package)
 * `opciones.onPaso` se llama con { fase, texto } en cada cambio; lo difunde main.js.
 *
 * Nunca lanza: como todo lo de este archivo, un fallo suyo no puede impedir abrir la
 * caja. Devuelve siempre un objeto con lo que pasó en cada servicio.
 */
async function bootGate(opciones) {
    if (gateEnCurso) return gateEnCurso;

    const opts = opciones || {};
    const onPaso = typeof opts.onPaso === 'function' ? opts.onPaso : null;
    let fase = 'printer';
    const aviso = (texto) => {
        if (!onPaso) return;
        try { onPaso({ fase, texto }); } catch { }
    };

    gateEnCurso = (async () => {
        const salida = {
            ok: true,
            warn: '',
            warns: [],
            printer: { ok: true, detalle: '' },
            emv: null,
            spooler: null,
            impresora: null
        };
        // Todo lo que hay que decirle a una persona, en orden de urgencia. Se reparte al
        // final: `warn` (el aviso del POS) y `warns` (la bitácora).
        const avisos = [];

        if (!IS_WIN) {
            salida.printer.detalle = 'no es Windows: no hay servicios que levantar';
            return salida;
        }
        if (!ENABLED || initError) {
            salida.printer.detalle = 'el daemon de servicios está apagado';
            return salida;
        }
        if (!RESCUE_ENABLED) {
            // Modo observación: alguien decidió que en esta caja no se toca nada. El
            // candado lo respeta — bloquear aquí sería desobedecer justo el ajuste que
            // existe para pilotear el rescate sin riesgo.
            salida.printer.detalle = 'modo observación: se comprueba pero no se rescata';
            salida.warn = 'Los servicios de esta caja están en modo observación: no se van a levantar solos.';
            salida.warns = [salida.warn];
            return salida;
        }

        // ── 1) Servicio de impresión ────────────────────────────────────────────
        if (cfg.valores.printer_watch === 'nunca') {
            salida.printer.detalle = 'vigilancia en "nunca": esta caja no imprime aquí';
        } else {
            log('[arranque] candado de servicios: servicio de impresión');
            salida.printer = await esperarServicioDelArranque(servicios.printer, aviso);
            if (salida.printer.warn) {
                // Contesta, pero avisando (el caso real: la DLL no cargó). No frena —el
                // servicio está en pie— pero tiene que llegar a una persona, y a esa
                // persona el nombre del .dll no le dice nada.
                avisos.push(avisoParaPersonas(salida.printer.warn));
            }
        }

        // ── 2) Terminal EMV, DESPUÉS de la impresión ────────────────────────────
        //
        // Sólo si el daemon la tiene configurada. "auto" es lo de fábrica y significa
        // "la enciende el POS cuando el paquete dice que esta caja tiene terminal", así
        // que ahí manda lo que diga el POS.
        fase = 'emv';
        const emvWatch = cfg.valores.emv_watch;
        const emvPedido = emvWatch === 'siempre' || (emvWatch !== 'nunca' && opts.emv === true);
        if (!emvPedido) {
            salida.emv = { ok: true, detalle: emvWatch === 'nunca' ? 'vigilancia en "nunca"' : 'esta caja no tiene terminal' };
        } else {
            log('[arranque] candado de servicios: terminal EMV');
            // `rendirseSiFatal`: si NO hay con qué levantarlo —ni tarea programada ni
            // ejecutable— esperar es esperar algo que no puede pasar. Quién decide eso
            // es rescueEmv, no este candado: las vías de arranque del EMV son dos y
            // están ahí; comprobar aquí "¿existe la tarea?" por separado dejaba fuera a
            // la caja que arranca por ejecutable directo (emv_direct_launch), y volvería
            // a quedarse desfasado en cuanto aparezca una tercera vía.
            salida.emv = await esperarServicioDelArranque(servicios.emv, aviso, { rendirseSiFatal: true });
            if (salida.emv.warn) avisos.push(avisoParaPersonas(salida.emv.warn));
        }

        // ── 3) Cola de impresión de Windows: avisa, no frena ────────────────────
        fase = 'spooler';
        salida.spooler = await asegurarColaDeWindows(aviso);
        if (!salida.spooler.ok && salida.spooler.warn) avisos.push(salida.spooler.warn);

        // ── 4) La impresora en sí ───────────────────────────────────────────────
        //
        // Va LA ÚLTIMA, y no por importancia: Win32_Printer lo sirve la cola de
        // impresión de Windows. Preguntarlo antes de asegurarla daría "no se pudo
        // consultar" justo en las cajas donde hay algo que contar.
        fase = 'impresora';
        salida.impresora = await comprobarImpresoraDeWindows(colaDeWindowsDe(opts.printer), aviso);
        // Este aviso va DELANTE del de la cola de Windows aunque se descubra después:
        // "la impresora no tiene papel" lo resuelve quien está en la caja, ahora, y sin
        // ayuda de nadie. Es lo primero que tiene que leer.
        if (!salida.impresora.ok && salida.impresora.warn) avisos.unshift(salida.impresora.warn);

        // `warn` es lo que sale en el aviso del POS: uno solo, el más accionable.
        // `warns` lleva todos, y de ahí los copia la bitácora del POS — dos problemas a
        // la vez son raros, pero perder el segundo en silencio no es aceptable.
        salida.warns = avisos;
        salida.warn = avisos[0] || '';

        fase = 'listo';
        aviso('Servicios de la caja listos');
        return salida;
    })()
        .catch((e) => ({
            ok: false,
            error: e && e.message ? e.message : String(e),
            warn: '',
            warns: [],
            printer: { ok: false, detalle: 'el candado falló' },
            emv: null,
            spooler: null,
            impresora: null
        }))
        .finally(() => { gateEnCurso = null; });

    return gateEnCurso;
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
function servicioDeUrl(url) {
    const u = String(url || '');

    let pathname = u;
    let puerto = '';
    try {
        const parsed = new URL(u);
        pathname = parsed.pathname;
        puerto = parsed.port;
    } catch { /* una URL rara cae al camino de abajo con el texto entero */ }

    if (esLatido(pathname)) return null;

    // Por el puerto CONFIGURADO, no por uno quemado: si esta caja corre su printer en
    // otro puerto (una instancia adicional), buscar ":8331" no encontraría nunca su
    // tráfico, la compuerta de silencio quedaría siempre abierta y el daemon podría
    // reiniciar el servicio a media impresión o a media venta con tarjeta.
    //
    // Y por el puerto de la URL parseada, no por `includes`: ":5000" aparece también
    // en el cuerpo de un query string, y eso contaría como uso de la terminal.
    if (puerto) {
        if (Number(puerto) === Number(PUERTOS.printer)) return servicios.printer;
        if (Number(puerto) === Number(PUERTOS.emv)) return servicios.emv;
        return null;
    }

    if (u.includes(`:${PUERTOS.printer}`)) return servicios.printer;
    if (u.includes(`:${PUERTOS.emv}`)) return servicios.emv;
    return null;
}

/** Empieza una petición hacia uno de los microservicios. */
function noteTraffic(url, id) {
    const st = servicioDeUrl(url);
    if (!st) return;
    st.enVuelo.set(id === undefined ? `sin-id:${Date.now()}:${Math.random()}` : id, Date.now());
}

/**
 * Termina una petición. `ok` es lo que lo cambia todo.
 *
 * - Terminó bien  → ESO es uso: abre la ventana de silencio que protege al servicio.
 * - Terminó mal   → es evidencia de que está caído, vista por quien lo estaba usando.
 *   No protege nada; al contrario, adelanta el rescate (ver `lastFailAt` en ronda()).
 *
 * Antes se anotaba el uso al SALIR la petición, sin mirar el final: con el servicio
 * caído, cada intento del cajero contaba como "se está usando" y empujaba la espera
 * otros 90 segundos. Cuanto más intentaba imprimir, más tardaba el rescate.
 */
function noteTrafficDone(url, id, ok, error) {
    const st = servicioDeUrl(url);
    if (!st) return;

    if (id !== undefined) st.enVuelo.delete(id);
    else st.enVuelo.clear();

    const ahora = Date.now();
    if (ok) {
        st.lastTrafficAt = ahora;
        return;
    }

    // Falló, pero no toda petición fallida delata al servicio: un ERR_ABORTED es la
    // ventana cancelando (una recarga, un diálogo que se cierra). Quien llama decide, y
    // manda `error` sólo cuando es un fallo de conexión de verdad. Sin `error` esto se
    // queda en soltar la petición: ni protege ni acusa.
    if (!error) return;

    st.lastFailAt = ahora;
    st.lastFailError = String(error);

    // Que lo compruebe YA. El cajero acaba de pulsar imprimir y no ha pasado nada: no
    // tiene sentido esperar a la siguiente ronda para empezar a enterarse.
    if (ENABLED && !initError) tick('petición fallida').catch(() => { });
}

function init(userDataDir, options) {
    const opts = options || {};
    onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    report = typeof opts.report === 'function' ? opts.report : null;

    // El directorio va PRIMERO: la configuración vive junto a la bitácora, así que
    // hasta no saber dónde escribe esta caja no se sabe si el daemon está encendido.
    // Decidirlo antes (con el `cfg` de sólo-entorno que se armó al cargar el módulo)
    // haría que apagarlo desde el asistente no surtiera efecto tras reiniciar, que es
    // exactamente cuando tiene que surtir.
    dir = resolveDir(userDataDir);
    if (!dir) initError = 'no se encontró un directorio donde escribir la bitácora';
    abrirLog();

    cfg = configStore.resolve(dir);
    aplicaConfigValores();
    aplicaVigilancia();
    if (cfg.error) log(`la configuración no se pudo leer (${cfg.error}); se corre con los valores de fábrica`);
    for (const v of cfg.vetados || []) {
        log(`AVISO: se ignora ${v.clave}="${v.valor}" guardado en esta caja — ${v.motivo}`);
    }

    if (!ENABLED) {
        log(`daemon apagado por configuración (${cfg.fuentes.enabled})`);
        console.log('[servicios] daemon apagado');
        return status();
    }

    log(`daemon de servicios iniciado — modo ${status().mode}, ronda cada ${WATCH_MS / 1000} s`);
    log(`configuración: ${cfg.archivo || '(sin archivo, valores de fábrica)'}`);
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
    config,
    configure,
    resetConfig,
    discover,
    probeTarget,
    // Qué versión corre cada componente de esta caja. Lo pide la pantalla de acceso
    // del POS; se cachea diez minutos porque una de las vías entra al hardware.
    versiones,
    // Qué le falta a esta caja para poder rescatarse sola, y el botón que lo instala.
    // Ver services.tasks.js: la mitad de lo que docs/daemon-servicios.md daba por hecho
    // que hacía el instalador nunca se escribió, y las cajas ya instaladas no se
    // reinstalan.
    requirements,
    installTasks,
    // Expuestas para scripts/check-services-watchdog.js: son las dos decisiones que
    // impidieron el incidente del Spooler, y las dos son puras.
    pareceServicioNuestro,
    puedeReiniciarServicio,
    ensure,
    release,
    repair,
    // Candado del arranque de la caja: no devuelve hasta que la impresión contesta.
    // Lo llama el POS en paralelo con la descarga del catálogo.
    bootGate,
    hold,
    unhold,
    noteTraffic,
    noteTrafficDone,
    // Los puertos vigentes. Los necesita main.js para filtrar las peticiones que
    // observa: si el filtro se quedara con los de fábrica, la compuerta de trabajo en
    // vuelo no vería nada en una caja con puertos propios.
    puertos: () => ({ ...PUERTOS }),
    directory: () => dir
};
