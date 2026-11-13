/**
 * Esperar al servidor mientras arranca o se actualiza, enseñando qué hace.
 *
 * El servidor (nestor.exe) corre como servicio y no puede dibujar nada en el escritorio.
 * Ahora abre su puerto desde el primer segundo del arranque y responde en
 * `/api/v1/boot/status` en qué fase va (abrir bases, migrar el esquema, servicios
 * internos), y durante una actualización lo responde el updater con su propio avance.
 * Este módulo lo pregunta y lo pasa al splash, para que tras un reinicio o una
 * actualización la caja diga «actualizando la estructura de la base, 45 %, lleva 1 min»
 * en lugar de abrir sobre un servidor que todavía no contesta.
 *
 * Reglas, para no hacer el arranque más lento de lo que ya era:
 *
 *  · Si al PRIMER intento no hay respuesta (servidor apagado, en otra máquina sin red,
 *    o un servidor viejo que no conoce la ruta) se sigue de inmediato, exactamente como
 *    antes. Sólo se espera cuando el servidor DICE que está arrancando.
 *  · Una vez visto arrancando, un hueco sin respuesta se tolera un rato: entre que el
 *    updater suelta el puerto y el servicio lo abre pasan unos segundos.
 *  · Tope de espera. El POS sabe trabajar sin servidor (sesión fuera de línea), así que
 *    un arranque eterno del servidor no puede dejar la caja en el splash para siempre.
 */

const RUTA = '/api/v1/boot/status';
const TOPE_ESPERA_MS = 120000;
const TOPE_SIN_RESPUESTA_MS = 30000;
const INTERVALO_MS = 1000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function preguntar(origin, timeoutMs) {
    const res = await fetch(`${origin}${RUTA}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) throw new Error('no es JSON');
    return await res.json();
}

/**
 * @param {string} origin  servidor (http://host:8180)
 * @param {(s: object) => void} onStatus  recibe cada estado mientras arranca
 * @returns {Promise<{waited: boolean, ready: boolean, last: object|null, reason: string}>}
 */
async function waitForServerBoot(origin, onStatus) {
    const inicio = Date.now();
    let visto = false;
    let ultimo = null;
    let sinRespuestaDesde = 0;

    for (;;) {
        let s = null;
        try {
            s = await preguntar(origin, 2500);
        } catch (e) {
            if (!visto) return { waited: false, ready: false, last: null, reason: 'sin-respuesta' };
            if (!sinRespuestaDesde) sinRespuestaDesde = Date.now();
            if (Date.now() - sinRespuestaDesde > TOPE_SIN_RESPUESTA_MS) {
                return { waited: true, ready: false, last: ultimo, reason: 'sin-respuesta' };
            }
            try { onStatus && onStatus({ ...(ultimo || {}), reconnecting: true }); } catch (_) { }
        }

        if (s) {
            sinRespuestaDesde = 0;
            if (s.ready) return { waited: visto, ready: true, last: s, reason: 'listo' };
            if (!s.booting) {
                // Falló el arranque: se dice y se sigue como antes.
                return { waited: visto, ready: false, last: s, reason: 'error' };
            }
            visto = true;
            ultimo = s;
            try { onStatus && onStatus(s); } catch (_) { }
        }

        if (Date.now() - inicio > TOPE_ESPERA_MS) {
            return { waited: true, ready: false, last: ultimo, reason: 'tope' };
        }
        await dormir(INTERVALO_MS);
    }
}

/** "1 min 10 s" */
function duracion(ms) {
    let s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    s %= 60;
    return s ? `${m} min ${s} s` : `${m} min`;
}

module.exports = { waitForServerBoot, duracion };
