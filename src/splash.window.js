/**
 * Splash de arranque del cliente.
 *
 * El problema: entre el clic en el icono y el punto de venta en pantalla pasan varios
 * segundos —caché de sesión, servidor local, comprobación de build y, sobre todo, bajar
 * y descomprimir el bundle del frontend— y hasta ahora en esos segundos no había NADA.
 * Ni ventana. Una aplicación que no dibuja nada al abrirse no parece lenta, parece rota:
 * lo que hace la gente es volver a pulsar el icono, y esa segunda instancia se rechaza
 * (acquireInstanceLock), así que el segundo intento tampoco enseña nada.
 *
 * Esta ventana se abre lo ANTES posible y se retira cuando la principal ya está en
 * pantalla. Es la misma cara del splash del POS (ILoadingSplash.vue) —mismo logo, mismo
 * morado, misma barra— para que el arranque se lea como una sola pantalla de carga que
 * se transforma, y no como dos aplicaciones distintas encadenadas.
 *
 * ── Cómo se le habla ────────────────────────────────────────────────────────────
 *
 *   splash.show();                       // en cuanto se sabe que somos la única instancia
 *   splash.step('servidor');             // cambia de etapa (mueve la barra y la frase)
 *   splash.progress(bajado, total);      // avance real de la descarga del bundle
 *   splash.close();                      // cuando la ventana principal ya se ve
 *
 * ── Tres decisiones que no son obvias ───────────────────────────────────────────
 *
 * 1. NADA de esto lanza. Un fallo del splash no puede impedir que la caja abra, así que
 *    todo va en try/catch silencioso y `close()` es idempotente. Es una pantalla.
 *
 * 2. Se habla con ella por `executeJavaScript`, no por IPC con preload. Un preload es
 *    otro archivo que cargar antes de poder dibujar, y esta ventana existe justamente
 *    para dibujarse pronto. El último estado se guarda y se reaplica en
 *    `did-finish-load`: los primeros `step()` salen antes de que la página exista, y sin
 *    eso se perderían — que es como decir que el splash arranca en blanco.
 *
 * 3. Está SIEMPRE ENCIMA, y por eso `close()` se llama antes de cualquier diálogo de
 *    error del arranque. Un `showErrorBox` detrás de un splash sin bordes es una caja
 *    que no arranca y no dice por qué.
 */

const path = require('path');
const { BrowserWindow } = require('electron');

// Las etapas del arranque, con su tramo de la barra y su frase.
//
// El reparto no es cosmético: `descarga` se lleva de 55 a 92 porque ahí es donde se va
// el tiempo de verdad (el bundle se baja entero en cada arranque), y el resto son pasos
// cortos que sólo necesitan demostrar que algo se mueve.
const PASOS = {
    arranque: { at: 4, estado: 'Iniciando Nestor POS' },
    equipo: { at: 12, estado: 'Preparando el equipo' },
    servidor: { at: 26, estado: 'Levantando el servidor local' },
    servicios: { at: 38, estado: 'Revisando los servicios de la caja' },
    actualizacion: { at: 48, estado: 'Buscando actualizaciones' },
    descarga: { at: 55, estado: 'Descargando la aplicación' },
    instalando: { at: 92, estado: 'Instalando la actualización' },
    ventana: { at: 96, estado: 'Abriendo el punto de venta' },
    listo: { at: 100, estado: 'Listo' }
};

const DESCARGA_DESDE = 55;
const DESCARGA_HASTA = 92;

let win = null;
let cargada = false;
// Último estado enviado. Se reaplica al terminar de cargar la página: los primeros
// `step()` llegan antes de que exista el documento.
let ultimo = { progress: null, estado: 'Iniciando…', detalle: '' };

function mb(bytes) {
    return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
}

/** Manda el estado a la ventana. Silencioso: es una pantalla, no puede tumbar nada. */
function pintar() {
    if (!win || win.isDestroyed() || !cargada) return;
    try {
        win.webContents.executeJavaScript(
            `window.__splash && window.__splash(${JSON.stringify(ultimo)});`,
            true
        ).catch(() => { });
    } catch (e) { /* la ventana se fue entre medias */ }
}

/**
 * Abre el splash. Idempotente: llamarlo dos veces no abre dos ventanas.
 *
 * `show: true` desde la construcción, y no el `ready-to-show` que usa la ventana
 * principal: ahí la espera vale la pena (evita ver el frontend a medio pintar), aquí es
 * exactamente lo contrario — lo que se quiere es que aparezca algo YA. Con
 * `backgroundColor` puesto, el marco sale ya del color final en vez de con el flash
 * blanco de siempre.
 */
function show() {
    if (win && !win.isDestroyed()) return win;
    try {
        win = new BrowserWindow({
            width: 460,
            height: 258,
            resizable: false,
            movable: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: false,
            frame: false,
            // Opaca a propósito: una ventana translúcida obliga al compositor a
            // trabajar y en Windows tarda más y parpadea. Ver el comentario de la
            // página.
            transparent: false,
            backgroundColor: '#ffffff',
            center: true,
            alwaysOnTop: true,
            title: 'Nestor POS',
            show: true,
            webPreferences: {
                // Sin preload y sin node: la página no necesita nada del sistema, y
                // cada cosa que se le cuelgue aquí es tiempo antes del primer dibujo.
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                devTools: false,
                // Un splash no tiene por qué seguir pintando si Windows decide que la
                // ventana no se ve; apagarlo evita que la barra se congele.
                backgroundThrottling: false
            }
        });

        win.setMenuBarVisibility(false);
        win.webContents.on('did-finish-load', () => {
            cargada = true;
            pintar();
        });
        win.on('closed', () => { win = null; cargada = false; });

        // Red de seguridad. Si el arranque se cuelga en un sitio que nadie previó, un
        // splash SIEMPRE ENCIMA y sin bordes tapa el escritorio entero y no se puede
        // apartar: la caja queda inutilizable por la pantalla que venía a ayudar. Pasado
        // un rato largo se deja de forzar el "encima de todo" — el splash sigue ahí
        // diciendo en qué paso se quedó, pero ya se puede mandar detrás y usar el equipo.
        // No se CIERRA: cerrarlo devolvería el escritorio vacío de antes, que es peor.
        const alivio = setTimeout(() => {
            try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); } catch (e) { }
        }, 180000);
        if (alivio.unref) alivio.unref();
        win.on('closed', () => clearTimeout(alivio));

        win.loadFile(path.join(__dirname, 'pages', 'splash.html'));
    } catch (e) {
        console.warn('[splash] no se pudo abrir:', e && e.message ? e.message : e);
        win = null;
    }
    return win;
}

/** Cambia de etapa. `detalle` es la línea chica de debajo (opcional). */
function step(clave, detalle) {
    const paso = PASOS[clave];
    if (!paso) return;
    // La barra no retrocede: los pasos no duran lo mismo en dos equipos y una barra que
    // retrocede se lee como "se cayó y volvió a empezar".
    const antes = typeof ultimo.progress === 'number' ? ultimo.progress : -1;
    ultimo.progress = Math.max(antes, paso.at);
    ultimo.estado = paso.estado;
    ultimo.detalle = typeof detalle === 'string' ? detalle : '';
    pintar();
}

/** Sólo la línea chica, sin tocar la barra ni la frase. */
function note(detalle) {
    ultimo.detalle = typeof detalle === 'string' ? detalle : '';
    pintar();
}

/**
 * Avance de la descarga del bundle. `total` sale de Content-Length; cuando el servidor
 * no lo manda vale 0 y entonces no hay porcentaje honesto que enseñar: la barra queda
 * en movimiento y el texto cuenta los MB que van.
 */
function progress(bajado, total) {
    const hechos = Math.max(0, Number(bajado) || 0);
    const peso = Math.max(0, Number(total) || 0);
    ultimo.estado = PASOS.descarga.estado;
    if (peso > 0) {
        const frac = Math.min(1, hechos / peso);
        ultimo.progress = DESCARGA_DESDE + (DESCARGA_HASTA - DESCARGA_DESDE) * frac;
        ultimo.detalle = `${mb(hechos)} de ${mb(peso)}`;
    } else {
        ultimo.progress = null;   // el riel vuelve al vaivén
        ultimo.detalle = `${mb(hechos)} descargados`;
    }
    pintar();
}

/**
 * Deja el splash en rojo con un motivo. Se usa cuando el arranque va a seguir de todas
 * formas (una actualización que no se pudo bajar y se sigue con la copia local): si va a
 * terminar en un diálogo de error, lo que toca es `close()` y el diálogo.
 */
function fail(estado, detalle) {
    ultimo.estado = typeof estado === 'string' ? estado : 'No se pudo iniciar';
    ultimo.detalle = typeof detalle === 'string' ? detalle : '';
    ultimo.error = true;
    pintar();
}

/** Retira el splash. Idempotente y silencioso. */
function close() {
    const w = win;
    win = null;
    cargada = false;
    if (!w || w.isDestroyed()) return;
    try { w.destroy(); } catch (e) { /* ya se estaba yendo */ }
}

/** ¿Sigue en pantalla? Lo usa main.js para no cerrar dos veces. */
function isOpen() {
    return !!(win && !win.isDestroyed());
}

module.exports = { show, step, note, progress, fail, close, isOpen, PASOS };
