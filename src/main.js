const { app, session, BrowserWindow, ipcMain, Menu, globalShortcut } = require('electron');
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
        return { server_origin: normalizeServerOrigin(cfg.server_origin) };
    }
    return { server_origin: DEFAULT_SERVER_ORIGIN };
}

async function saveClientConfig(origin) {
    const { clientConfigPath } = getPaths();
    const cfg = {
        server_origin: normalizeServerOrigin(origin),
        updated_at: new Date().toISOString()
    };
    await writeJSON(clientConfigPath, cfg);
    return cfg;
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
