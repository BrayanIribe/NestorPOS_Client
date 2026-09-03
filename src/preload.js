const { contextBridge, ipcRenderer } = require('electron');

function log(...args) {
    try { console.log(...args); } catch { }
    try { ipcRenderer.send('client:log', ...args); } catch { }
}

function invoke(channel, ...args) {
    // log('[ipc invoke] ->', channel, args);
    return ipcRenderer.invoke(channel, ...args)
        .then((res) => {
            // log('[ipc result] <-', channel, res);
            return res;
        })
        .catch((err) => {
            // log('[ipc error] <-', channel, String(err && err.message ? err.message : err));
            throw err;
        });
}

// Suscripción main -> renderer. Devuelve la función para darse de baja (los
// listeners de ipcRenderer no se limpian solos al desmontar un componente).
function subscribe(channel, cb) {
    if (typeof cb !== 'function') return () => { };

    const handler = (event, payload) => {
        try { cb(payload); } catch { }
    };

    ipcRenderer.on(channel, handler);
    return () => {
        try { ipcRenderer.removeListener(channel, handler); } catch { }
    };
}

log('[preload] loaded');

let initialConfig = null;
try {
    initialConfig = ipcRenderer.sendSync('nestor:get-config-sync');
} catch (err) {
    log('[preload] get-config-sync failed:', err && err.message ? err.message : err);
}

contextBridge.exposeInMainWorld('NestorClient', {
    serverOrigin: initialConfig ? initialConfig.serverOrigin : null,

    // Versión del ejecutable instalado, SÍNCRONA (viene con `get-config-sync`, sin viaje
    // extra). Es la misma que se publicó en Fact al hacer el deploy: build.go la inyecta
    // en el paquete y deploy.go sube ese número a /panel/v1/installers.
    //
    // La barra de estado del POS la pinta en el primer render; con una promesa se vería
    // "CAJA: X, v" y un instante después el número, en cada arranque de caja.
    // En navegador `window.NestorClient` no existe y el POS cae al User-Agent, que
    // también la trae (`nestorpos_client/1.0.5`).
    clientVersion: initialConfig ? String(initialConfig.clientVersion || '') : '',
    platform: initialConfig ? String(initialConfig.platform || '') : '',

    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke('win:toggle-maximize'),
    close: () => invoke('win:close'),
    openConfig: () => invoke('win:open-config'),
    isMaximized: () => invoke('win:is-maximized'),

    getConfig: () => invoke('nestor:get-config'),
    setServerOrigin: (origin) => invoke('nestor:set-server-origin', origin),
    testServerOrigin: (origin) => invoke('nestor:test-server-origin', origin),
    relaunch: () => invoke('nestor:relaunch'),

    refresh: () => invoke('nestor:refresh'),

    // Botón rojo "Eliminar datos y caché": borrado TOTAL (se lleva sesión y la
    // cola de tickets del POS) + reinicio.
    clearData: () => invoke('nestor:clear-data'),

    // Mismo motor que el botón rojo, pero para que el sistema vacíe el caché
    // solo cuando haya una actualización de software:
    //
    //   await window.NestorClient.clearCache({ preset: 'update', reason: 'ota' })
    //
    // preset 'update' (default) conserva sesión y ventas encoladas, baja el
    // bundle nuevo y recarga; 'cache' sólo tira caché; 'full' es el botón rojo.
    // Devuelve { ok, cleared, build, localStorageKeysRemoved, ... } y NO lanza:
    // si falla la descarga responde { ok:false, error } sin haber borrado nada.
    //
    // `bundleOptional: true` invierte eso: se limpia igual aunque el bundle no se
    // pueda bajar, y el motivo viene en `bundleError`. Es para lo que NO es una
    // actualización —una orden de "vaciar caché" del modo ingeniero—, que no debe
    // fracasar porque el servidor esté reiniciándose.
    clearCache: (options) => invoke('nestor:clear-cache', options || {}),

    // Aviso de que el caché se borró (venga de donde venga). Ojo: la ventana que
    // lo pidió normalmente se recarga o se reinicia justo después, así que esto
    // sirve para reaccionar, no para confirmar.
    onCacheCleared: (cb) => subscribe('nestor:cache-cleared', cb),

    // Gate del auto-update. Mientras el POS lo tenga tomado (y siga en /pos), el
    // cliente NO se recarga solo al cambiar la build del servidor: la anota y
    // avisa. Hay que renovarlo cada <90 s o caduca — así una ventana colgada no
    // deja a la caja sin actualizar nunca.
    setUpdateGate: (active) => invoke('nestor:update-gate', { active: active !== false }),

    // { available, currentBuildId, remoteBuildId, deferred, gate }
    getUpdateStatus: () => invoke('nestor:update-status'),

    // Se dispara cuando hay build nueva y el gate la difirió. Quien escucha es
    // responsable de aplicarla con clearCache({ preset: 'update' }) cuando sea
    // seguro. Devuelve la función para darse de baja.
    onUpdateAvailable: (cb) => subscribe('nestor:update-available', cb),

    // ── Servidor local ─────────────────────────────────────────────────────
    // Todo lo que pide la ventana (el frontend y /api/v1) pasa por el express que este
    // mismo proceso levanta en 127.0.0.1:18180. Si ese servidor se cae, la ventana sigue
    // en pantalla y CADA petición muere con ERR_NETWORK — que desde el renderer es
    // indistinguible de "no hay red" o "el servidor del negocio está apagado".
    //
    // Esto es la vía para preguntarlo y para arreglarlo:
    //
    //   const st = await window.NestorClient.localServer.repair('login')
    //   if (!st.ok) { /* avisar: el cliente perdió su servidor local */ }
    //
    // Devuelve { ok, listening, foreign, error, url, port, pid, repairs }. `foreign:true`
    // = el puerto lo tiene otro proceso (otra instancia del cliente): eso no se arregla
    // desde aquí, hay que cerrar la otra o reiniciar.
    localServer: {
        status: () => invoke('nestor:local-server-status'),
        repair: (reason) => invoke('nestor:local-server-repair', { reason: String(reason || 'manual') }),
        // Cambios de estado (cayó / volvió). Devuelve la función para darse de baja.
        onChange: (cb) => subscribe('nestor:local-server', cb)
    },

    // ── Ventas en local ────────────────────────────────────────────────────
    // Base SQLite de la caja, fuera del perfil de Electron: cada ticket, cada
    // renglón y cada voucher de la terminal quedan en el equipo aunque el
    // servidor no esté y aunque se limpie el navegador. Ver src/ledger.js.
    //
    // Aquí no se borra nada. `remove` es la única salida y no es un DELETE: pone
    // una lápida sobre una venta que NUNCA se consolidó (deja de verse y de
    // contar) dejando quién, cuándo y por qué. Una venta ya registrada en el
    // servidor la rechaza el motor.
    //
    //   if (window.NestorClient?.ledger) {
    //     await window.NestorClient.ledger.record({ key, total, products, ... });
    //     const { items } = await window.NestorClient.ledger.list({ cut_id: 84 });
    //   }
    //
    // Ninguna de estas llamadas lanza: responden { ok:false, error } cuando el
    // ledger no está disponible (Electron sin node:sqlite, disco sin permisos).
    // En navegador `window.NestorClient` no existe: validar siempre antes.
    ledger: {
        // ── Contrato de capacidades ────────────────────────────────────────
        // El frontend lo sirve el BACKEND y el cliente lo cachea, así que las dos
        // piezas se actualizan por su cuenta: es normal tener un frontend nuevo
        // sobre un cliente de hace tres versiones. Sin una lista explícita, la
        // única forma de saber qué hay del otro lado es llamar y ver si falla —y
        // un canal que no existe hace que `invoke` RECHACE, no que devuelva un
        // error manejable.
        //
        // Esta lista es estática (no cuesta un viaje por IPC y funciona aunque la
        // base no haya abierto) y viaja DENTRO del cliente, así que siempre
        // describe la versión que de verdad está instalada.
        //
        // Al agregar un canal nuevo: añadirlo aquí Y subir LEDGER_IPC_VERSION.
        version: 3,
        capabilities: [
            // v1 — registro y consulta
            'status', 'stats', 'record', 'mark', 'emv',
            'list', 'get', 'summary', 'verify', 'export',
            // v2 — retiro manual y "revisada por un supervisor"
            'remove', 'acknowledge',
            // v3 — retención por archivado con ancla (180 días)
            'archive', 'archives',
        ],

        status: () => invoke('nestor:ledger:status'),
        stats: () => invoke('nestor:ledger:stats'),
        // Anota o actualiza una venta (idempotente por `key` = uuid del carrito).
        record: (entry) => invoke('nestor:ledger:record', entry || {}),
        // Marca una venta ya anotada: registrada, rechazada, impresa, revisada.
        mark: (patch) => invoke('nestor:ledger:mark', patch || {}),
        // Retira a mano una venta SIN consolidar: lápida, no DELETE. El motivo es
        // opcional; el quién/cuándo lo pone quien llama. Devuelve
        // { ok:false, code:'E_LEDGER_TICKET_CONSOLIDATED' } si ya está registrada.
        remove: (patch) => invoke('nestor:ledger:remove', patch || {}),
        // Intento con la terminal EMV, aprobado o no, con el voucher completo.
        emv: (entry) => invoke('nestor:ledger:emv', entry || {}),
        // Listado por fecha de creación DESCENDENTE.
        list: (query) => invoke('nestor:ledger:list', query || {}),
        get: (key) => invoke('nestor:ledger:get', String(key || '')),
        // Sumatoria de la caja para conciliar contra el servidor en el corte X/Z.
        summary: (query) => invoke('nestor:ledger:summary', query || {}),
        // Recorre la cadena de eventos y dice si alguien la tocó por fuera.
        verify: (limit) => invoke('nestor:ledger:verify', limit || 0),
        export: (query) => invoke('nestor:ledger:export', query || {}),
        // Retención. Corre sola al abrir la base y cada 6 h; esto sólo la adelanta.
        // NO es un borrado: saca de la base viva lo ya resuelto con más de 180 días y
        // deja el ancla (rango de eventos, hash y SHA-256 del archivo) para que
        // `verify()` siga detectando cualquier hueco que no venga de aquí.
        archive: (options) => invoke('nestor:ledger:archive', options || {}),
        archives: () => invoke('nestor:ledger:archives'),
    },

    // ── Captura de sesiones XHR ───────────────────────────────────────────────
    // El proceso principal graba TODO el XHR de la ventana en un HAR 1.2 desde el
    // arranque, abre un archivo nuevo en cada login y lo cierra al salir de la
    // aplicación. El frontend no tiene que hacer nada para que se capture; esto es
    // sólo para consultarlo y para dejar marcas:
    //
    //   const st = await window.NestorClient.xhr.status();   // sesión en curso
    //   await window.NestorClient.xhr.mark({ tipo: 'venta-fallida', folio });
    //   const { ruta } = await window.NestorClient.xhr.saveNow('soporte');
    //
    // `mark` deja una nota dentro del .har (en `_fin.eventos`) para ubicar el
    // momento exacto en el que algo falló. Ver src/xhr.capture.js.
    xhr: {
        status: () => invoke('nestor:xhr:status'),
        list: (limit) => invoke('nestor:xhr:list', limit || 30),
        // Cierra el .har de la sesión en curso (queda completo y abrible) y sigue
        // capturando en uno nuevo. No cierra el punto de venta.
        saveNow: (reason) => invoke('nestor:xhr:save-now', String(reason || 'manual')),
        mark: (entry) => invoke('nestor:xhr:mark', entry || {}),
        // Las capturas se borran solas a los 10 días; esto sólo adelanta el barrido.
        sweep: () => invoke('nestor:xhr:sweep'),
        openFolder: () => invoke('nestor:xhr:open-folder'),
        // Identidad de la caja. El POS la manda al montar y en cada login; con ella se
        // nombran las capturas (licencia + caja + usuario) y se identifica la incidencia
        // en la nube. `token` es el de la sesión del cajero: el proceso principal lo usa
        // para leer el log del servidor y para subir el paquete, y lo guarda SÓLO en
        // memoria (nunca sale por `status()`).
        setIdentity: (identity) => invoke('nestor:xhr:set-identity', identity || {}),
    },

    // ── Errores POS ───────────────────────────────────────────────────────────
    // Cuando /pos/register-ticket falla, esto arma el paquete de incidencia —la sesión
    // XHR completa, el volcado de consola, el estado de la base de ventas locales y el
    // log del servidor leído EN ESE INSTANTE— y lo sube a Fact, donde el módulo
    // "Errores POS" lo indexa por licencia, caja y usuario.
    //
    //   await window.NestorClient.diag.report({ code, message, status, folio, ... });
    //
    // Nunca lanza y nunca bloquea la venta: devuelve { ok:false, error } si algo falla,
    // y { ok:true, reported:false, reason:'repetido' } cuando el mismo error ya subió
    // hace poco (se deduplica por código + licencia + caja, ventana de 6 h).
    //
    // Al agregar un canal nuevo aquí: subir `version`.
    diag: {
        version: 1,
        capabilities: ['report', 'status', 'flush'],
        report: (info) => invoke('nestor:diag:report', info || {}),
        status: () => invoke('nestor:diag:status'),
        // Fuerza un intento de subida de la cola pendiente (la caja reintenta sola cada
        // 5 min y al arrancar).
        flush: () => invoke('nestor:diag:flush'),
    },

    // ── Servicios de la caja ──────────────────────────────────────────────────
    // El punto de venta depende de dos microservicios que corren FUERA del cliente y
    // que se caen solos: el servicio de impresión (127.0.0.1:8331) y la terminal
    // Santander EMV (127.0.0.1:5000). Hasta ahora había que levantarlos a mano —
    // `sc start NestorPrinter` y un .ps1 para el EMV— y el cajero mientras tanto sólo
    // veía "no imprime" o "no pasa la tarjeta".
    //
    // El proceso principal ahora los vigila y los rescata. Esto es la vía para
    // encender esa vigilancia, consultarla y pedir una reparación:
    //
    //   // al entrar a /pos, si esta caja tiene terminal:
    //   await window.NestorClient.services.ensure('emv');
    //   // alrededor de un cobro largo, para que nadie toque el servicio:
    //   await window.NestorClient.services.hold('emv', 90000);
    //
    // Ninguna llamada lanza: responden { ok:false, error }. En navegador
    // `window.NestorClient` no existe — validar siempre antes.
    //
    // Al agregar un canal nuevo: añadirlo a `capabilities` Y subir `version`. El
    // frontend lo sirve el BACKEND y el cliente se actualiza por su cuenta, así que un
    // frontend nuevo sobre un cliente viejo es lo normal, y un canal inexistente hace
    // que `invoke` RECHACE en vez de devolver un error manejable.
    services: {
        // v2: configuración del daemon desde la ventana de Configuración
        //     (config/configSave/configReset/discover/probe/pickFile).
        // v3: requisitos de la caja e instalación de lo que falte
        //     (requirements/installTasks).
        version: 3,
        capabilities: [
            'status', 'ensure', 'release', 'repair', 'hold', 'unhold', 'openFolder', 'onChange',
            'config', 'configSave', 'configReset', 'discover', 'probe', 'pickFile',
            'requirements', 'installTasks'
        ],

        // { ok, enabled, rescue, mode, services: [{ id, state, detail, warn, ... }] }
        status: () => invoke('nestor:services:status'),
        // Pone el servicio bajo vigilancia y, si no contesta, lo levanta AHORA.
        ensure: (id, options) => invoke('nestor:services:ensure', Object.assign({ id }, options || {})),
        // Deja de vigilarlo (no apaga nada). El de impresión se vigila siempre.
        release: (id) => invoke('nestor:services:release', { id }),
        // Reparación pedida por una persona: se salta la espera entre intentos.
        repair: (id) => invoke('nestor:services:repair', { id }),
        // "No toques este servicio durante los próximos ms." Imprescindible en un cobro
        // con tarjeta: relanzar el EMV mata el proceso, y con él la autorización.
        hold: (id, ms) => invoke('nestor:services:hold', { id, ms }),
        unhold: (id) => invoke('nestor:services:unhold', { id }),
        openFolder: () => invoke('nestor:services:open-folder'),

        // ── Asistente de configuración ──────────────────────────────────────
        // Lo usa la página de Configuración del propio cliente, no el frontend del
        // POS; se expone por el mismo puente porque es la misma ventana y el mismo
        // preload. Ver src/pages/services.wizard.html.
        //
        // { ok, esquema, valores, fuentes, env, archivo, modo }. `fuentes` dice de
        // dónde salió cada valor (fábrica/archivo/entorno) y `env` qué campos fija una
        // variable de entorno: esos NO se pueden guardar, y el asistente los bloquea.
        config: () => invoke('nestor:services:config'),
        // Guarda un cambio PARCIAL y lo aplica en caliente, sin reiniciar el cliente.
        configSave: (valores) => invoke('nestor:services:config-save', { valores: valores || {} }),
        configReset: () => invoke('nestor:services:config-reset'),
        // Servicios de Windows, tareas programadas e instance.json de ESTA máquina.
        discover: () => invoke('nestor:services:discover'),
        // Probar un destino candidato sin guardarlo.
        probe: (arg) => invoke('nestor:services:probe', arg || {}),
        pickFile: (arg) => invoke('nestor:services:pick-file', arg || {}),

        // ── Requisitos de la caja ───────────────────────────────────────────
        // Qué le falta a ESTA caja para poder rescatarse sola: la tarea programada del
        // EMV bien registrada, la tarea de respaldo del printer, y el permiso para que
        // el usuario de la caja pueda arrancar el servicio de impresión sin elevar.
        //
        // { ok, usuario, administrador, requisitos: [{ clave, titulo, ok, reparable, detalle }] }
        requirements: () => invoke('nestor:services:requirements'),
        // Instala lo que falte. ABRE UN AVISO DE UAC: llámalo sólo desde un botón, con
        // una persona delante. `que` es la lista de claves de requisito a reparar, para
        // que lo que se ejecuta elevado sea exactamente lo que el operador vio y aceptó.
        installTasks: (que) => invoke('nestor:services:install-tasks', { que: que || [] }),
        // Cambios de estado (se cayó / se está rescatando / volvió). Devuelve la
        // función para darse de baja.
        onChange: (cb) => subscribe('nestor:services', cb)
    },

    getWindowMode: () => invoke('win:get-mode'),
    toggleFullscreen: () => invoke('win:toggle-fullscreen'),
    toggleKiosk: () => invoke('win:toggle-kiosk'),
    exitAll: () => invoke('win:exit-fullscreen-kiosk')
});

const TITLEBAR_H = 44;
let currentTitlebarH = TITLEBAR_H;
let appObserver = null;
let appReadyTimer = null;
let renderDebounce = null;

// En /pos la barra se oculta para dejar la pantalla completa al punto de venta
// (puedes apagarlo con NESTOR_HIDE_TITLEBAR_ON_POS=0).
const HIDE_TITLEBAR_ON_POS = (process.env.NESTOR_HIDE_TITLEBAR_ON_POS || '1') === '1';

function currentPathname() {
    try {
        return window.location && window.location.pathname ? window.location.pathname : '';
    } catch {
        return '';
    }
}

function isPosRoute() {
    return /^\/pos(\/|$)/.test(currentPathname());
}

function shouldInjectTitlebar() {
    return !currentPathname().startsWith('/__client/config');
}

function shouldShowTitlebar() {
    if (!shouldInjectTitlebar()) return false;
    if (HIDE_TITLEBAR_ON_POS && isPosRoute()) return false;
    return true;
}

function ensureBaseStyle() {
    if (document.getElementById('nestor-base-style')) return;

    const style = document.createElement('style');
    style.id = 'nestor-base-style';
    style.textContent = `
:root { --nestor-titlebar-h: ${TITLEBAR_H}px; }
html, body { height: 100%; margin: 0; overflow: hidden; }
`;
    document.head.appendChild(style);
}

function setTitlebarHeight(px) {
    currentTitlebarH = px;
    try {
        document.documentElement.style.setProperty('--nestor-titlebar-h', `${px}px`);
    } catch { }
}

function applyAppLayout() {
    const app = document.getElementById('app');
    if (!app) return false;

    app.style.position = 'fixed';
    app.style.left = '0';
    app.style.right = '0';
    app.style.bottom = '0';
    app.style.top = `${currentTitlebarH}px`;
    app.style.marginTop = '0px';
    app.style.paddingTop = '0px';
    app.style.height = 'auto';
    app.style.minHeight = '0px';
    app.style.overflow = 'auto';

    const iApp = app.querySelector('.i-app');
    if (iApp) {
        iApp.style.height = '100%';
        iApp.style.minHeight = '100%';
        iApp.style.maxHeight = '100%';
    }

    // Caso común específico (tu progress bar)
    const cov = document.querySelectorAll('.__cov-progress');
    cov.forEach((el) => { el.style.top = `${currentTitlebarH}px`; });

    patchTopFixedElements(app);
    return true;
}

function patchTopFixedElements(app) {
    if (!app) return;

    const candidates = app.querySelectorAll('*');

    if (currentTitlebarH <= 0) {
        for (const el of candidates) {
            if (!el.dataset || el.dataset.nestorPatchedTop !== '1') continue;
            el.style.top = '0px';
            delete el.dataset.nestorPatchedTop;
        }
        return;
    }

    for (const el of candidates) {
        if (!el.dataset) continue;

        if (el.dataset.nestorPatchedTop === '1') {
            el.style.top = `${currentTitlebarH}px`;
            continue;
        }

        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.top !== '0px') continue;

        const r = el.getBoundingClientRect();
        if (r.height > window.innerHeight * 0.9) continue;

        el.style.top = `${currentTitlebarH}px`;
        el.dataset.nestorPatchedTop = '1';
    }
}

function ensureTitlebarPlacement() {
    const bar = document.getElementById('nestor-titlebar');
    if (!bar) return false;

    const app = document.getElementById('app');
    if (!app || !app.parentNode) return false;

    if (bar.parentNode !== app.parentNode || bar.nextSibling !== app) {
        app.parentNode.insertBefore(bar, app);
    }
    return true;
}

function ensureTitlebarInjected() {
    if (!shouldInjectTitlebar()) return;
    if (document.getElementById('nestor-titlebar')) return;

    const style = document.createElement('style');
    style.id = 'nestor-titlebar-style';
    style.textContent = `
#nestor-titlebar {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: var(--nestor-titlebar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  z-index: 2147483647;
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(0,0,0,0.08);
  user-select: none;
}

#nestor-drag {
  position: absolute;
  inset: 0;
  -webkit-app-region: drag;
  z-index: 0;
}

#nestor-left, #nestor-right {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 220px;
}

#nestor-right { justify-content: flex-end; }

.nestor-btn, .nestor-traffic { -webkit-app-region: no-drag; cursor: pointer; pointer-events: auto; }
#nestor-titlebar svg, #nestor-titlebar svg * { pointer-events: none; }

#nestor-config-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 10px;
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(245,245,245,0.95);
  color: #111;
  font-size: 13px;
}
#nestor-config-btn:hover { background: rgba(235,235,235,0.95); }

.nestor-traffic {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.18);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
}

.t-red { background: #ff5f57; }
.t-yellow { background: #febc2e; }
.t-green { background: #28c840; }

.nestor-traffic svg { opacity: 0; transition: opacity 120ms ease; }
.nestor-traffic:hover svg,
.nestor-traffic:active svg,
.nestor-traffic:focus-visible svg { opacity: 1; }
`;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'nestor-titlebar';

    const drag = document.createElement('div');
    drag.id = 'nestor-drag';

    const left = document.createElement('div');
    left.id = 'nestor-left';

    const right = document.createElement('div');
    right.id = 'nestor-right';

    const cfgBtn = document.createElement('button');
    cfgBtn.id = 'nestor-config-btn';
    cfgBtn.className = 'nestor-btn';
    cfgBtn.innerHTML = `
<svg viewBox="0 0 24 24" fill="none" width="16" height="16">
  <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" stroke-width="2"/>
  <path d="M19.4 13.1v-2.2l-2-.7a7.7 7.7 0 0 0-.6-1.4l.9-1.9-1.6-1.6-1.9.9c-.5-.2-1-.5-1.4-.6l-.7-2H10.9l-.7 2c-.5.1-1 .3-1.4.6l-1.9-.9-1.6 1.6.9 1.9c-.2.5-.5 1-.6 1.4l-2 .7v2.2l2 .7c.1.5.3 1 .6 1.4l-.9 1.9 1.6 1.6 1.9-.9c.5.2 1 .5 1.4.6l.7 2h2.2l.7-2c.5-.1 1-.3 1.4-.6l1.9.9 1.6-1.6-.9-1.9c.2-.5.5-1 .6-1.4l2-.7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
</svg>
<span>Configuración</span>
`;

    const btnClose = document.createElement('button');
    btnClose.className = 'nestor-traffic t-red';
    btnClose.title = 'Cerrar';
    btnClose.innerHTML = `<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3L3 9" stroke="rgba(0,0,0,0.65)" stroke-width="1.6" stroke-linecap="round"/></svg>`;

    const btnMin = document.createElement('button');
    btnMin.className = 'nestor-traffic t-yellow';
    btnMin.title = 'Minimizar';
    btnMin.innerHTML = `<svg viewBox="0 0 12 12"><path d="M3 6h6" stroke="rgba(0,0,0,0.65)" stroke-width="1.6" stroke-linecap="round"/></svg>`;

    const btnMax = document.createElement('button');
    btnMax.className = 'nestor-traffic t-green';
    btnMax.title = 'Maximizar';
    btnMax.innerHTML = `<svg viewBox="0 0 12 12"><path d="M3.2 3.2h5.6v5.6H3.2z" stroke="rgba(0,0,0,0.65)" stroke-width="1.4" fill="none"/></svg>`;

    cfgBtn.addEventListener('click', () => invoke('win:open-config'));
    btnClose.addEventListener('click', () => invoke('win:close'));
    btnMin.addEventListener('click', () => invoke('win:minimize'));
    btnMax.addEventListener('click', () => invoke('win:toggle-fullscreen'));

    left.appendChild(cfgBtn);
    right.appendChild(btnClose);
    right.appendChild(btnMin);
    right.appendChild(btnMax);

    bar.appendChild(drag);
    bar.appendChild(left);
    bar.appendChild(right);

    document.body.appendChild(bar);
    updateConfigBtnVisibility();
}

function updateConfigBtnVisibility() {
    const btn = document.getElementById('nestor-config-btn');
    if (!btn) return;
    btn.style.display = isPosRoute() ? 'none' : '';
}

function setTitlebarVisible(visible) {
    if (visible) ensureTitlebarInjected();

    const bar = document.getElementById('nestor-titlebar');
    if (bar) bar.style.display = visible ? 'flex' : 'none';

    setTitlebarHeight(visible ? TITLEBAR_H : 0);

    ensureTitlebarPlacement();
    applyAppLayout();
}

let lastTitlebarVisible = null;

// Se llama en cada render del SPA: solo toca el DOM cuando cambió la ruta.
function syncTitlebarForRoute() {
    const visible = shouldShowTitlebar();
    if (visible === lastTitlebarVisible) return;
    lastTitlebarVisible = visible;
    setTitlebarVisible(visible);
}

function applyWindowMode(mode) {
    lastTitlebarVisible = shouldShowTitlebar();
    setTitlebarVisible(lastTitlebarVisible);
}

// vue-router navega con pushState y eso no dispara popstate. Parchear
// history.pushState desde aquí no sirve: con contextIsolation el preload vive
// en un mundo aparte y el parche no lo ve la página. Los eventos DOM sí cruzan,
// y para pushState nos queda vigilar el pathname (barato: comparar strings).
let routeWatchTimer = null;

function watchSpaNavigation() {
    window.addEventListener('popstate', () => syncTitlebarForRoute());
    window.addEventListener('hashchange', () => syncTitlebarForRoute());

    if (routeWatchTimer) return;
    routeWatchTimer = setInterval(() => syncTitlebarForRoute(), 300);
}

function startAppWatcher() {
    if (appObserver || appReadyTimer) return;

    const tryAttach = () => {
        const app = document.getElementById('app');
        if (!app) return;

        clearInterval(appReadyTimer);
        appReadyTimer = null;

        ensureTitlebarPlacement();
        applyAppLayout();

        appObserver = new MutationObserver(() => {
            clearTimeout(renderDebounce);
            renderDebounce = setTimeout(() => {
                syncTitlebarForRoute();
                ensureTitlebarPlacement();
                applyAppLayout();
                updateConfigBtnVisibility();
            }, 30);
        });

        appObserver.observe(app, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });

        window.addEventListener('resize', () => applyAppLayout());
        window.addEventListener('popstate', () => updateConfigBtnVisibility());
        syncTitlebarForRoute();
    };

    appReadyTimer = setInterval(tryAttach, 100);
    tryAttach();
}

ipcRenderer.on('win:mode-changed', (event, mode) => {
    try {
        // log('[ipc event] win:mode-changed', mode);
        applyWindowMode(mode || {});
    } catch { }
});

async function recheckWindowMode(times) {
    let left = times;

    const tick = async () => {
        left -= 1;
        try {
            const mode = await invoke('win:get-mode');
            applyWindowMode(mode || {});
            if (left <= 0) return;
        } catch {
            if (left <= 0) return;
        }
        setTimeout(tick, 250);
    };

    setTimeout(tick, 250);
}

async function bootstrap() {
    ensureBaseStyle();
    watchSpaNavigation();
    startAppWatcher();

    try {
        const mode = await invoke('win:get-mode');
        applyWindowMode(mode || {});
    } catch {
        applyWindowMode({ fullscreen: false, kiosk: false });
    }

    // Fullscreen/kiosk se aplica después de DOMContentLoaded (ready-to-show),
    // así que hacemos un recheck corto por si el evento llega tarde.
    await recheckWindowMode(3);

    const allowExit = process.env.NESTOR_ALLOW_EXIT === '1';
    if (allowExit) {
        window.addEventListener('keydown', (e) => {
            try {
                const key = String(e.key || '').toLowerCase();
                const ctrlOrCmd = e.ctrlKey || e.metaKey;
                if (ctrlOrCmd && e.altKey && e.shiftKey && key === 'q') {
                    e.preventDefault();
                    invoke('win:exit-fullscreen-kiosk');
                }
            } catch { }
        }, true);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    bootstrap();
});
