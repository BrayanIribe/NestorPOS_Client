const { app, session, BrowserWindow, ipcMain, Menu, globalShortcut, dialog } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { startLocalFrontendServer } = require('./proxy');

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
    const metaPath = path.join(wwwRoot, 'frontend_meta.json');
    const clientConfigPath = path.join(userData, 'client_config.json');
    return { userData, wwwRoot, currentDir, metaPath, clientConfigPath };
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
    const { wwwRoot, currentDir, metaPath } = getPaths();
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

    await fsp.rm(currentDir, { recursive: true, force: true });
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
    const { wwwRoot, currentDir, metaPath } = getPaths();
    const apiCacheDir = path.join(wwwRoot, 'api_cache');

    await fsp.rm(apiCacheDir, { recursive: true, force: true });

    if (frontend) {
        await fsp.rm(currentDir, { recursive: true, force: true });
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
        if (cfg.redownload) {
            // Si truena, se propaga sin haber borrado nada.
            bundle = await ensureFrontendCached(serverOrigin);
            // Con el bundle nuevo en disco ya no hay build pendiente: si esto lo
            // disparó el POS al quedar ocioso, el watcher no debe volver a
            // anunciar la misma.
            deferredBuildId = '';
            announcedBuildId = '';
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
            reloaded: !cfg.relaunch && !!cfg.reload
        };

        console.log(`[clear-cache] preset=${preset} reason=${reason} localStorage=${removedKeys} relaunch=${cfg.relaunch} reload=${result.reloaded}`);

        // Se avisa antes de recargar/reiniciar: quien invocó ya tiene la
        // respuesta del invoke, y esto es para las demás ventanas.
        broadcastCacheCleared(result);

        if (cfg.relaunch) {
            // Con retraso para que la respuesta del invoke alcance a salir; el
            // botón rojo antes salía en seco y el renderer nunca la veía.
            setTimeout(() => {
                app.relaunch();
                app.exit(0);
            }, 150);
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
        height: 460,
        resizable: false,
        backgroundColor: '#ffffff',
        frame: isMac ? true : false,
        titleBarStyle: isMac ? 'hidden' : undefined,

        autoHideMenuBar: true,
        parent: mainWindow || undefined,
        modal: !!mainWindow,
        title: 'Configuración',

        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true
        }
    });

    configWindow.setMenuBarVisibility(false);
    enforceMacNoTrafficLights(configWindow);

    configWindow.loadURL(`http://127.0.0.1:${LOCAL_FRONT_PORT}/__client/config`);
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
        apiBaseUrl: `http://127.0.0.1:${LOCAL_FRONT_PORT}/api/v1`
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
            apiBaseUrl: `http://127.0.0.1:${LOCAL_FRONT_PORT}/api/v1`
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
        app.relaunch();
        app.exit(0);
        return { ok: true };
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

app.whenReady().then(async () => {
    try {
        await session.defaultSession.clearCache();
        await session.defaultSession.clearStorageData({
            storages: ['serviceworkers', 'cachestorage']
        });

        Menu.setApplicationMenu(null);

        wireIpc();

        const { currentDir } = getPaths();
        const cfg = await loadClientConfig();
        serverOrigin = cfg.server_origin;
        savedZoomFactor = cfg.zoom_factor ?? 1.0;

        // Se levanta también en dev: sirve /__client/config y el proxy /api/v1.
        localServer = await startLocalFrontendServer(currentDir, () => serverOrigin);

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
    try { if (versionTimer) clearInterval(versionTimer); } catch { }
    versionTimer = null;
    try { if (localServer) localServer.close(); } catch { }
    app.quit();
});

app.on('will-quit', () => {
    try { if (versionTimer) clearInterval(versionTimer); } catch { }
    versionTimer = null;
    try { globalShortcut.unregisterAll(); } catch { }
});
