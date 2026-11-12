// src/main.health.js
//
// ¿SE TRABÓ EL PROCESO PRINCIPAL? — y si sí, cuánto y haciendo qué.
//
// Por qué existe
// --------------
// Caso real (12/nov/2026, CAJA03, licencia 8286806020). En cada cobro con tarjeta la caja
// se quedaba congelada entre 12 y 26 s: los `draft`, `ticket-journal` y `audit` se vencían
// (8 y 10 s), el `print-raw` hacia el servicio de impresión esperaba 17 s, y luego TODO
// respondía en el mismo milisegundo (16:02:20.87–20.98). Durante esa traba el sondeo del
// vigilante (`/__client/ping`, 2.5 s) se vencía, el cliente daba al servidor local por
// muerto, lo reiniciaba y le cortaba a la ventana el `register-ticket` en vuelo
// (ERR_EMPTY_RESPONSE) con el aviso «Esta caja perdió su servidor local» encima.
//
// Lo que no se pudo saber es QUÉ trababa: el proceso principal no dejaba nada en disco
// (sus console.log no van a ningún lado en una caja Windows) y nadie medía su bucle de
// eventos. Este módulo es eso y nada más:
//
//   * una bitácora propia, `cliente.log`, junto a `servicios/` y `capturas-xhr/` en
//     ProgramData — la carpeta que ya se pide completa cuando una caja falla;
//   * un detector de trabas: un reloj cada 250 ms que anota cuando llega tarde por más
//     de un segundo, con el contexto del momento (memoria, CPU del intervalo, peticiones
//     en vuelo en el proxy, operaciones lentas recientes);
//   * pausas largas del recolector de basura (> 200 ms), que son una causa clásica;
//   * `timed(nombre, fn)`: envoltura para lo que corre síncrono en este proceso (los
//     handlers de IPC, la escritura de la captura XHR). Si tarda más de 200 ms queda
//     anotado con su nombre, y la siguiente traba lo cita.
//
// Reglas de la casa: nunca lanza, nunca bloquea (la bitácora es un WriteStream, no
// appendFileSync) y cuesta casi nada cuando todo está bien.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { PerformanceObserver, constants: perfConstants } = require('perf_hooks');

const LOG_FILENAME = 'cliente.log';
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const TICK_MS = 250;
const LAG_REPORT_MS = Math.max(200, parseInt(process.env.NESTOR_LAG_REPORT_MS || '1000', 10));
const SLOW_OP_MS = 200;
const GC_REPORT_MS = 200;
// Operaciones lentas que se recuerdan para citarlas en la próxima traba.
const RECENT_SLOW_MAX = 20;
const RECENT_SLOW_WINDOW_MS = 60 * 1000;

let dir = '';
let logStream = null;
let lagTimer = null;
let gcObserver = null;
let contextFn = null;
const recentSlow = [];
let lastTick = 0;
let lastCpu = null;

function resolveDir(userDataDir) {
    const candidatos = [];
    const override = String(process.env.NESTOR_CLIENT_LOG_DIR || '').trim();
    if (override) candidatos.push(override);

    if (process.platform === 'win32') {
        const base = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
        candidatos.push(path.join(base, 'NestorPOS', 'cliente'));
    } else if (process.platform === 'darwin') {
        candidatos.push(path.join('/Users/Shared', 'NestorPOS', 'cliente'));
    } else {
        candidatos.push(path.join('/var/lib', 'nestorpos', 'cliente'));
    }
    if (userDataDir) candidatos.push(path.join(userDataDir, 'cliente'));
    candidatos.push(path.join(os.homedir(), '.nestorpos', 'cliente'));

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

function openLog() {
    if (!dir) return;
    const file = path.join(dir, LOG_FILENAME);
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

/** Una línea a `cliente.log` (y a la consola). Nunca lanza. */
function log(linea) {
    const texto = `${new Date().toISOString()} ${linea}`;
    try { console.log(`[cliente] ${linea}`); } catch { }
    if (!logStream) return;
    try { logStream.write(texto + '\n'); } catch { }
}

function mb(n) {
    return Math.round((Number(n) || 0) / 1048576);
}

function snapshot() {
    const m = process.memoryUsage();
    const partes = [`rss=${mb(m.rss)}MB`, `heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB`];
    if (contextFn) {
        try {
            const extra = contextFn();
            if (extra && typeof extra === 'object') {
                for (const [k, v] of Object.entries(extra)) {
                    if (v === undefined || v === null || v === '') continue;
                    partes.push(`${k}=${v}`);
                }
            }
        } catch { }
    }
    return partes.join(' ');
}

function rememberSlow(nombre, ms) {
    recentSlow.push({ nombre, ms, at: Date.now() });
    while (recentSlow.length > RECENT_SLOW_MAX) recentSlow.shift();
}

function slowSince(desde) {
    return recentSlow
        .filter((s) => s.at >= desde)
        .map((s) => `${s.nombre}(${s.ms}ms)`)
        .join(', ');
}

function tick() {
    const ahora = Date.now();
    const esperado = lastTick + TICK_MS;
    const tarde = ahora - esperado;
    lastTick = ahora;

    if (tarde < LAG_REPORT_MS) {
        lastCpu = process.cpuUsage();
        return;
    }

    // CPU de ESTE proceso durante la traba. Si es ~igual a la traba, el hilo estuvo
    // ocupado haciendo algo (cómputo, GC, E/S síncrona contada como sistema); si es
    // casi cero, estuvo dormido esperando a otro (disco, antivirus, la máquina entera).
    let cpu = '';
    try {
        const d = process.cpuUsage(lastCpu || undefined);
        cpu = `cpu=${Math.round(d.user / 1000)}+${Math.round(d.system / 1000)}ms`;
    } catch { }
    lastCpu = process.cpuUsage();

    const inicio = ahora - tarde - TICK_MS;
    const lentas = slowSince(Math.min(inicio, ahora - RECENT_SLOW_WINDOW_MS));
    log(`[traba] el proceso principal estuvo detenido ${tarde} ms`
        + ` (${new Date(inicio).toISOString()} → ahora) ${cpu} ${snapshot()}`
        + (lentas ? ` · operaciones lentas recientes: ${lentas}` : ''));
}

function startGcObserver() {
    try {
        const kinds = {};
        if (perfConstants) {
            kinds[perfConstants.NODE_PERFORMANCE_GC_MAJOR] = 'mayor';
            kinds[perfConstants.NODE_PERFORMANCE_GC_MINOR] = 'menor';
            kinds[perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL] = 'incremental';
            kinds[perfConstants.NODE_PERFORMANCE_GC_WEAKCB] = 'weakcb';
        }
        gcObserver = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                if (e.duration < GC_REPORT_MS) continue;
                const kind = (e.detail && kinds[e.detail.kind]) || (e.detail && e.detail.kind) || '?';
                const ms = Math.round(e.duration);
                rememberSlow(`gc:${kind}`, ms);
                log(`[gc] pausa del recolector ${ms} ms (${kind}) ${snapshot()}`);
            }
        });
        gcObserver.observe({ entryTypes: ['gc'] });
    } catch {
        gcObserver = null;
    }
}

/**
 * Abre la bitácora y arranca el detector. `context` es una función que devuelve datos
 * del momento (peticiones en vuelo del proxy, etc.) para pegarlos a cada traba.
 */
function init(userDataDir, { appVersion = '', context = null } = {}) {
    try {
        dir = resolveDir(userDataDir);
        openLog();
        contextFn = typeof context === 'function' ? context : null;
        log(`cliente iniciado — versión ${appVersion || '?'} · pid ${process.pid}`
            + ` · ${os.hostname()} · ${process.platform} ${os.release()}`
            + ` · bitácora en ${dir || '(sin directorio)'}`);

        lastTick = Date.now();
        lastCpu = process.cpuUsage();
        lagTimer = setInterval(tick, TICK_MS);
        if (lagTimer.unref) lagTimer.unref();
        startGcObserver();
    } catch (e) {
        try { console.warn('[cliente] no se pudo iniciar la medición:', e && e.message ? e.message : e); } catch { }
    }
}

/** Para cambiar el contexto después de init (el proxy se levanta más tarde). */
function setContext(fn) {
    contextFn = typeof fn === 'function' ? fn : null;
}

/**
 * Corre `fn` y anota si su parte SÍNCRONA tardó más de SLOW_OP_MS. Si devuelve una
 * promesa, lo que tarde en resolver no cuenta: esperar no traba el proceso (un cobro EMV
 * espera 75 s sin bloquear a nadie). Lo que traba es el cómputo/E-S síncrona antes de
 * soltar el hilo — un SQLite síncrono, un writeSync — y eso es lo que se mide.
 */
function timed(nombre, fn) {
    const t0 = Date.now();
    try {
        return fn();
    } finally {
        noteDuration(nombre, Date.now() - t0);
    }
}

/** Igual que `timed`, pero para lo que se sabe síncrono y corre muy seguido (sin closures). */
function noteDuration(nombre, ms) {
    if (ms < SLOW_OP_MS) return;
    rememberSlow(nombre, ms);
    log(`[lento] ${nombre} tardó ${ms} ms`);
}

function shutdown() {
    try { if (lagTimer) clearInterval(lagTimer); } catch { }
    lagTimer = null;
    try { if (gcObserver) gcObserver.disconnect(); } catch { }
    gcObserver = null;
    log('cliente cerrado');
    try { if (logStream) logStream.end(); } catch { }
    logStream = null;
}

module.exports = { init, setContext, log, timed, noteDuration, shutdown, dir: () => dir };
