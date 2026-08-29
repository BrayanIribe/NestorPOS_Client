const { app, session, BrowserWindow, ipcMain, Menu, globalShortcut, dialog, shell } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { startLocalFrontendServer } = require('./proxy');
const ledger = require('./ledger');
const xhr = require('./xhr.capture');
const posError = require('./pos.error');
const services = require('./services.watchdog');

app.commandLine.appendSwitch('disable-http-cache');

// Autoplay CON audio sin exigir un gesto del usuario.
//
// Chromium bloquea por defecto la reproducción con sonido hasta que el usuario interactúa
// con la página, y NO existe un permiso que se pueda pedir por API para eso. En un
// navegador normal la única salida es capturar un gesto (el checador de precios muestra un
// aviso de "toca para activar el sonido" y también se desbloquea con el primer escaneo).
//
// Aquí no hace falta: esta app ES el equipo del negocio, en modo kiosco, y la política de
// autoplay se concede de una vez en el arranque. Con esto la propaganda digital del
// Checador de Precios se reproduce con audio desde el primer video, sin que nadie toque
// nada.
//
// Va en DOS lugares a propósito: el switch de línea de comandos cubre todo el proceso
// (incluidos los webContents que no creamos nosotros) y `webPreferences.autoplayPolicy`
// —más abajo, en cada BrowserWindow— es la garantía a nivel de ventana si un build de
// Electron cambiara el manejo del switch.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:8180';
const LOCAL_FRONT_PORT = parseInt(process.env.NESTOR_FRONT_PORT || '18180', 10);
const LOCAL_FRONT_URL = `http://127.0.0.1:${LOCAL_FRONT_PORT}`;

// ── Una sola instancia por equipo ───────────────────────────────────────────
//
// Dos clientes abiertos a la vez se pelean el puerto 18180 y el perfil de Electron, y el
// que pierde queda inservible SIN DARSE CUENTA: la ventana entera en pantalla y todas las
// peticiones muriendo con ERR_CONNECTION_REFUSED (ver la nota de `/__client/ping` en
// proxy.js). Es el doble clic de siempre en el acceso directo, o el Launcher abriendo
// encima de una sesión que ya estaba.
//
// El candado es de Electron y se ata al `userData`, que es justo el recurso que se
// disputan. NESTOR_SINGLE_INSTANCE=0 lo apaga (dos clientes deliberados en el mismo
// equipo necesitan además NESTOR_FRONT_PORT distinto y otro perfil).
const SINGLE_INSTANCE = (process.env.NESTOR_SINGLE_INSTANCE || '1') !== '0';

// Reintentos del candado: el relanzamiento del auto-update arranca el proceso nuevo
// mientras el viejo todavía se está muriendo, así que no obtenerlo en el primer intento es
// normal y no significa "ya hay otro cliente abierto".
const INSTANCE_LOCK_RETRIES = Math.max(0, parseInt(process.env.NESTOR_INSTANCE_LOCK_RETRIES || '8', 10));
const INSTANCE_LOCK_WAIT_MS = Math.max(50, parseInt(process.env.NESTOR_INSTANCE_LOCK_WAIT_MS || '250', 10));

// Cuánto se insiste cuando el candado está tomado pero NADIE contesta en el puerto local
// (un proceso anterior que se está muriendo). Ver acquireInstanceLock.
const INSTANCE_LOCK_GHOST_WAIT_MS = Math.max(0, parseInt(process.env.NESTOR_INSTANCE_LOCK_GHOST_MS || '15000', 10));

// ── Reemplazar la ventana anterior ─────────────────────────────────────────
//
// Abrir el acceso directo con el POS ya abierto es, casi siempre, un doble clic de más:
// la respuesta correcta es traer al frente la ventana que ya está trabajando, sin
// molestar a nadie. Pero hay un caso real en el que eso no alcanza —la ventana anterior
// quedó inservible (colgada, fuera de pantalla, en un escritorio virtual que ya no
// existe)— y ahí el cajero se queda sin forma de abrir la caja: cada intento "no hace
// nada".
//
// La señal de que estamos en ese caso es que el usuario INSISTE. Así que el primer
// intento enfoca y calla; si vuelve a lanzar dentro de esta ventana de tiempo, se le
// ofrece cerrar la anterior y quedarse con la nueva, DICIÉNDOLE qué se pierde.
//
// NESTOR_REPLACE_PROMPT=always pregunta desde el primer intento; =never nunca ofrece
// reemplazo (comportamiento de sólo enfocar).
const REPLACE_PROMPT_MODE = String(process.env.NESTOR_REPLACE_PROMPT || 'insist').toLowerCase();
const REPLACE_ATTEMPT_WINDOW_MS = Math.max(5000, parseInt(process.env.NESTOR_REPLACE_WINDOW_MS || '45000', 10));
// Plazo para que la instancia anterior se cierre por su cuenta tras pedírselo.
const REPLACE_HANDOVER_MS = Math.max(2000, parseInt(process.env.NESTOR_REPLACE_HANDOVER_MS || '12000', 10));

// Identidad de ESTE proceso como dueño del puerto local. El nonce se rifa en cada
// arranque: es lo que distingue "mi express contesta" de "contesta el express de otro
// proceso" cuando los dos están pegados al mismo puerto.
const LOCAL_SERVER_ID = {
    app: 'nestorpos_client',
    pid: process.pid,
    nonce: crypto.randomBytes(12).toString('hex'),
    port: LOCAL_FRONT_PORT
};

// Cada cuánto se comprueba que el servidor local siga contestando (0 = apagar).
const LOCAL_SERVER_WATCH_MS = Math.max(0, parseInt(process.env.NESTOR_LOCAL_WATCH_MS || '20000', 10));
const LOCAL_SERVER_PROBE_TIMEOUT_MS = 2500;

// Modo desarrollo: carga el frontend desde el dev server de Vue en vez del
// bundle que publica el backend en /__front. El dev server no tiene ese
// endpoint (lo sirve el Go embebiendo el build), así que en dev se salta toda
// la descarga, el borrado por cambio de build y el sondeo de versión.
//   NESTOR_DEV_URL=http://127.0.0.1:8081 npm start
// El origen del servidor (NESTOR_SERVER) sigue apuntando al backend: el dev
// server ya proxya /api hacia él (vue.config.js).
const DEV_URL = String(process.env.NESTOR_DEV_URL || '').trim().replace(/\/+$/, '');
const IS_DEV = !!DEV_URL;

// Fullscreen por defecto (puedes apagarlo con NESTOR_FULLSCREEN=0)
const START_FULLSCREEN = (process.env.NESTOR_FULLSCREEN || '1') === '1';

// Kiosk opcional (NESTOR_KIOSK=1) => fullscreen “POS real”
const START_KIOSK = process.env.NESTOR_KIOSK === '1';

// Atajos ocultos (solo soporte/QA) (NESTOR_ALLOW_EXIT=1)
const ALLOW_EXIT_SHORTCUTS = true; // process.env.NESTOR_ALLOW_EXIT === '1';

// Cada cuánto se sondea /__front/version.json para detectar que el servidor
// cambió de build (0 = apagar el sondeo).
const VERSION_PING_MS = Math.max(0, parseInt(process.env.NESTOR_VERSION_PING_MS || '5000', 10));
const VERSION_PING_TIMEOUT_MS = 4000;

// Al detectar build nueva se borran datos y caché y se recarga solo.
const AUTO_UPDATE_ON_BUILD_CHANGE = (process.env.NESTOR_AUTO_UPDATE || '1') === '1';

// El borrado automático NO toca la sesión: obligar a re-loguear al cajero en
// cada actualización del servidor es peor que dejar el token. NESTOR_UPDATE_KEEP_SESSION=0
// lo iguala al botón manual de "Eliminar datos y caché", que sí cierra sesión.
const KEEP_SESSION_ON_AUTO_CLEAR = (process.env.NESTOR_UPDATE_KEEP_SESSION || '1') !== '0';

// Borradores y cola de tickets pendientes del POS. El frontend ya los protege
// cuando limpia sesión por 401 (services/api/http.js): borrarlos tira ventas
// capturadas que aún no llegan al servidor. El auto-borrado los respeta igual.
const POS_DRAFT_KEYS = ['pos_draft_v1', 'pos_ticket_draft_v1', 'pos_ticket_outbox_v1'];
const SESSION_KEYS = ['x-access-token'];

let mainWindow = null;
let configWindow = null;
let localServer = null;
let serverOrigin = DEFAULT_SERVER_ORIGIN;
let savedZoomFactor = 1.0;

// Estado del servidor local (el express de proxy.js). `null` en `listening` = todavía no
// se ha comprobado. Lo mantiene ensureLocalServer() y lo lee el renderer por IPC.
let localServerState = { listening: null, foreign: false, error: '', checkedAt: 0, repairs: 0, since: 0 };
let localServerTimer = null;
let localServerBusy = null;   // promesa en curso: las comprobaciones no se apilan
let shuttingDown = false;     // apaga la vigilancia para que no reviva el puerto al salir

// Build que corresponde al código cargado ahora mismo en la ventana.
let currentBuildId = null;
let versionTimer = null;
let updateInFlight = false;

// ── Gate del POS sobre el auto-update ──────────────────────────────────────
// El auto-update por cambio de build recarga la ventana. Hacerlo a media venta
// le tumba la pantalla al cajero, así que mientras el POS esté al frente NO se
// aplica solo: se difiere y el propio POS lo dispara por `nestor:clear-cache`
// cuando la caja está ociosa (cuenta vacía, sin cola de tickets, sin modales).
//
// Fail-safe hacia el comportamiento de siempre: el gate sólo cuenta si el POS lo
// tomó explícitamente (IPC `nestor:update-gate`), sigue en la ruta /pos y su
// último latido es reciente. Un frontend viejo —que no sabe de esto— nunca lo
// toma, y entonces el cliente se actualiza como antes. Una ventana colgada deja
// de renovarlo y el gate caduca sola.
const POS_GATE_TTL_MS = 90 * 1000;
let posUpdateGate = { active: false, at: 0 };

// Build nueva detectada pero NO aplicada por el gate, y la última que ya se
// anunció al renderer (para no repetir el evento en cada ping).
let deferredBuildId = '';
let announcedBuildId = '';

function getWinMode(win) {
    if (!win) return { fullscreen: false, kiosk: false, simple: false };
    const isMac = process.platform === 'darwin';
    const simple = isMac ? !!win.isSimpleFullScreen() : false;
    const fullscreen = !!win.isFullScreen() || simple;
    const kiosk = !!win.isKiosk();
    return { fullscreen, kiosk, simple };
}

function notifyWinMode(win) {
    try {
        if (!win || win.isDestroyed()) return;
        win.webContents.send('win:mode-changed', getWinMode(win));
    } catch { }
}

function enforceMacNoTrafficLights(win) {
    if (process.platform !== 'darwin') return;
    if (!win || win.isDestroyed()) return;

    try { win.setWindowButtonVisibility(false); } catch { }

    // En algunos builds, macOS vuelve a mostrar temporalmente los "semaforos"
    // al salir de fullscreen. Esto los saca del viewport.
    try {
        if (typeof win.setTrafficLightPosition === 'function') {
            win.setTrafficLightPosition({ x: -1000, y: -1000 });
        }
    } catch { }
}

function enforceMacNoTrafficLightsSoon(win) {
    if (process.platform !== 'darwin') return;
    if (!win || win.isDestroyed()) return;

    // Re-aplicar varias veces por transiciones de fullscreen.
    setTimeout(() => enforceMacNoTrafficLights(win), 0);
    setTimeout(() => enforceMacNoTrafficLights(win), 120);
    setTimeout(() => enforceMacNoTrafficLights(win), 400);
}

function getPaths() {
    const userData = app.getPath('userData');
    const wwwRoot = path.join(userData, 'www');
    const currentDir = path.join(wwwRoot, 'current');
    // Build anterior. Se conserva sólo para que los trozos perezosos del código que ya
    // está corriendo sigan resolviendo después de un cambio de build; ver la nota del
    // estático de respaldo en proxy.js.
    const previousDir = path.join(wwwRoot, 'previous');
    const metaPath = path.join(wwwRoot, 'frontend_meta.json');
    const clientConfigPath = path.join(userData, 'client_config.json');
    return { userData, wwwRoot, currentDir, previousDir, metaPath, clientConfigPath };
}

async function readJSON(file, def) {
    try {
        const b = await fsp.readFile(file);
        return JSON.parse(b.toString('utf-8'));
    } catch {
        return def;
    }
}

async function writeJSON(file, obj) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(obj, null, 2));
}

function normalizeServerOrigin(input) {
    let s = String(input || '').trim();
    if (!s) return DEFAULT_SERVER_ORIGIN;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/+$/, '');
    const u = new URL(s);
    if (!u.hostname) throw new Error('Invalid server origin');
    return u.toString().replace(/\/+$/, '');
}

async function loadClientConfig() {
    const { clientConfigPath } = getPaths();

    if (process.env.NESTOR_SERVER) {
        return { server_origin: normalizeServerOrigin(process.env.NESTOR_SERVER) };
    }

    const cfg = await readJSON(clientConfigPath, null);
    if (cfg && cfg.server_origin) {
        const zoom = (typeof cfg.zoom_factor === 'number' && cfg.zoom_factor >= 0.3 && cfg.zoom_factor <= 3.0)
            ? cfg.zoom_factor : 1.0;
        return { server_origin: normalizeServerOrigin(cfg.server_origin), zoom_factor: zoom };
    }
    return { server_origin: DEFAULT_SERVER_ORIGIN, zoom_factor: 1.0 };
}

async function saveClientConfig(origin) {
    const { clientConfigPath } = getPaths();
    const existing = await readJSON(clientConfigPath, {});
    const cfg = {
        ...existing,
        server_origin: normalizeServerOrigin(origin),
        updated_at: new Date().toISOString()
    };
    await writeJSON(clientConfigPath, cfg);
    return cfg;
}

async function saveZoomFactor(factor) {
    const { clientConfigPath } = getPaths();
    const cfg = await readJSON(clientConfigPath, {});
    cfg.zoom_factor = Math.round(factor * 100) / 100;
    await writeJSON(clientConfigPath, cfg);
}

async function fetchJson(url, timeoutMs) {
    const opts = { cache: 'no-store' };
    if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);

    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();

    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n${body.slice(0, 300)}`);
    if (!ct.includes('application/json')) throw new Error(`Expected JSON but got '${ct}' from ${url}\n${body.slice(0, 300)}`);
    return JSON.parse(body);
}

async function downloadBytes(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${url}\n${body.slice(0, 300)}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}

// Identidad de la build del servidor. Preferimos el commit; el hash del bundle
// (version) es el respaldo para servidores viejos que aún no lo exponen.
function buildIdOf(info) {
    if (!info) return '';
    const commit = String(info.build_commit || '').trim();
    const version = String(info.version || '').trim();
    if (!commit) return version;
    return `${commit}|${version}`;
}

async function fetchRemoteBuild(origin, timeoutMs) {
    return await fetchJson(`${origin}/__front/version.json`, timeoutMs);
}

async function ensureFrontendCached(origin) {
    const { wwwRoot, currentDir, previousDir, metaPath } = getPaths();
    await fsp.mkdir(wwwRoot, { recursive: true });

    const remoteVer = await fetchRemoteBuild(origin);
    const localMeta = await readJSON(metaPath, { version: null, server_origin: null });

    const sameServer = (localMeta.server_origin || '') === origin;
    // if (sameServer && localMeta.version === remoteVer.version) return { version: remoteVer.version };

    const bundleUrl = `${origin}${remoteVer.bundle_path}`;
    const zipBytes = await downloadBytes(bundleUrl);

    const tmpDir = path.join(wwwRoot, `tmp_${Date.now()}`);
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    const zip = new AdmZip(zipBytes);
    zip.extractAllTo(tmpDir, true);

    // Relevo del bundle: la build que se va pasa a `previous` (respaldo de los trozos
    // perezosos del código que sigue corriendo) y la nueva entra por rename atómico. Sólo
    // se guarda UNA generación: dos actualizaciones seguidas sin recargar la ventana
    // dejan a la primera sin red, y para eso está el aviso del frontend.
    await fsp.rm(previousDir, { recursive: true, force: true });
    if (fs.existsSync(currentDir)) {
        try {
            await fsp.rename(currentDir, previousDir);
        } catch (e) {
            // Si el relevo no se puede hacer (permisos, antivirus), la actualización sigue
            // su curso: perder el respaldo es un degradado, no un fallo.
            console.warn('[front cache] no se pudo conservar la build anterior:', e && e.message ? e.message : e);
            await fsp.rm(currentDir, { recursive: true, force: true });
        }
    }
    await fsp.rename(tmpDir, currentDir);

    await writeJSON(metaPath, {
        server_origin: origin,
        version: remoteVer.version,
        build_commit: remoteVer.build_commit || '',
        build_date: remoteVer.build_date || '',
        build_id: buildIdOf(remoteVer),
        updated_at: new Date().toISOString()
    });

    currentBuildId = buildIdOf(remoteVer);
    return remoteVer;
}

// Borra caché y datos locales. `frontend` tumba también el bundle descargado
// (el llamador debe volver a bajarlo o relanzar); `storages` son los que se le
// pasan a clearStorageData. localStorage NO se limpia aquí: eso se hace desde
// el renderer con purgeRendererStorage, que sí puede respetar los borradores
// del POS — clearStorageData es todo o nada.
async function clearAppData({ frontend = false, storages = ['serviceworkers', 'cachestorage'] } = {}) {
    const { wwwRoot, currentDir, previousDir, metaPath } = getPaths();
    const apiCacheDir = path.join(wwwRoot, 'api_cache');

    await fsp.rm(apiCacheDir, { recursive: true, force: true });

    if (frontend) {
        await fsp.rm(currentDir, { recursive: true, force: true });
        await fsp.rm(previousDir, { recursive: true, force: true });
        await fsp.rm(metaPath, { force: true });
    }

    try {
        await session.defaultSession.clearCache();
    } catch { }

    try {
        if (storages && storages.length) {
            await session.defaultSession.clearStorageData({ storages });
        }
    } catch { }
}

// Limpia localStorage dentro de la página, preservando las llaves que no se
// pueden perder. Se corre justo antes de recargar.
//
// `keep` explícito es lo que usa runCacheClear: cada preset decide si la sesión
// y los borradores del POS sobreviven. Sin él se cae al comportamiento del
// auto-update por cambio de build (NESTOR_UPDATE_KEEP_SESSION).
async function purgeRendererStorage(win, keep = null) {
    if (!win || win.isDestroyed()) return -1;

    const keepKeys = Array.isArray(keep)
        ? keep
        : (KEEP_SESSION_ON_AUTO_CLEAR
            ? [...POS_DRAFT_KEYS, ...SESSION_KEYS]
            : [...POS_DRAFT_KEYS]);

    const js = `(() => {
        try {
            const keep = new Set(${JSON.stringify(keepKeys)});
            const doomed = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && !keep.has(k)) doomed.push(k);
            }
            doomed.forEach((k) => localStorage.removeItem(k));
            return doomed.length;
        } catch (e) { return -1; }
    })()`;

    try {
        return await win.webContents.executeJavaScript(js, true);
    } catch {
        return -1;
    }
}

// ---------------------------------------------------------------------------
// "Borrar caché" invocable
//
// Es la misma rutina del botón rojo ("Eliminar datos y caché" de la ventana de
// Configuración), extraída para que la puedan disparar tres consumidores por el
// mismo camino:
//
//   1. El botón rojo             -> IPC `nestor:clear-data`  (preset 'full')
//   2. El auto-update por build  -> applyBuildChange()       (preset 'update')
//   3. El sistema, desde el SPA  -> IPC `nestor:clear-cache` (preset a elegir)
//
// El (3) es el que existe para que, cuando el sistema detecte una actualización
// de software, pueda vaciar el caché del cliente sin que nadie abra la ventana
// de Configuración ni toque el botón rojo:
//
//   await window.NestorClient.clearCache({ preset: 'update', reason: 'ota' })
//
// Diferencia clave entre presets: el botón rojo es un borrado TOTAL (se lleva la
// sesión del cajero y la cola de tickets del POS, y por eso reinicia la app). El
// preset 'update' NO: conserva `x-access-token` y los borradores/outbox, porque
// una actualización de software no puede costar ventas capturadas que todavía no
// llegan al servidor.
//
// NINGÚN preset toca "Ventas en local" (src/ledger.js), ni siquiera 'full'. Esa base
// vive fuera de `userData` justo para que el borrado total del botón rojo no se lleve
// el historial de ventas de la caja: lo que se borra aquí es caché y estado de sesión,
// no el registro de lo que se cobró.
//
// Banderas (todas sobreescribibles una por una desde el IPC):
//   redownload  vuelve a bajar el bundle del frontend ANTES de borrar nada
//   frontend    tira el bundle descargado y su meta (obliga a re-descargar)
//   storage     toca localStorage/IndexedDB (si es false, sólo caché)
//   session     también borra el token de sesión
//   drafts      también borra borradores y cola de tickets del POS
//   cookies     también borra cookies
//   relaunch    reinicia el proceso al terminar
//   reload      recarga la ventana ignorando caché (si no hay relaunch)
function clearPreset(name) {
    switch (String(name || '').trim()) {
        // Botón rojo: borra TODO y reinicia.
        case 'full':
            return {
                redownload: false, frontend: true, storage: true,
                session: true, drafts: true, cookies: true,
                relaunch: true, reload: false
            };

        // Sólo caché: HTTP de Electron, respuestas del proxy y service workers.
        // No toca el bundle ni el almacenamiento local.
        case 'cache':
            return {
                redownload: false, frontend: false, storage: false,
                session: false, drafts: false, cookies: false,
                relaunch: false, reload: true
            };

        // Actualización de software (default). Baja el bundle nuevo primero,
        // luego limpia, y recarga sin reiniciar el proceso.
        case 'update':
        default:
            return {
                redownload: true, frontend: false, storage: true,
                session: !KEEP_SESSION_ON_AUTO_CLEAR, drafts: false, cookies: false,
                relaunch: false, reload: true
            };
    }
}

function broadcastCacheCleared(payload) {
    for (const w of BrowserWindow.getAllWindows()) {
        try {
            if (!w.isDestroyed()) w.webContents.send('nestor:cache-cleared', payload);
        } catch { }
    }
}

// Ejecuta el borrado. Devuelve qué se borró; NO lanza salvo que falle la
// descarga del bundle (y en ese caso no se borró nada todavía: la descarga va
// primero justo para eso — si el servidor está reiniciándose, que es cuando más
// probable es que cambie la build, la app no se queda sin frontend).
async function runCacheClear(win, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const preset = opts.preset || 'update';
    const reason = String(opts.reason || 'manual');

    const cfg = clearPreset(preset);
    for (const k of Object.keys(cfg)) {
        if (typeof opts[k] === 'boolean') cfg[k] = opts[k];
    }

    // Queda anotado en la captura XHR: un borrado recarga la ventana, y sin esta marca
    // el corte de peticiones en el .har parece una caída del servidor.
    try { xhr.note('borrado-de-cache', { preset, motivo: reason }); } catch { }

    // En dev el frontend lo sirve el dev server de Vue: no hay bundle que bajar
    // ni que tirar.
    if (IS_DEV) {
        cfg.redownload = false;
        cfg.frontend = false;
    }

    // `assumeLock` lo usa el auto-update, que ya tomó el candado. Cualquier otro
    // llamador que caiga en medio de una actualización se va con busy en vez de
    // pelearse por el mismo directorio.
    const assumeLock = opts.assumeLock === true;
    if (!assumeLock) {
        if (updateInFlight) return { ok: false, busy: true, preset, reason };
        updateInFlight = true;
    }

    try {
        // El localStorage vive en el origen del servidor local, así que la
        // ventana principal es la que hay que purgar aunque el IPC venga de la
        // ventana de Configuración.
        const target = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : win;

        let bundle = null;
        let bundleError = '';
        if (cfg.redownload) {
            try {
                bundle = await ensureFrontendCached(serverOrigin);
                // Con el bundle nuevo en disco ya no hay build pendiente: si esto lo
                // disparó el POS al quedar ocioso, el watcher no debe volver a
                // anunciar la misma.
                deferredBuildId = '';
                announcedBuildId = '';
            } catch (e) {
                bundleError = e && e.message ? e.message : String(e);
                // Por defecto se propaga sin haber borrado nada: si esto venía de un
                // cambio de build, seguir adelante recargaría la MISMA build y el
                // watcher volvería a intentarlo cada 5 s, en bucle.
                //
                // `bundleOptional` es para lo que NO es una actualización: una orden de
                // "vaciar caché" del modo ingeniero pide justo eso, y no tiene por qué
                // fracasar porque el servidor no publique bundle (o porque se esté
                // reiniciando, que es cuando más falta hace). Con `frontend:false` no
                // hay nada que perder: el bundle en disco no se toca.
                if (opts.bundleOptional !== true || cfg.frontend === true) throw e;
                console.warn(`[clear-cache] no se pudo bajar el bundle (${bundleError}); `
                    + 'se limpia el caché igual (bundleOptional)');
            }
        }

        const storages = ['serviceworkers', 'cachestorage'];
        if (cfg.storage) storages.push('indexdb');
        if (cfg.cookies) storages.push('cookies');

        // clearStorageData es todo o nada con localStorage: sólo se puede usar
        // cuando de verdad se van a perder sesión Y borradores. En cualquier
        // otro caso se purga desde el renderer con lista de exclusión.
        const wipeAllLocalStorage = cfg.storage && cfg.session && cfg.drafts;
        if (wipeAllLocalStorage) storages.push('localstorage');

        // Con `redownload` el bundle ya se reemplazó de forma atómica: borrarlo
        // ahora sería tirar el que acabamos de bajar.
        await clearAppData({ frontend: cfg.frontend && !bundle, storages });

        let removedKeys = -1;
        if (cfg.storage && !wipeAllLocalStorage) {
            const keep = [
                ...(cfg.drafts ? [] : POS_DRAFT_KEYS),
                ...(cfg.session ? [] : SESSION_KEYS)
            ];
            removedKeys = await purgeRendererStorage(target, keep);
        }

        // Quedarse sin bundle y sólo recargar deja la ventana en blanco: el
        // frontend se vuelve a bajar en el arranque, así que hay que reiniciar.
        if (cfg.frontend && !bundle && !cfg.relaunch) {
            cfg.relaunch = true;
            cfg.reload = false;
        }

        const result = {
            ok: true,
            preset,
            reason,
            cleared: { ...cfg },
            build: bundle
                ? {
                    version: bundle.version || '',
                    build_commit: bundle.build_commit || '',
                    build_id: buildIdOf(bundle)
                }
                : null,
            localStorageKeysRemoved: removedKeys,
            relaunched: !!cfg.relaunch,
            reloaded: !cfg.relaunch && !!cfg.reload,
            // Se limpió, pero sin build nueva: quien llamó decide si eso le importa.
            bundleError: bundleError || ''
        };

        console.log(`[clear-cache] preset=${preset} reason=${reason} localStorage=${removedKeys} relaunch=${cfg.relaunch} reload=${result.reloaded}`);

        // Se avisa antes de recargar/reiniciar: quien invocó ya tiene la
        // respuesta del invoke, y esto es para las demás ventanas.
        broadcastCacheCleared(result);

        if (cfg.relaunch) {
            // Con retraso para que la respuesta del invoke alcance a salir; el
            // botón rojo antes salía en seco y el renderer nunca la veía.
            setTimeout(() => relaunchApp(`clear-cache ${preset}`), 150);
        } else if (cfg.reload && target && !target.isDestroyed()) {
            target.webContents.reloadIgnoringCache();
        }

        return result;
    } finally {
        if (!assumeLock) updateInFlight = false;
    }
}

async function refreshWithUpdate(win) {
    if (!win || win.isDestroyed()) return;

    // Tomamos el candado para que el watcher no dispare una actualización
    // encima de este refresh manual.
    updateInFlight = true;
    try {
        // Borrar caché de respuestas del proxy (no datos de sesión)
        const { wwwRoot } = getPaths();
        const apiCacheDir = path.join(wwwRoot, 'api_cache');
        try {
            await fsp.rm(apiCacheDir, { recursive: true, force: true });
        } catch { }

        // Intentar descargar la versión más reciente del frontend
        try {
            await ensureFrontendCached(serverOrigin);
        } catch (e) {
            console.warn('[refresh] No se pudo actualizar el frontend:', e && e.message ? e.message : e);
        }

        // Limpiar caché HTTP de Electron (NO localStorage/cookies/session)
        try {
            await session.defaultSession.clearCache();
        } catch { }

        if (!win.isDestroyed()) win.webContents.reload();
    } finally {
        updateInFlight = false;
    }
}

// Aplica una build nueva: primero baja el bundle (rename atómico) y sólo
// después borra caché y datos. Al revés, si el servidor está reiniciándose
// —que es justo cuando cambia la build— la app se quedaría sin frontend.
// Ese orden y las exclusiones (sesión, borradores del POS) los pone el preset
// 'update' de runCacheClear; aquí sólo se pasa el candado ya tomado.
async function applyBuildChange(win, remoteId) {
    const res = await runCacheClear(win, {
        preset: 'update',
        reason: 'build-change',
        assumeLock: true
    });

    console.log(`[update] datos y caché borrados (localStorage: ${res.localStorageKeysRemoved} llaves)`);

    currentBuildId = (res.build && res.build.build_id) || remoteId;
    deferredBuildId = '';
    announcedBuildId = '';
}

// Arranque: compara la build del servidor contra la que quedó registrada en
// frontend_meta.json. Si cambió, limpia caché antes de abrir la ventana.
async function clearCachesIfBuildChanged(origin) {
    const { metaPath } = getPaths();
    const localMeta = await readJSON(metaPath, null);

    let remote;
    try {
        remote = await fetchRemoteBuild(origin, VERSION_PING_TIMEOUT_MS);
    } catch {
        return false;
    }

    const remoteId = buildIdOf(remote);
    const localId = localMeta ? (localMeta.build_id || buildIdOf(localMeta)) : '';

    // Sin meta previa (primera corrida o post "eliminar datos") no hay nada
    // viejo que limpiar.
    if (!localId) return false;

    const sameServer = (localMeta.server_origin || '') === origin;
    if (localId === remoteId && sameServer) return false;

    console.log(`[update] build al arranque cambió: ${localId} -> ${remoteId}; limpiando caché`);
    await clearAppData({ frontend: true });
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL SERVIDOR LOCAL, VIGILADO
//
// Todo lo que hace la ventana pasa por el express de proxy.js en 127.0.0.1:18180: el
// frontend, el proxy de /api/v1 y la página de configuración. Hasta ahora se levantaba
// una vez en el arranque y nadie volvía a mirarlo, y resultó que puede desaparecer con la
// aplicación entera en pie (dos instancias peleándose el puerto en Windows: ver la nota de
// `/__client/ping` en proxy.js). Sin nadie escuchando, cada petición muere con
// ERR_CONNECTION_REFUSED y el cajero sólo ve "error de red" — para siempre, porque nada
// vuelve a intentar el `listen`.
//
// Tres piezas: la PRUEBA (probeLocalServer: ¿contesta, y contesta MI proceso?), el
// ARREGLO (ensureLocalServer: si no, volver a levantarlo) y la VIGILANCIA
// (startLocalServerWatcher + el aviso del renderer, que llega antes que cualquier ronda).
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ¿Quién contesta en el puerto local? Devuelve `mine` sólo si el nonce es el de este
 * proceso; `foreign` si contesta un express que no es el nuestro (otra instancia del
 * cliente, o un programa distinto ocupando el puerto).
 */
async function probeLocalServer(timeoutMs = LOCAL_SERVER_PROBE_TIMEOUT_MS) {
    try {
        const body = await fetchJson(`${LOCAL_FRONT_URL}/__client/ping`, timeoutMs);
        const mine = !!body && body.nonce === LOCAL_SERVER_ID.nonce;
        return {
            ok: true,
            mine,
            foreign: !mine,
            pid: body && body.pid,
            app: (body && body.app) || '',
            error: ''
        };
    } catch (e) {
        return { ok: false, mine: false, foreign: false, error: e && e.message ? e.message : String(e) };
    }
}

function localServerPayload() {
    return {
        ok: localServerState.listening === true,
        listening: localServerState.listening,
        foreign: localServerState.foreign,
        error: localServerState.error,
        url: LOCAL_FRONT_URL,
        port: LOCAL_FRONT_PORT,
        pid: LOCAL_SERVER_ID.pid,
        repairs: localServerState.repairs,
        checkedAt: localServerState.checkedAt,
        since: localServerState.since
    };
}

function broadcastLocalServer() {
    const payload = localServerPayload();
    for (const w of BrowserWindow.getAllWindows()) {
        try {
            if (!w.isDestroyed()) w.webContents.send('nestor:local-server', payload);
        } catch { }
    }
}

// Estado del daemon de servicios (impresión y terminal EMV) hacia la ventana. Sólo se
// manda cuando cambia algo visible; de eso se encarga el propio daemon.
function broadcastServices(payload) {
    for (const w of BrowserWindow.getAllWindows()) {
        try {
            if (!w.isDestroyed()) w.webContents.send('nestor:services', payload);
        } catch { }
    }
}

/**
 * Observa las peticiones de la ventana hacia los microservicios de la caja.
 *
 * Es la compuerta automática del daemon: sin que el frontend pida nada, saber que
 * hubo tráfico hacia :8331 o :5000 hace unos segundos basta para NO reiniciar el
 * servicio que se está usando ahora mismo. Rescatar el EMV mata el proceso, y hacerlo
 * a media lectura de tarjeta mata el cobro.
 *
 * Va sobre webRequest y no sobre la captura XHR (que engancha por CDP y se desengancha
 * cuando alguien abre DevTools): esto tiene que ver TODAS las peticiones, siempre.
 */
function watchServiceTraffic() {
    try {
        session.defaultSession.webRequest.onBeforeRequest(
            { urls: ['http://127.0.0.1:8331/*', 'http://localhost:8331/*', 'http://127.0.0.1:5000/*', 'http://localhost:5000/*'] },
            (details, callback) => {
                try { services.noteTraffic(details.url); } catch { }
                callback({});
            }
        );
    } catch (e) {
        console.warn('[servicios] no se pudo observar el tráfico local:', e && e.message ? e.message : e);
    }
}

// Anota el estado y avisa al renderer SÓLO cuando cambia algo que se ve (si escucha o no,
// y si el puerto es de otro). Así la ronda periódica no manda un evento cada 20 s.
function setLocalServerState(patch) {
    const before = `${localServerState.listening}|${localServerState.foreign}`;
    Object.assign(localServerState, patch, { checkedAt: Date.now() });
    const after = `${localServerState.listening}|${localServerState.foreign}`;
    if (before !== after) {
        if (localServerState.listening === true) localServerState.since = Date.now();
        broadcastLocalServer();
    }
}

// Levanta el express. Cierra antes el handle anterior: si quedó a medias (bound pero sin
// aceptar), reusarlo es justo el bug que esto arregla.
async function listenLocalServer() {
    const { currentDir, previousDir } = getPaths();

    if (localServer) {
        const old = localServer;
        localServer = null;
        await new Promise((resolve) => {
            try {
                old.close(() => resolve());
                // `close()` deja de aceptar y libera el puerto, pero no termina hasta que
                // se cierran las conexiones vivas — y la ventana mantiene keep-alive. Se
                // cortan: aquí se llega sólo cuando ese servidor ya no contesta, así que
                // no hay nada que preservar y sí un puerto que liberar cuanto antes.
                if (typeof old.closeAllConnections === 'function') old.closeAllConnections();
            } catch { resolve(); }
            setTimeout(resolve, 1000);
        });
    }

    const server = await startLocalFrontendServer(currentDir, () => serverOrigin, {
        previousDir,
        identity: Object.assign({}, LOCAL_SERVER_ID, { version: app.getVersion() }),
        // Lo que una instancia nueva necesita saber para advertir bien antes de ofrecer
        // cerrar a ésta: ¿hay ventana?, ¿está en el POS?, ¿el POS está trabajando?
        status: () => {
            const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            return {
                has_window: !!win,
                pos_route: isOnPosRoute(win),
                pos_gate: posGateHolds(win)
            };
        }
    });

    // Si el socket se cae por su cuenta, la próxima ronda tiene que volver a levantarlo.
    server.on('close', () => {
        if (shuttingDown || localServer !== server) return;
        console.warn('[local] el servidor local se cerró solo; se reintentará');
        setLocalServerState({ listening: false, error: 'el servidor local se cerró' });
        ensureLocalServer('close').catch(() => { });
    });

    localServer = server;
    return server;
}

/**
 * Garantiza que el puerto local sea NUESTRO y esté contestando. Idempotente y barata
 * cuando todo está bien (una petición a /__client/ping).
 *
 * Se serializa en `localServerBusy`: el renderer puede avisar de diez peticiones caídas a
 * la vez y aquí se atiende una sola vez.
 */
function ensureLocalServer(reason = 'check') {
    if (localServerBusy) return localServerBusy;

    localServerBusy = (async () => {
        if (shuttingDown) return localServerPayload();

        let first = await probeLocalServer();
        // Segunda oportunidad antes de concluir nada. El proceso principal hace trabajo
        // síncrono largo (descomprimir el bundle de 11-30 MB con AdmZip bloquea el bucle
        // de eventos varios segundos), y ahí el propio sondeo se vence sin que el servidor
        // tenga nada de malo. Declararlo caído por eso sería CERRAR un express vivo y
        // tirarle las peticiones en vuelo a la ventana: el remedio peor que la enfermedad.
        if (!first.ok) {
            await sleep(300);
            first = await probeLocalServer();
        }
        if (first.mine) {
            setLocalServerState({ listening: true, foreign: false, error: '' });
            return localServerPayload();
        }

        if (first.foreign) {
            // Contesta un express que no es el mío. No se toca el puerto: quien manda es
            // el otro proceso, y el nuestro no puede servir nada. Con el candado de
            // instancia única esto sólo pasa con un cliente zombi (o una versión vieja).
            console.error(`[local] el puerto ${LOCAL_FRONT_PORT} lo tiene otro proceso `
                + `(${first.app || 'desconocido'} pid ${first.pid || '?'}); motivo=${reason}`);
            setLocalServerState({
                listening: false,
                foreign: true,
                error: `el puerto ${LOCAL_FRONT_PORT} lo tiene otro proceso (pid ${first.pid || '?'})`
            });
            return localServerPayload();
        }

        // Nadie contesta: hay que levantarlo. Varios intentos porque el puerto puede
        // estar liberándose todavía (una instancia que acaba de salir).
        console.warn(`[local] nadie contesta en ${LOCAL_FRONT_URL} (motivo=${reason}): ${first.error}`);

        let lastError = first.error;
        for (let intento = 1; intento <= 3; intento++) {
            try {
                await listenLocalServer();
                const after = await probeLocalServer();
                if (after.mine) {
                    localServerState.repairs++;
                    console.log(`[local] servidor local restablecido (intento ${intento}, motivo=${reason})`);
                    setLocalServerState({ listening: true, foreign: false, error: '' });
                    return localServerPayload();
                }
                if (after.foreign) {
                    setLocalServerState({
                        listening: false,
                        foreign: true,
                        error: `el puerto ${LOCAL_FRONT_PORT} lo tiene otro proceso (pid ${after.pid || '?'})`
                    });
                    return localServerPayload();
                }
                lastError = after.error || 'el servidor no contesta después de levantarlo';
            } catch (e) {
                lastError = e && e.message ? e.message : String(e);
                console.warn(`[local] no se pudo levantar el servidor local (intento ${intento}): ${lastError}`);
            }
            if (intento < 3) await sleep(400);
        }

        // EADDRINUSE con nadie contestando el ping: el puerto está tomado por un socket
        // que no sirve peticiones (una instancia colgada, o un programa ajeno). Se
        // reporta como ajeno igual: no es algo que este proceso pueda arreglar solo.
        const ocupado = /EADDRINUSE/i.test(String(lastError));
        setLocalServerState({
            listening: false,
            foreign: ocupado,
            error: ocupado ? `el puerto ${LOCAL_FRONT_PORT} está ocupado (EADDRINUSE)` : lastError
        });
        return localServerPayload();
    })().finally(() => { localServerBusy = null; });

    return localServerBusy;
}

function startLocalServerWatcher() {
    if (localServerTimer) {
        clearInterval(localServerTimer);
        localServerTimer = null;
    }
    if (!LOCAL_SERVER_WATCH_MS) return;

    localServerTimer = setInterval(() => {
        if (shuttingDown) return;
        ensureLocalServer('ronda').catch(() => { });
    }, LOCAL_SERVER_WATCH_MS);
    if (localServerTimer.unref) localServerTimer.unref();
}

function stopLocalServerWatcher() {
    if (localServerTimer) clearInterval(localServerTimer);
    localServerTimer = null;
}

// Salida ordenada: apaga la vigilancia (para que nadie reviva el puerto a media salida) y
// cierra las bitácoras. `app.exit(0)` NO dispara `will-quit`, así que sin esto cada
// relanzamiento del auto-update dejaba la captura XHR sin cerrar —el `.har` quedaba
// inválido, con su `_fin` anexado a la fuerza en el arranque siguiente— y el WAL de la
// base de ventas sin consolidar.
function shutdownForExit(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[salida] ${reason}`);
    stopLocalServerWatcher();
    try { if (versionTimer) clearInterval(versionTimer); } catch { }
    versionTimer = null;
    try { if (localServer) localServer.close(); } catch { }
    localServer = null;
    try { globalShortcut.unregisterAll(); } catch { }
    try { services.shutdown(); } catch { }
    try { xhr.shutdown(); } catch { }
    try { ledger.shutdown(); } catch { }
    try { posError.shutdown(); } catch { }
}

// Reinicio de la aplicación. Suelta el candado de instancia única ANTES de relanzar: el
// proceso nuevo lo pide mientras este todavía se está muriendo, y si lo encuentra tomado
// se sale — la app no volvería a abrir después de una actualización.
function relaunchApp(reason) {
    shutdownForExit(`relanzamiento (${reason})`);
    try { if (SINGLE_INSTANCE) app.releaseSingleInstanceLock(); } catch { }
    app.relaunch();
    app.exit(0);
}

// ¿La ventana está parada en el POS? Se lee del webContents y no de lo que
// declare el renderer: vue-router navega con pushState y eso sí se refleja aquí.
function isOnPosRoute(win) {
    try {
        if (!win || win.isDestroyed()) return false;
        const pathname = new URL(win.webContents.getURL()).pathname;
        return pathname === '/pos' || pathname.startsWith('/pos/');
    } catch {
        return false;
    }
}

// ¿Hay que diferir el auto-update? Las tres condiciones juntas; si falla
// cualquiera, el cliente se actualiza como siempre.
function posGateHolds(win) {
    if (!posUpdateGate.active) return false;
    if ((Date.now() - posUpdateGate.at) > POS_GATE_TTL_MS) return false;
    return isOnPosRoute(win);
}

function updateStatusPayload() {
    return {
        available: !!deferredBuildId && deferredBuildId !== currentBuildId,
        currentBuildId: currentBuildId || '',
        remoteBuildId: deferredBuildId || '',
        deferred: !!deferredBuildId,
        gate: { active: !!posUpdateGate.active, at: posUpdateGate.at }
    };
}

function announceUpdateAvailable(win, remoteId) {
    if (announcedBuildId === remoteId) return;
    announcedBuildId = remoteId;

    console.log(`[update] build nueva diferida por el POS: ${currentBuildId || '(sin frontend)'} -> ${remoteId}`);
    try {
        if (win && !win.isDestroyed()) {
            win.webContents.send('nestor:update-available', updateStatusPayload());
        }
    } catch { }
}

async function checkForBuildChange(win) {
    if (!AUTO_UPDATE_ON_BUILD_CHANGE) return;
    if (updateInFlight) return;
    if (!win || win.isDestroyed()) return;

    let remote;
    try {
        remote = await fetchRemoteBuild(serverOrigin, VERSION_PING_TIMEOUT_MS);
    } catch {
        // Servidor caído, reiniciándose o sin red: reintentamos al próximo ping.
        return;
    }

    const remoteId = buildIdOf(remote);
    if (!remoteId) return;

    // Sin baseline en memoria (el arranque no pudo hablar con el servidor):
    // lo tomamos del meta en disco en vez de adoptar el remoto a ciegas, o el
    // cliente se quedaría pegado en la build vieja para siempre.
    if (currentBuildId === null) {
        const meta = await readJSON(getPaths().metaPath, null);
        currentBuildId = meta ? (meta.build_id || buildIdOf(meta)) : '';
    }

    // Si además arrancó sin bundle (servidor caído en el arranque), hay que
    // bajarlo aunque la build no haya cambiado.
    const haveFrontend = fs.existsSync(path.join(getPaths().currentDir, 'index.html'));
    if (remoteId === currentBuildId && haveFrontend) {
        // La build volvió a coincidir (o ya se aplicó): no queda nada diferido.
        deferredBuildId = '';
        announcedBuildId = '';
        return;
    }

    // El POS está al frente: se anota la build y se le avisa, pero la recarga la
    // decide él. Excepción: sin bundle no hay nada que proteger —la ventana ya
    // está rota— así que ahí se aplica igual.
    if (haveFrontend && posGateHolds(win)) {
        deferredBuildId = remoteId;
        announceUpdateAvailable(win, remoteId);
        return;
    }

    updateInFlight = true;
    try {
        console.log(`[update] build cambió: ${currentBuildId || '(sin frontend)'} -> ${remoteId}`);
        await applyBuildChange(win, remoteId);
    } catch (e) {
        console.warn('[update] falló, se reintenta en el próximo ping:', e && e.message ? e.message : e);
    } finally {
        updateInFlight = false;
    }
}

function startVersionWatcher(win) {
    if (versionTimer) {
        clearInterval(versionTimer);
        versionTimer = null;
    }
    if (!VERSION_PING_MS || !AUTO_UPDATE_ON_BUILD_CHANGE) return;

    versionTimer = setInterval(() => {
        checkForBuildChange(win).catch(() => { });
    }, VERSION_PING_MS);
}

function createMainWindow() {
    const isMac = process.platform === 'darwin';
    const wantKiosk = START_KIOSK;
    const wantFullscreen = START_FULLSCREEN || wantKiosk;

    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 980,
        minHeight: 640,

        // En mac: si vamos a fullscreen/kiosk, mejor sin frame para evitar titlebar.
        frame: false,
        titleBarStyle: isMac ? 'hidden' : undefined,

        autoHideMenuBar: true,
        backgroundColor: '#111111',
        title: 'Nestor POS',
        show: false,

        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true,
            // La propaganda digital del Checador de Precios se reproduce con audio sin
            // exigir un gesto del usuario. Ver el comentario del switch de autoplay
            // al inicio de este archivo.
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    win.setMenuBarVisibility(false);
    enforceMacNoTrafficLights(win);

    // Captura de sesiones XHR: se engancha ANTES del loadURL para que el primer
    // /auth/check y el propio login queden dentro. Ver src/xhr.capture.js.
    xhr.attach(win.webContents, 'principal');

    win.webContents.on('did-finish-load', () => notifyWinMode(win));

    win.loadURL(IS_DEV ? `${DEV_URL}/` : `http://127.0.0.1:${LOCAL_FRONT_PORT}/`);

    win.once('ready-to-show', () => {
        if (wantKiosk) {
            win.setKiosk(true);
        } else if (wantFullscreen) {
            if (isMac) win.setSimpleFullScreen(true);
            else win.setFullScreen(true);
        }

        if (savedZoomFactor !== 1.0) {
            win.webContents.setZoomFactor(savedZoomFactor);
        }

        enforceMacNoTrafficLightsSoon(win);
        notifyWinMode(win);
        win.show();
    });

    try {
        win.on('enter-full-screen', () => { enforceMacNoTrafficLightsSoon(win); notifyWinMode(win); });
        win.on('leave-full-screen', () => { enforceMacNoTrafficLightsSoon(win); notifyWinMode(win); });
        win.on('enter-html-full-screen', () => { enforceMacNoTrafficLightsSoon(win); notifyWinMode(win); });
        win.on('leave-html-full-screen', () => { enforceMacNoTrafficLightsSoon(win); notifyWinMode(win); });
    } catch { }

    // Interceptar window.location.reload() desde el renderer. En dev no: el
    // HMR del dev server recarga solo y no hay bundle que volver a bajar.
    if (!IS_DEV) {
        win.webContents.on('will-navigate', (event, url) => {
            try {
                const curr = new URL(win.webContents.getURL());
                const next = new URL(url);
                if (curr.origin === next.origin && curr.pathname === next.pathname) {
                    event.preventDefault();
                    refreshWithUpdate(win);
                }
            } catch { }
        });
    }

    // Navegación cancelada por un beforeunload del renderer. Electron NO muestra el
    // diálogo de Chromium: si nadie atiende este evento, la página simplemente NO se
    // descarga y el renderer se queda donde estaba, sin enterarse — su
    // `window.location.href = ...` no lanza ni devuelve nada.
    //
    // Así se perdieron nueve ventas el 20/ago/2026 (Victoria caja 2): el POS cerró sesión
    // en el servidor y su navegación a /login se quedó aquí, en silencio, con la pantalla
    // del POS entera y ya sin sesión. NO se hace preventDefault a propósito —el guard sigue
    // valiendo, es lo que protege una transferencia o un ajuste a medias— pero queda
    // anotado: este era el único punto donde el fallo era completamente invisible.
    win.webContents.on('will-prevent-unload', () => {
        try {
            console.warn('[nav] una navegación se canceló por el beforeunload de la página:',
                win.webContents.getURL());
        } catch { }
    });

    // Interceptar Ctrl+R / Cmd+R y atajos de zoom como navegador
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;

        // Alt+F4 (Windows/Linux) → cerrar ventana
        if (input.alt && input.key === 'F4') {
            event.preventDefault();
            win.close();
            return;
        }

        // F10: toggle fullscreen/kiosk, pero solo si NO estamos en /pos
        if (input.key === 'F10' && !input.control && !input.meta && !input.alt && !input.shift) {
            try {
                const pathname = new URL(win.webContents.getURL()).pathname;
                if (!pathname.startsWith('/pos')) {
                    event.preventDefault();
                    if (win.isKiosk()) win.setKiosk(false);
                    if (isMac) win.setSimpleFullScreen(!win.isSimpleFullScreen());
                    else win.setFullScreen(!win.isFullScreen());
                    enforceMacNoTrafficLightsSoon(win);
                    notifyWinMode(win);
                }
                // Si estamos en /pos, no interceptar → el renderer lo recibe
            } catch { }
            return;
        }

        // Ctrl/Cmd+Alt+Shift+I → devtools. La combinación es deliberadamente
        // incómoda: en kiosco un F12 suelto lo abriría cualquier cajero por
        // accidente. Se compara input.code y no input.key porque en mac
        // Option+Shift+i no produce la letra "i".
        if (input.code === 'KeyI' && (input.control || input.meta) && input.alt && input.shift) {
            event.preventDefault();
            win.webContents.toggleDevTools();
            return;
        }

        const mod = input.control || input.meta;
        if (!mod) return;

        const key = input.key;

        // Zoom in: Ctrl/Cmd + (= o +)
        if (key === '=' || key === '+') {
            event.preventDefault();
            const next = Math.min(win.webContents.getZoomFactor() + 0.1, 3.0);
            win.webContents.setZoomFactor(next);
            savedZoomFactor = next;
            saveZoomFactor(next).catch(() => {});
            return;
        }

        // Zoom out: Ctrl/Cmd + -
        if (key === '-') {
            event.preventDefault();
            const next = Math.max(win.webContents.getZoomFactor() - 0.1, 0.3);
            win.webContents.setZoomFactor(next);
            savedZoomFactor = next;
            saveZoomFactor(next).catch(() => {});
            return;
        }

        // Reset zoom: Ctrl/Cmd + 0
        if (key === '0') {
            event.preventDefault();
            win.webContents.setZoomFactor(1.0);
            savedZoomFactor = 1.0;
            saveZoomFactor(1.0).catch(() => {});
            return;
        }

        // Reload: Ctrl/Cmd + R
        if (key === 'r') {
            event.preventDefault();

            // En dev, recarga normal contra el dev server.
            if (IS_DEV) {
                win.webContents.reloadIgnoringCache();
                return;
            }

            dialog.showMessageBox(win, {
                type: 'question',
                buttons: ['Cancelar', 'Refrescar'],
                defaultId: 1,
                cancelId: 0,
                title: 'Nestor POS',
                message: '¿Refrescar la aplicación?',
                detail: 'Se descargará el código más reciente y se limpiará el caché. Los datos de sesión se conservarán.',
            }).then(({ response }) => {
                if (response === 1) refreshWithUpdate(win);
            });
        }
    });

    return win;
}

function openConfigWindow() {
    const isMac = process.platform === 'darwin';

    if (configWindow && !configWindow.isDestroyed()) {
        configWindow.focus();
        return;
    }

    configWindow = new BrowserWindow({
        width: 680,
        height: 700,
        resizable: false,
        closable: true,
        backgroundColor: '#ffffff',
        frame: isMac ? true : false,
        titleBarStyle: isMac ? 'hidden' : undefined,

        autoHideMenuBar: true,
        parent: mainWindow || undefined,
        modal: !!mainWindow,
        title: 'Configuración $',

        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true
        }
    });

    configWindow.setMenuBarVisibility(false);
    enforceMacNoTrafficLights(configWindow);

    // La ventana no tiene marco (Windows) ni semaforos (macOS), asi que el
    // unico cierre es el que ofrece la propia pagina. Esto es la red: Esc o
    // Ctrl/Cmd+W la cierran aunque el script de la pagina no haya cargado.
    configWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;

        const isEscape = input.key === 'Escape';
        const isCloseCombo = (input.control || input.meta) && String(input.key).toLowerCase() === 'w';
        if (!isEscape && !isCloseCombo) return;

        event.preventDefault();
        if (configWindow && !configWindow.isDestroyed()) configWindow.destroy();
    });

    // ?modal=1 le dice a la pagina que se esta dibujando en esta ventana y que
    // puede ofrecer el cierre (en el primer arranque se sirve en la principal).
    configWindow.loadURL(`http://127.0.0.1:${LOCAL_FRONT_PORT}/__client/config?modal=1`);
    configWindow.on('closed', () => { configWindow = null; });
}

function removeAndHandle(channel, handler) {
    try { ipcMain.removeHandler(channel); } catch { }
    ipcMain.handle(channel, handler);
}

ipcMain.on('client:log', (event, ...args) => {
    console.log('[renderer]', ...args);
});

ipcMain.on('nestor:get-config-sync', (event) => {
    event.returnValue = {
        serverOrigin,
        localFront: `http://127.0.0.1:${LOCAL_FRONT_PORT}`,
        apiBaseUrl: `http://127.0.0.1:${LOCAL_FRONT_PORT}/api/v1`,
        // Versión del ejecutable instalado. Es EXACTAMENTE la que se publicó en Fact:
        // build.go la inyecta con `-c.extraMetadata.version=` y deploy.go sube ese mismo
        // número a /panel/v1/installers. Va por el canal SÍNCRONO a propósito — la barra
        // de estado del POS la pinta en el primer render y un `await` ahí se ve como un
        // parpadeo en cada arranque de caja.
        clientVersion: app.getVersion(),
        platform: process.platform
    };
});

function wireIpc() {
    const winFromEvent = (event) => BrowserWindow.fromWebContents(event.sender);

    removeAndHandle('win:minimize', (event) => {
        const win = winFromEvent(event);
        if (win) win.minimize();
        return { ok: true };
    });

    removeAndHandle('win:toggle-maximize', (event) => {
        const win = winFromEvent(event);
        if (!win) return { ok: false };
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return { ok: true, maximized: win.isMaximized() };
    });

    removeAndHandle('win:close', (event) => {
        const win = winFromEvent(event);
        if (!win) return { ok: false };

        // En macOS, salir de fullscreen/kiosk antes de cerrar evita que
        // la ventana quede bloqueada en la transición y no se cierre.
        if (win.isKiosk()) win.setKiosk(false);
        if (process.platform === 'darwin') {
            try { win.setSimpleFullScreen(false); } catch { }
        }
        win.setFullScreen(false);

        // Destruir directamente garantiza el cierre sin depender del evento close
        win.destroy();
        return { ok: true };
    });

    removeAndHandle('win:open-config', () => {
        openConfigWindow();
        return { ok: true };
    });

    removeAndHandle('win:is-maximized', (event) => {
        const win = winFromEvent(event);
        return { maximized: !!win && win.isMaximized() };
    });

    removeAndHandle('win:get-mode', (event) => {
        const win = winFromEvent(event);
        return getWinMode(win);
    });

    removeAndHandle('win:toggle-fullscreen', (event) => {
        const win = winFromEvent(event);
        if (!win) return { ok: false };

        if (win.isKiosk()) win.setKiosk(false);

        const isMac = process.platform === 'darwin';
        if (isMac) win.setSimpleFullScreen(!win.isSimpleFullScreen());
        else win.setFullScreen(!win.isFullScreen());

        enforceMacNoTrafficLightsSoon(win);
        notifyWinMode(win);
        return { ok: true, ...getWinMode(win) };
    });

    removeAndHandle('win:toggle-kiosk', (event) => {
        const win = winFromEvent(event);
        if (!win) return { ok: false };
        win.setKiosk(!win.isKiosk());
        enforceMacNoTrafficLightsSoon(win);
        notifyWinMode(win);
        return { ok: true, ...getWinMode(win) };
    });

    removeAndHandle('win:exit-fullscreen-kiosk', (event) => {
        const win = winFromEvent(event);
        if (!win) return { ok: false };

        if (win.isKiosk()) win.setKiosk(false);
        if (process.platform === 'darwin') win.setSimpleFullScreen(false);
        win.setFullScreen(false);

        enforceMacNoTrafficLightsSoon(win);
        notifyWinMode(win);
        return { ok: true, ...getWinMode(win) };
    });

    removeAndHandle('nestor:get-config', async () => {
        return {
            serverOrigin,
            localFront: `http://127.0.0.1:${LOCAL_FRONT_PORT}`,
            apiBaseUrl: `http://127.0.0.1:${LOCAL_FRONT_PORT}/api/v1`,
            clientVersion: app.getVersion(),
            platform: process.platform
        };
    });

    removeAndHandle('nestor:set-server-origin', async (event, newOrigin) => {
        const saved = await saveClientConfig(newOrigin);
        serverOrigin = saved.server_origin;
        return { ok: true, serverOrigin };
    });

    removeAndHandle('nestor:test-server-origin', async (event, origin) => {
        const testOrigin = normalizeServerOrigin(origin);
        return await fetchJson(`${testOrigin}/__front/version.json`);
    });

    removeAndHandle('nestor:relaunch', async () => {
        relaunchApp('ipc');
        return { ok: true };
    });

    // ── Servidor local ─────────────────────────────────────────────────────
    // El renderer es el primero que se entera de que el servidor local se cayó (sus
    // peticiones mueren con ERR_NETWORK), así que es también el que dispara la
    // comprobación: llega antes que la ronda periódica. `repair` y `status` son la
    // misma rutina —comprobar y, si hace falta, volver a levantarlo—; se separan sólo
    // para que el nombre diga qué espera quien llama.
    removeAndHandle('nestor:local-server-status', async () => {
        return await ensureLocalServer('renderer:status');
    });

    removeAndHandle('nestor:local-server-repair', async (event, payload) => {
        const reason = String((payload && payload.reason) || 'renderer');
        return await ensureLocalServer(`renderer:${reason}`.slice(0, 120));
    });

    removeAndHandle('nestor:refresh', async (event) => {
        const win = winFromEvent(event);
        if (!win) return { ok: false };
        const { response } = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Cancelar', 'Refrescar'],
            defaultId: 1,
            cancelId: 0,
            title: 'Nestor POS',
            message: '¿Refrescar la aplicación?',
            detail: 'Se descargará el código más reciente y se limpiará el caché. Los datos de sesión se conservarán.',
        });
        if (response === 1) refreshWithUpdate(win);
        return { ok: response === 1 };
    });

    // Botón rojo "Eliminar datos y caché". Borrado manual: sí es total (incluye
    // sesión y borradores del POS) y reinicia. El automático por cambio de build
    // es más conservador a propósito.
    removeAndHandle('nestor:clear-data', async (event) => {
        return await runCacheClear(winFromEvent(event), {
            preset: 'full',
            reason: 'manual-button'
        });
    });

    // El POS toma (o suelta) el gate del auto-update. Mientras lo tenga tomado y
    // siga en /pos, el cliente NO se recarga solo al cambiar la build: la anota y
    // avisa por `nestor:update-available`. Hay que renovarlo antes de POS_GATE_TTL_MS
    // (el POS lo late cada 30 s) o caduca y el cliente vuelve a actualizarse solo.
    removeAndHandle('nestor:update-gate', async (event, payload) => {
        const active = !!(payload && payload.active);
        posUpdateGate = { active, at: Date.now() };

        // Al soltarlo, el siguiente ping del watcher aplica lo que quedó diferido.
        if (!active && deferredBuildId) {
            console.log('[update] el POS soltó el gate; se aplicará la build diferida');
        }

        return { ok: true, ...updateStatusPayload() };
    });

    // ¿Hay una build nueva esperando? Lo pregunta el POS al entrar (la build pudo
    // cambiar antes de que la caja abriera) y cuando le conviene aplicarla.
    removeAndHandle('nestor:update-status', async () => updateStatusPayload());

    // Mismo motor que el botón rojo, pero invocable por el sistema: la idea es
    // que el SPA lo llame cuando detecte una actualización de software y el
    // caché del cliente tenga que vaciarse solo.
    //
    //   await window.NestorClient.clearCache({ preset: 'update', reason: 'ota' })
    //
    // Presets: 'update' (default, conserva sesión y ventas encoladas),
    // 'cache' (sólo caché, no toca almacenamiento) y 'full' (idéntico al botón
    // rojo: borra todo y reinicia). Cualquier bandera individual se puede
    // sobreescribir en el mismo objeto.
    removeAndHandle('nestor:clear-cache', async (event, options) => {
        const opts = (options && typeof options === 'object') ? { ...options } : {};

        // El candado es del proceso principal: nadie lo pide por IPC.
        delete opts.assumeLock;

        try {
            return await runCacheClear(winFromEvent(event), opts);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            console.warn('[clear-cache] falló:', msg);
            // Falla la descarga del bundle => no se borró nada. Se responde en
            // vez de lanzar para que el SPA pueda reintentar sin romperse.
            return { ok: false, error: msg, preset: opts.preset || 'update', reason: String(opts.reason || 'manual') };
        }
    });

    // ── Ventas en local ────────────────────────────────────────────────────
    // El POS anota aquí cada venta, cada renglón y cada voucher de la terminal.
    // Ver src/ledger.js para el porqué y para las protecciones del archivo.
    //
    // Dos reglas que no se rompen:
    //   1. NINGÚN canal borra un renglón. `remove` es lo más parecido y no lo
    //      hace: pone una lápida (deja de verse y de contar) sobre una venta que
    //      nunca se consolidó, con motivo y con su evento en la cadena. Una
    //      venta que sí llegó al servidor la rechaza el propio motor.
    //   2. Ninguno de estos canales LANZA. El ledger es instrumentación: un
    //      fallo suyo no puede tumbar un cobro, así que responde
    //      { ok:false, error } y el POS sigue con su bitácora de siempre.
    const ledgerHandle = (channel, fn) => removeAndHandle(channel, (event, arg) => {
        try {
            return fn(arg);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            console.warn(`[ledger] ${channel} falló:`, msg);
            return { ok: false, error: msg };
        }
    });

    ledgerHandle('nestor:ledger:status', () => ledger.status());
    ledgerHandle('nestor:ledger:stats', () => ledger.stats());
    ledgerHandle('nestor:ledger:record', (entry) => ledger.record(entry));
    ledgerHandle('nestor:ledger:mark', (patch) => ledger.mark(patch));
    ledgerHandle('nestor:ledger:remove', (patch) => ledger.remove(patch));
    ledgerHandle('nestor:ledger:emv', (entry) => ledger.emv(entry));
    ledgerHandle('nestor:ledger:list', (query) => ledger.list(query));
    ledgerHandle('nestor:ledger:get', (key) => ledger.get(key));
    ledgerHandle('nestor:ledger:summary', (query) => ledger.summary(query));
    ledgerHandle('nestor:ledger:verify', (limit) => ledger.verify(limit));
    ledgerHandle('nestor:ledger:export', (query) => ledger.exportAll(query));
    // Retención: saca de la base lo ya resuelto que pasó de los 180 días y deja el ancla.
    // Corre solo al abrir y cada 6 h; esto sólo lo adelanta.
    ledgerHandle('nestor:ledger:archive', (options) => ledger.archive(options));
    ledgerHandle('nestor:ledger:archives', () => ledger.archives());

    // ── Captura de sesiones XHR ─────────────────────────────────────────────
    // Misma regla que el ledger: es instrumentación, así que ningún canal lanza.
    // `save-now` cierra el .har de la sesión en curso y sigue capturando en otro,
    // que es lo que se pide para mandar una captura sin cerrar el punto de venta.
    const xhrHandle = (channel, fn) => removeAndHandle(channel, (event, arg) => {
        try {
            return fn(arg);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            console.warn(`[xhr] ${channel} falló:`, msg);
            return { ok: false, error: msg };
        }
    });

    xhrHandle('nestor:xhr:status', () => xhr.status());
    xhrHandle('nestor:xhr:list', (limit) => xhr.list(limit));
    xhrHandle('nestor:xhr:save-now', (reason) => xhr.saveNow(reason));
    xhrHandle('nestor:xhr:mark', (entry) => xhr.mark(entry));
    // Adelanta la limpieza por retención (corre sola cada 6 h en cada caja).
    xhrHandle('nestor:xhr:sweep', () => xhr.sweep());
    // Identidad de la caja (licencia, caja, usuario, negocio) + el token de la sesión.
    // La pone el POS al montar y en cada login; con ella se nombran las capturas y se
    // identifica la incidencia en la nube. Ver xhr.capture.js → setIdentity.
    xhrHandle('nestor:xhr:set-identity', (patch) => xhr.setIdentity(patch));

    xhrHandle('nestor:xhr:open-folder', async () => {
        const target = xhr.directory();
        if (!target) return { ok: false, error: 'sin directorio de capturas' };
        const err = await shell.openPath(target);
        return { ok: !err, ruta: target, error: err || '' };
    });

    // ── Errores POS ─────────────────────────────────────────────────────────
    // Misma regla que el ledger y la captura: es instrumentación y NUNCA lanza. Un fallo
    // aquí no puede tumbar el cobro que lo provocó — que es literalmente el momento en el
    // que se llama.
    removeAndHandle('nestor:diag:report', async (event, info) => {
        try {
            return await posError.report(info || {});
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            console.warn('[errores-pos] report falló:', msg);
            return { ok: false, error: msg };
        }
    });

    removeAndHandle('nestor:diag:status', async () => {
        try { return posError.status(); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    });

    removeAndHandle('nestor:diag:flush', async () => {
        try { return await posError.flush(); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    });

    // ── Daemon de servicios ─────────────────────────────────────────────────
    // Misma regla que el resto de la instrumentación: NINGÚN canal lanza. Estos se
    // llaman desde el arranque del punto de venta y desde la barra de estado; que un
    // fallo del daemon impida abrir la caja sería exactamente al revés de para lo que
    // existe. Ver src/services.watchdog.js.
    const servicesHandle = (channel, fn) => removeAndHandle(channel, async (event, arg) => {
        try {
            return await fn(arg);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            console.warn(`[servicios] ${channel} falló:`, msg);
            return { ok: false, error: msg };
        }
    });

    servicesHandle('nestor:services:status', () => services.status());
    // Pone un servicio bajo vigilancia y lo levanta si no está. Es lo que llama el POS
    // al entrar a /pos para la terminal EMV.
    servicesHandle('nestor:services:ensure', (arg) => services.ensure(
        arg && arg.id, { immediate: !(arg && arg.immediate === false) }
    ));
    servicesHandle('nestor:services:release', (arg) => services.release(arg && arg.id));
    // Reparación pedida a mano: se salta el backoff, no la compuerta de trabajo en vuelo.
    servicesHandle('nestor:services:repair', (arg) => services.repair(arg && arg.id));
    // "No toques esto mientras cobro." Ver la nota de hold() en el daemon.
    servicesHandle('nestor:services:hold', (arg) => services.hold(arg && arg.id, arg && arg.ms));
    servicesHandle('nestor:services:unhold', (arg) => services.unhold(arg && arg.id));

    servicesHandle('nestor:services:open-folder', async () => {
        const target = services.directory();
        if (!target) return { ok: false, error: 'sin directorio de bitácora' };
        const err = await shell.openPath(target);
        return { ok: !err, ruta: target, error: err || '' };
    });
}

function exitFullscreenAndKiosk(win) {
    if (!win || win.isDestroyed()) return;

    if (win.isKiosk()) win.setKiosk(false);
    if (process.platform === 'darwin') win.setSimpleFullScreen(false);
    win.setFullScreen(false);

    enforceMacNoTrafficLightsSoon(win);
    notifyWinMode(win);
}

function registerPosShortcuts(win) {
    if (!ALLOW_EXIT_SHORTCUTS) return;

    const reg = (acc, fn) => {
        const ok = globalShortcut.register(acc, fn);
        if (!ok) console.warn(`[shortcut] failed: ${acc}`);
    };

    reg('CommandOrControl+Alt+Shift+Q', () => {
        exitFullscreenAndKiosk(win);
    });

    // Cmd+Q (mac) / Ctrl+Q cierra la app
    reg('CommandOrControl+Q', () => {
        if (win && !win.isDestroyed()) win.close();
        else app.quit();
    });

    reg('CommandOrControl+Enter', () => {
        if (!win || win.isDestroyed()) return;
        if (win.isKiosk()) win.setKiosk(false);

        if (process.platform === 'darwin') {
            win.setSimpleFullScreen(!win.isSimpleFullScreen());
        } else {
            win.setFullScreen(!win.isFullScreen());
        }

        enforceMacNoTrafficLightsSoon(win);
        notifyWinMode(win);
    });

}

/**
 * Toma el candado de instancia única. Con reintentos: el proceso que relanza el
 * auto-update arranca mientras el anterior todavía se está muriendo, y ahí "el candado
 * está tomado" significa "espera un momento", no "ya hay otro cliente abierto".
 */
async function acquireInstanceLock() {
    if (!SINGLE_INSTANCE) return true;

    for (let intento = 0; intento <= INSTANCE_LOCK_RETRIES; intento++) {
        if (app.requestSingleInstanceLock()) return true;
        if (intento < INSTANCE_LOCK_RETRIES) await sleep(INSTANCE_LOCK_WAIT_MS);
    }

    // Se agotaron los reintentos. Antes de rendirse —que aquí significa "la caja no
    // vuelve a abrir sola"— hay que distinguir los dos casos que se ven igual desde el
    // candado:
    //
    //   a) De verdad hay otro cliente trabajando: contesta en el puerto local. Salirse es
    //      lo correcto (y `second-instance` ya trajo su ventana al frente).
    //   b) El candado es de un proceso que se está MURIENDO. Es el relanzamiento del
    //      auto-update: Electron arranca el proceso nuevo mientras el viejo termina de
    //      salir. Rendirse aquí deja la caja apagada tras una actualización, con el cajero
    //      esperando y nadie que la abra. Así que se sigue esperando mientras nadie
    //      conteste en el puerto.
    //
    // `relaunchApp()` suelta el candado antes de relanzar, así que (b) casi nunca debería
    // llegar hasta aquí. Esto es la red por si ese camino no se cumple (un cierre por
    // señal, una versión anterior que no lo suelta, un proceso colgado).
    const deadline = Date.now() + INSTANCE_LOCK_GHOST_WAIT_MS;
    while (Date.now() < deadline) {
        const who = await probeLocalServer(1200);
        if (who.ok) {
            // (a) Hay otro cliente VIVO. Su ventana ya se enfocó (el primario atendió el
            // evento `second-instance` en cuanto pedimos el candado). Si con eso no basta
            // —el usuario insiste—, se le ofrece el relevo.
            if (await offerReplaceOther(who)) return true;
            console.warn('[instancia] el otro cliente contesta en el puerto '
                + `(pid ${who.pid || '?'}): esta instancia se sale`);
            return false;
        }
        console.warn('[instancia] el candado está tomado pero NADIE contesta en el puerto: '
            + 'se espera (probable relanzamiento en curso)');
        await sleep(INSTANCE_LOCK_WAIT_MS);
        if (app.requestSingleInstanceLock()) {
            console.log('[instancia] candado obtenido tras esperar al proceso anterior');
            return true;
        }
    }
    return false;
}

// ── Intentos de apertura ───────────────────────────────────────────────────
// Se anotan en disco porque cada intento es un PROCESO distinto: la única forma de saber
// que el usuario insiste es que el anterior dejó constancia. Sólo se conservan los de la
// ventana de tiempo vigente.
function recordLaunchAttempt() {
    const { userData } = getPaths();
    const file = path.join(userData, 'launch_attempts.json');
    const now = Date.now();
    let previous = [];
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(raw && raw.at)) previous = raw.at;
    } catch { /* primera vez, o archivo ilegible */ }

    const recent = previous
        .map((t) => Number(t) || 0)
        .filter((t) => t > 0 && (now - t) < REPLACE_ATTEMPT_WINDOW_MS);
    recent.push(now);

    try {
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ at: recent.slice(-5) }));
    } catch (e) {
        console.warn('[instancia] no se pudo anotar el intento de apertura:',
            e && e.message ? e.message : e);
    }
    return recent.length;
}

function clearLaunchAttempts() {
    try {
        fs.rmSync(path.join(getPaths().userData, 'launch_attempts.json'), { force: true });
    } catch { /* noop */ }
}

/**
 * Ofrece cerrar la instancia anterior y quedarse con ésta. Devuelve true SÓLO si el
 * relevo se completó (candado en mano y puerto libre): el llamador puede seguir con el
 * arranque normal.
 *
 * La advertencia dice lo que de verdad está en juego, que no es la cuenta en captura —el
 * borrador vive en el servidor y en la bitácora local, y se rehidrata sola— sino lo que
 * esté EN VUELO: una venta a medio registrar (queda por comprobar) y, sobre todo, un
 * cobro con tarjeta en curso, que puede quedar aprobado en la terminal sin ticket.
 */
async function offerReplaceOther(who) {
    if (REPLACE_PROMPT_MODE === 'never') return false;

    const intentos = recordLaunchAttempt();
    if (REPLACE_PROMPT_MODE !== 'always' && intentos < 2) {
        // Primer intento: la ventana anterior ya se trajo al frente. Con eso basta en el
        // caso normal (un doble clic de más) y no se molesta a nadie con un diálogo.
        console.log('[instancia] primer intento: se enfocó la ventana existente');
        return false;
    }

    const enPos = who.pos_route === true;
    const trabajando = who.pos_gate === true;

    const detalle = [
        enPos
            ? 'La ventana que ya está abierta tiene el PUNTO DE VENTA en pantalla'
            + (trabajando ? ' y la caja está trabajando.' : '.')
            : 'Ya hay una ventana de Nestor POS abierta en este equipo.',
        '',
        'Si la cierras y te quedas con esta:',
        '  • La cuenta en captura NO se pierde (se recupera al volver a entrar).',
        '  • Las ventas que estén en la cola tampoco se pierden.',
        '  • Sí se interrumpe lo que esté a medias: una venta a medio registrar quedará',
        '    pendiente de comprobar y un COBRO CON TARJETA en curso puede quedar',
        '    aprobado en la terminal sin ticket.',
        '',
        'Si sólo no encuentras la ventana anterior, esta opción es la correcta.'
    ].join('\n');

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Usar la ventana abierta', 'Cerrar la anterior y abrir esta'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Nestor POS ya está abierto',
        message: '¿Cerrar la ventana anterior?',
        detail: detalle
    });

    if (response !== 1) {
        console.log('[instancia] el usuario prefirió la ventana ya abierta');
        return false;
    }

    // Se le pide el relevo por el mismo canal del candado: el primario recibe
    // `second-instance` con este dato y se cierra EN ORDEN (bitácoras consolidadas).
    console.warn(`[instancia] relevo aceptado: se pide el cierre del pid ${who.pid || '?'}`);
    app.requestSingleInstanceLock({ nestor_replace: true, at: Date.now() });

    const deadline = Date.now() + REPLACE_HANDOVER_MS;
    while (Date.now() < deadline) {
        await sleep(250);
        if (app.requestSingleInstanceLock()) {
            // El puerto puede tardar un instante más en quedar libre; de eso se encarga
            // ensureLocalServer, que reintenta el listen.
            console.log('[instancia] relevo completado: esta ventana toma el lugar de la anterior');
            clearLaunchAttempts();
            return true;
        }
    }

    // No se cerró: el proceso anterior está colgado de verdad (no atiende ni el IPC), así
    // que no hay nada que esta instancia pueda hacer sin matarlo por la fuerza.
    dialog.showErrorBox(
        'No se pudo cerrar la ventana anterior',
        'La ventana de Nestor POS que ya estaba abierta no respondió al cierre.\n\n'
        + `Ciérrala desde el Administrador de tareas (proceso ${who.pid || 'Nestor POS'}) `
        + 'y vuelve a abrir la aplicación.'
    );
    return false;
}

// Alguien volvió a abrir el acceso directo: en vez de arrancar un segundo cliente (que se
// pelearía el puerto y el perfil), se trae al frente el que ya está.
app.on('second-instance', (event, argv, workingDirectory, additionalData) => {
    // La instancia nueva pidió el relevo y su usuario ya confirmó la advertencia (ver
    // acquireInstanceLock): esta ventana se cierra en orden —consolidando bitácoras y
    // soltando puerto y candado— para que la nueva pueda tomar su lugar.
    if (additionalData && additionalData.nestor_replace === true) {
        console.warn('[instancia] una ventana nueva pidió reemplazar a ésta: se cierra en orden');
        shutdownForExit('reemplazo por una ventana nueva');
        try { if (SINGLE_INSTANCE) app.releaseSingleInstanceLock(); } catch { }
        app.exit(0);
        return;
    }

    console.log('[instancia] se intentó abrir un segundo cliente; se enfoca el que ya está');
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    } catch { }
});

app.whenReady().then(async () => {
    try {
        // Lo PRIMERO: si no somos la única instancia, salir sin haber tocado nada — ni el
        // puerto, ni la base de ventas, ni la captura XHR (que si no, le anexa un cierre
        // a la fuerza al .har que la otra instancia tiene abierto).
        if (!await acquireInstanceLock()) {
            console.warn('[instancia] ya hay un cliente de Nestor POS abierto en este equipo; se sale');
            app.exit(0);
            return;
        }
        // Somos la única instancia: los intentos anotados por aperturas anteriores ya no
        // dicen nada (ver offerReplaceOther).
        clearLaunchAttempts();

        await session.defaultSession.clearCache();
        await session.defaultSession.clearStorageData({
            storages: ['serviceworkers', 'cachestorage']
        });

        Menu.setApplicationMenu(null);

        // "Ventas en local" — se abre ANTES que la ventana y antes de cualquier borrado
        // de caché. Vive fuera de `userData`, así que nada de lo que hace runCacheClear
        // (ni el botón rojo) lo alcanza; ver src/ledger.js.
        ledger.init(app.getPath('userData'));

        // Captura de sesiones XHR. También vive fuera de `userData` y también se abre
        // antes de cualquier borrado de caché: lo que se quiere leer después de un
        // borrado es justo lo que pasó antes. Ver src/xhr.capture.js.
        xhr.init(app.getPath('userData'), { appVersion: app.getVersion() });

        // Errores POS. Va DESPUÉS de los otros dos porque los usa: arma el paquete de
        // incidencia con la sesión de `xhr` y el volcado de `ledger`. `serverOrigin` se
        // pasa como función, no como valor: se resuelve más abajo y el usuario puede
        // cambiarlo desde la ventana de configuración sin reiniciar.
        posError.init(app.getPath('userData'), {
            appVersion: app.getVersion(),
            serverOrigin: () => serverOrigin,
            xhr,
            ledger
        });

        wireIpc();

        const { currentDir } = getPaths();
        const cfg = await loadClientConfig();
        serverOrigin = cfg.server_origin;
        savedZoomFactor = cfg.zoom_factor ?? 1.0;

        // Se levanta también en dev: sirve /__client/config y el proxy /api/v1.
        //
        // No basta con que el `listen` no truene: hay que comprobar que el que contesta en
        // el puerto sea ESTE proceso (ver ensureLocalServer). Si el puerto es de alguien
        // más, abrir la ventana significa mostrarle al cajero el frontend de otro proceso
        // sobre datos de otro servidor, así que se dice y se sale.
        await ensureLocalServer('arranque');
        if (localServerState.listening !== true) {
            const detalle = localServerState.foreign
                ? `El puerto ${LOCAL_FRONT_PORT} lo tiene otro proceso.\n\n`
                + 'Lo más probable es que ya haya un cliente de Nestor POS abierto (o uno que '
                + 'quedó colgado). Ciérralo desde el Administrador de tareas y vuelve a abrir.'
                : `No se pudo levantar el servidor local en ${LOCAL_FRONT_URL}.\n\n${localServerState.error || ''}`;
            dialog.showErrorBox('Nestor POS no puede iniciar', detalle);
            app.exit(1);
            return;
        }
        startLocalServerWatcher();

        // Daemon de servicios de la caja: vigila el servicio de impresión (:8331) y la
        // terminal EMV (:5000) y los levanta cuando se caen. Va después del servidor
        // local porque comparte su forma de trabajar (sondeo → reparación serializada)
        // y antes de la ventana porque el printer se vigila desde el arranque, no desde
        // que alguien entra al punto de venta. Ver src/services.watchdog.js.
        watchServiceTraffic();
        services.init(app.getPath('userData'), {
            onChange: broadcastServices,
            // El daemon sólo reporta cuando se da por vencido con un servicio: el canal
            // de errores POS arma un paquete pesado (sesión XHR, consola, log del
            // servidor) y deduplica por 6 h, así que no es para telemetría de rutina.
            report: (info) => posError.report(info)
        });

        if (IS_DEV) {
            console.log(`[dev] frontend desde ${DEV_URL} (sin bundle, sin auto-update); API hacia ${serverOrigin}`);
            mainWindow = createMainWindow();
            registerPosShortcuts(mainWindow);
            return;
        }

        // Si el servidor cambió de build (o de origen) desde la última vez,
        // arrancamos con caché limpio. Aquí todavía no hay ventana, así que no
        // se toca localStorage: los borradores del POS de la sesión anterior
        // (ventas encoladas sin subir) tienen que sobrevivir.
        await clearCachesIfBuildChanged(serverOrigin);

        try {
            await ensureFrontendCached(serverOrigin);
        } catch (e) {
            console.error('[front cache] failed:', e && e.message ? e.message : e);
        }

        mainWindow = createMainWindow();
        registerPosShortcuts(mainWindow);
        startVersionWatcher(mainWindow);

        const idx = path.join(currentDir, 'index.html');
        if (!fs.existsSync(idx)) {
            openConfigWindow();
        }
    } catch (err) {
        console.error(err);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    // Se cerró la última ventana: apagar la vigilancia del puerto ANTES de cerrarlo, o el
    // `close` del socket dispararía un nuevo `listen` a media salida.
    shutdownForExit('se cerraron todas las ventanas');
    app.quit();
});

app.on('will-quit', () => {
    // Cierra la captura XHR (el .har queda completo y abrible), consolida el WAL de la
    // base de ventas y deja la cola de incidencias en disco. Es idempotente: si ya se
    // hizo desde `window-all-closed` o desde un relanzamiento, aquí no hace nada.
    shutdownForExit('will-quit');
});
