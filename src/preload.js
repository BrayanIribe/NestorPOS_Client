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
