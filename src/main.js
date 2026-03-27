const { app, session, BrowserWindow, ipcMain, Menu, globalShortcut, dialog } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { startLocalFrontendServer } = require('./proxy');

app.commandLine.appendSwitch('disable-http-cache');

const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:8180';
const LOCAL_FRONT_PORT = parseInt(process.env.NESTOR_FRONT_PORT || '18180', 10);

// Fullscreen por defecto (puedes apagarlo con NESTOR_FULLSCREEN=0)
const START_FULLSCREEN = (process.env.NESTOR_FULLSCREEN || '1') === '1';

// Kiosk opcional (NESTOR_KIOSK=1) => fullscreen “POS real”
const START_KIOSK = process.env.NESTOR_KIOSK === '1';

// Atajos ocultos (solo soporte/QA) (NESTOR_ALLOW_EXIT=1)
const ALLOW_EXIT_SHORTCUTS = true; // process.env.NESTOR_ALLOW_EXIT === '1';

let mainWindow = null;
let configWindow = null;
let localServer = null;
let serverOrigin = DEFAULT_SERVER_ORIGIN;
let savedZoomFactor = 1.0;

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

async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
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

async function ensureFrontendCached(origin) {
    const { wwwRoot, currentDir, metaPath } = getPaths();
    await fsp.mkdir(wwwRoot, { recursive: true });

    const remoteVer = await fetchJson(`${origin}/__front/version.json`);
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
        updated_at: new Date().toISOString()
    });

    return { version: remoteVer.version };
}

async function refreshWithUpdate(win) {
    if (!win || win.isDestroyed()) return;

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
            devTools: true
        }
    });

    win.setMenuBarVisibility(false);
    enforceMacNoTrafficLights(win);

    win.webContents.on('did-finish-load', () => notifyWinMode(win));

    win.loadURL(`http://127.0.0.1:${LOCAL_FRONT_PORT}/`);

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

    // Interceptar window.location.reload() desde el renderer
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

    // Interceptar Ctrl+R / Cmd+R y atajos de zoom como navegador
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
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
        if (win) win.close();
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

    removeAndHandle('nestor:clear-data', async () => {
        const { wwwRoot, currentDir, metaPath } = getPaths();
        const apiCacheDir = path.join(wwwRoot, 'api_cache');

        await fsp.rm(currentDir, { recursive: true, force: true });
        await fsp.rm(apiCacheDir, { recursive: true, force: true });
        await fsp.rm(metaPath, { force: true });

        try {
            await session.defaultSession.clearCache();
            await session.defaultSession.clearStorageData({
                storages: ['serviceworkers', 'cachestorage', 'localstorage', 'indexdb', 'cookies']
            });
        } catch { }

        app.relaunch();
        app.exit(0);
        return { ok: true };
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

    // F10: salir a modo ventana (kiosk + fullscreen OFF)
    reg('F10', () => {
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

        localServer = await startLocalFrontendServer(currentDir, () => serverOrigin);

        try {
            await ensureFrontendCached(serverOrigin);
        } catch (e) {
            console.error('[front cache] failed:', e && e.message ? e.message : e);
        }

        mainWindow = createMainWindow();
        registerPosShortcuts(mainWindow);

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
    try { if (localServer) localServer.close(); } catch { }
    app.quit();
});

app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch { }
});
