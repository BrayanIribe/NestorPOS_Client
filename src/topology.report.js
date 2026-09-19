// src/topology.report.js
//
// LATIDO DE TOPOLOGÍA — lo que esta caja le cuenta al servidor sobre sí misma.
//
// Tres datos que NADIE más puede averiguar, y que son exactamente los que
// faltaban para poder dibujar la topología de un cliente desde la nube:
//
//   1. Que en esta máquina está instalado el cliente POS, y en qué versión. No
//      hay sonda posible desde fuera: es una aplicación de escritorio.
//   2. La salud del microservicio EMV Santander. Escucha en 127.0.0.1:5000, así
//      que el servidor del POS no lo alcanza — ni debe, esa es su protección.
//   3. Cómo ve ESTA caja a su propio microservicio de impresión. Cuando eso
//      discrepa del sondeo que el servidor hace al :8331, el problema está en la
//      red de por medio, y esa distinción ahorra el viaje a la sucursal.
//
// Es DISTINTO del canal de errores POS (pos.error.js), y a propósito: aquel sube
// un paquete pesado —sesión XHR, consola, log del servidor— cuando el daemon se
// da por vencido con un servicio, y deduplica por 6 h. Esto es lo contrario: un
// JSON de un par de KB, cada pocos minutos, pase lo que pase. Uno es la
// evidencia de una falla; el otro, la prueba de vida.
//
// No lanza nunca y no reintenta: es un ESTADO, no un hecho. Si un envío se
// pierde, el siguiente lleva la foto buena — encolarlo sólo serviría para subir
// dentro de veinte minutos un estado que ya no es cierto.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { version: electronVersion } = process.versions;

// Cada cuánto late. Cinco minutos es lo mismo que tarda el servidor en sondear
// las cajas: reportar más seguido no haría que el panel supiera antes.
const INTERVALO_MS = 5 * 60 * 1000;
// Primer envío: se espera a que el daemon de servicios haya hecho al menos una
// ronda. Reportar antes mandaría los dos servicios en "sin-supervisar", que en
// el panel se lee como una caja sin nada instalado.
const ARRANQUE_MS = 60 * 1000;
const TIMEOUT_MS = 10000;

let timer = null;
let deps = null;
let ultimoError = '';
let ultimoEnvio = 0;
let enviados = 0;

/**
 * init arranca el latido.
 *
 * @param {object} opts
 *   appVersion   {string}   versión del cliente (app.getVersion()).
 *   serverOrigin {function} origen del POS. Función y no valor: el usuario puede
 *                           cambiarlo desde Configuración sin reiniciar.
 *   xhr          {object}   captura de sesiones. De ahí sale la IDENTIDAD: el
 *                           token del cajero y la caja en la que inició sesión.
 *   services     {object}   daemon de servicios. De ahí sale la SALUD.
 */
function init(opts) {
    deps = opts || {};
    if (timer) clearInterval(timer);
    setTimeout(() => { enviar('arranque'); }, ARRANQUE_MS);
    timer = setInterval(() => { enviar('periodico'); }, INTERVALO_MS);
    if (timer.unref) timer.unref();
}

function shutdown() {
    if (timer) clearInterval(timer);
    timer = null;
}

function status() {
    return { ok: !!timer, enviados, ultimoEnvio, ultimoError };
}

/**
 * enviar arma y manda la foto. Devuelve { ok, error } y NUNCA lanza: un fallo de
 * instrumentación no puede convertirse en un problema en la caja.
 */
async function enviar(motivo) {
    if (!deps) return { ok: false, error: 'sin inicializar' };
    try {
        const origin = String((deps.serverOrigin && deps.serverOrigin()) || '').replace(/\/+$/, '');
        if (!origin) return { ok: false, error: 'sin origen del servidor' };

        // La identidad la pone el TOKEN, no este proceso: sin sesión abierta no
        // hay a qué caja atribuir el reporte, y el servidor lo rechazaría. No es
        // un error: una caja apagada o en la pantalla de login simplemente no
        // reporta, y el panel ya sabe leer un reporte viejo.
        const identity = (deps.xhr && deps.xhr.currentIdentity && deps.xhr.currentIdentity()) || {};
        if (!identity.token) return { ok: false, error: 'sin sesión abierta' };

        const cuerpo = armarCuerpo();
        const res = await postJson(`${origin}/api/v1/system/caja-agent`, identity.token, cuerpo);
        enviados++;
        ultimoEnvio = Date.now();
        ultimoError = '';
        return { ok: true, motivo, respuesta: res };
    } catch (e) {
        ultimoError = String((e && e.message) || e);
        return { ok: false, error: ultimoError };
    }
}

function armarCuerpo() {
    const snap = (deps.services && deps.services.status && deps.services.status()) || {};
    return {
        client_version: String((deps.appVersion) || ''),
        electron_version: String(electronVersion || ''),
        platform: process.platform,
        arch: process.arch,
        hostname: safe(() => os.hostname()),
        // `os.release()` en Windows es el número de build ("10.0.19045"), que es
        // justo lo que hace falta para saber si una caja sigue en una versión sin
        // soporte. `os.version()` no existe en todas las versiones de Node.
        os_version: safe(() => `${os.type()} ${os.release()}`),
        uptime_seconds: Math.round(safeNum(() => os.uptime())),
        lan_ip: primeraIpLan(),
        ...medirMaquina(),
        services_mode: modoCorto(snap.mode),
        servicios: (snap.services || []).map((s) => ({
            id: s.id,
            state: s.supervised ? s.state : 'sin-supervisar',
            error: s.error || '',
            warn: s.warn || '',
            // `info` es el cuerpo crudo de la sonda de salud de ese servicio. Va
            // tal cual: el servidor lee de ahí las versiones, y acotarlo aquí
            // obligaría a tocar este archivo cada vez que uno de los dos
            // microservicios agregue un campo.
            info: s.info || null
        }))
    };
}

// ── Salud de la máquina ─────────────────────────────────────────────────────
//
// Es lo único de la caja que NADIE más puede medir: el servidor ve su :8331,
// pero no su CPU, su memoria ni su disco. Un disco al 97 % o una máquina clavada
// se ven días antes de que la caja deje de vender, y es justo lo que permite
// llamar al cliente en vez de que él llame.
//
// Todo va como null cuando no se pudo medir, NUNCA como 0: un cero se
// promediaría como una máquina en reposo con el disco vacío, que es lo contrario
// de lo que significa no haber podido leer.

// Lectura anterior de los contadores de CPU. El porcentaje de uso no existe como
// dato instantáneo: se saca de cuánto avanzó el tiempo ocioso ENTRE dos lecturas.
// Por eso el primer latido no reporta CPU y el segundo sí.
let cpuPrevio = null;

function medirCpu() {
    try {
        const cpus = os.cpus() || [];
        if (!cpus.length) return null;
        let ocioso = 0;
        let total = 0;
        for (const c of cpus) {
            for (const k of Object.keys(c.times)) total += c.times[k];
            ocioso += c.times.idle;
        }
        const previo = cpuPrevio;
        cpuPrevio = { ocioso, total };
        if (!previo) return null; // primera lectura: no hay contra qué comparar

        const dTotal = total - previo.total;
        const dOcioso = ocioso - previo.ocioso;
        // Contadores que no avanzaron (o que retrocedieron tras suspender el
        // equipo) no dan un cero: dan nada. Ver la misma guarda en el prober de
        // NestorPOS_Health, donde un contador sin lectura previa daba picos
        // absurdos.
        if (dTotal <= 0 || dOcioso < 0) return null;
        const uso = (1 - dOcioso / dTotal) * 100;
        return Math.max(0, Math.min(100, Math.round(uso * 10) / 10));
    } catch { return null; }
}

function medirMaquina() {
    const out = {
        cpu_percent: medirCpu(),
        ram_used_mb: null,
        ram_total_mb: null,
        disk_free_mb: null,
        disk_total_mb: null,
    };
    try {
        const total = os.totalmem();
        const libre = os.freemem();
        if (total > 0) {
            out.ram_total_mb = Math.round(total / 1048576);
            out.ram_used_mb = Math.round((total - libre) / 1048576);
        }
    } catch { /* se queda en null */ }
    try {
        // statfsSync existe desde Node 18.15 y Electron 40 trae Node 20+. Se mide
        // el volumen donde vive la aplicación, que es el que se llena con la
        // caché, los tickets y los registros — el que de verdad tumba la caja.
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(path.parse(process.execPath).root || '/');
            const bloque = st.bsize || 4096;
            out.disk_total_mb = Math.round((st.blocks * bloque) / 1048576);
            out.disk_free_mb = Math.round((st.bavail * bloque) / 1048576);
        }
    } catch { /* se queda en null */ }
    return out;
}

// modoCorto reduce el modo del daemon —que es una frase pensada para leerse en
// la barra del POS— a una palabra que quepa en la columna del servidor.
function modoCorto(mode) {
    const m = String(mode || '').toLowerCase();
    if (m.startsWith('rescate')) return 'rescate';
    if (m.startsWith('observaci')) return 'observacion';
    if (m.startsWith('apagado')) return 'apagado';
    return '';
}

// primeraIpLan devuelve la IPv4 de la primera interfaz real. Es la dirección con
// la que el servidor ve a esta caja, y la que hay que comparar contra la que la
// caja tiene configurada cuando "imprime en la caja equivocada".
function primeraIpLan() {
    try {
        const ifaces = os.networkInterfaces();
        for (const nombre of Object.keys(ifaces)) {
            for (const dir of ifaces[nombre] || []) {
                if (dir.family === 'IPv4' && !dir.internal) return dir.address;
            }
        }
    } catch { }
    return '';
}

function postJson(url, token, cuerpo) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-token': token || '' },
        body: JSON.stringify(cuerpo),
        signal: ctrl.signal
    }).then(async (res) => {
        const texto = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${texto.slice(0, 200)}`);
        try { return JSON.parse(texto); } catch { return {}; }
    }).finally(() => clearTimeout(t));
}

function safe(fn) {
    try { return String(fn() || ''); } catch { return ''; }
}

function safeNum(fn) {
    try { return Number(fn()) || 0; } catch { return 0; }
}

module.exports = { init, shutdown, status, enviar };
