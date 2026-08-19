// src/xhr.capture.js
//
// CAPTURA DE SESIONES XHR — la pestaña "Network" de la caja, encendida siempre.
//
// Por qué existe
// --------------
// Cuando algo falla en una caja, la pregunta que nadie puede contestar es la única que
// importa: "¿qué pidió el POS y qué le contestó el servidor?". Hoy hay tres fuentes y a
// las tres les falta lo mismo:
//
//   * `session.diagnostics.js` (frontend) guarda los últimos 50 XHR **sin cuerpos** y
//     sólo en memoria: se lo lleva el primer refresh y sirve para el reporte de
//     incidencia, no para reconstruir la sesión;
//   * la bitácora de requests de Fact vive en el servidor — justo lo que no responde
//     cuando el problema es de red;
//   * DevTools sí lo ve todo, pero hay que estar ahí, con la pestaña abierta, ANTES de
//     que ocurra. Y no ocurre mientras alguien mira.
//
// Esto es la cuarta fuente y la que se queda en la caja: el proceso principal se
// engancha al renderer por CDP (el mismo protocolo de DevTools) y anexa cada XHR a un
// archivo HAR 1.2 mientras la aplicación vive. Al cerrar el ejecutable lo cierra bien y
// queda un archivo que se abre tal cual en DevTools (Network → botón de importar), en
// Charles, en Insomnia o en cualquier visor de HAR.
//
// Por qué CDP y no un parche de XMLHttpRequest en el preload: con `contextIsolation`
// el preload NO comparte el `window` de la página, así que un parche ahí no vería un
// solo XHR de la app. CDP, además, ve lo que NO pasa por el proxy local: la impresora
// en `:8331` y el microservicio EMV de Santander, que son la mitad de las incidencias.
//
// Decisiones que importan
// -----------------------
//  1. **Un archivo por sesión de cajero.** Al arrancar se abre `...-sin-sesion.har`; en
//     cuanto un `POST /auth/login` responde 2xx se cierra ese archivo y se abre otro con
//     el usuario en el nombre, y el propio login es su primer renglón. Pedir "la sesión
//     de Ana de ayer a las 3" es buscar un archivo, no bucear en un log.
//  2. **Se escribe HAR incremental, no un volcado al final.** El archivo es válido
//     mientras crece: `finalizar()` sólo le anexa el cierre. Si a la caja le cortan la
//     luz, en el siguiente arranque se recupera lo que ya estaba en disco (`_fin.recuperada`).
//     Nada de "guardo todo en memoria y lo escribo al salir", que es como se pierde
//     exactamente la sesión que interesa.
//  3. **Escritura síncrona.** Son unos KB por petición sobre un descriptor abierto; a
//     cambio, `shutdown()` en `will-quit` no depende de que Electron espere una promesa.
//  4. **Redacción, con una excepción deliberada.** Nunca se guardan contraseñas, NIP ni
//     datos de tarjeta: las llaves de query y de JSON que huelan a secreto salen como
//     `***`, conservando el nombre (saber que se mandó `password` sirve; su valor, jamás).
//     La excepción son los encabezados de SESIÓN —`x-access-token`, `cookie`,
//     `authorization`—: esos se guardan enteros, porque la captura existe para reproducir
//     la petición (copiarla como cURL y volver a mandarla) y sin el token eso no se puede.
//     A cambio, un .har vale como credencial de ese cajero mientras el token viva: se
//     comparte como una contraseña, no como un log. `NESTOR_XHR_KEEP_AUTH=0` los tapa.
//  5. **Topes en todo.** Cuerpo por petición, bytes por sesión, sesiones en disco y
//     bytes del directorio. Un catálogo de 8 MB entra como metadato, no como cuerpo: la
//     captura no puede llenarle el disco a la caja ni volverla lenta.
//  6. **Se limpia sola, en la caja.** Retención de 10 días: se barre al arrancar y cada
//     6 horas mientras la caja esté abierta (que es como está de verdad: semanas sin
//     cerrar). Nadie tiene que entrar a borrar capturas a mano en ningún equipo.
//
// Apagado y palancas (todas por variable de entorno):
//   NESTOR_XHR_CAPTURE=0            apaga la captura por completo
//   NESTOR_XHR_DIR=<ruta>           dónde se guardan las sesiones
//   NESTOR_XHR_MAX_BODY=65536       tope de cuerpo por petición (bytes)
//   NESTOR_XHR_KEEP_AUTH=0          tapa x-access-token / cookie / authorization
//   NESTOR_XHR_SESSION_MAX_BYTES    tope por sesión; al pasarlo sigue el metadato, sin cuerpos
//   NESTOR_XHR_RETENTION_DAYS=10    días que se conservan las sesiones en la caja
//   NESTOR_XHR_SWEEP_MS             cada cuánto se barre lo caducado (por omisión 6 h)
//   NESTOR_XHR_KEEP=30              tope de sesiones en disco (red, además de los días)
//   NESTOR_XHR_DIR_MAX_BYTES        tope del directorio completo
//   NESTOR_XHR_TYPES=XHR,Fetch      tipos de recurso que se capturan

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Palancas ────────────────────────────────────────────────────────────────────

function intEnv(name, def) {
    const v = parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(v) && v >= 0 ? v : def;
}

const ENABLED = String(process.env.NESTOR_XHR_CAPTURE || '1') !== '0';

// 64 KB por cuerpo: un JSON de venta con 40 renglones entra completo; lo que se corta
// son los catálogos y los blobs de imagen, que no aportan al diagnóstico.
const MAX_BODY = intEnv('NESTOR_XHR_MAX_BODY', 64 * 1024);

// A partir de aquí la sesión sigue grabando, pero sólo metadatos (método, ruta, status,
// duración, tamaños). Preferimos una sesión completa sin cuerpos a media sesión con ellos.
const SESSION_MAX_BYTES = intEnv('NESTOR_XHR_SESSION_MAX_BYTES', 128 * 1024 * 1024);

// Retención: 10 días. Es el techo real de la captura — una incidencia que nadie reportó
// en diez días ya no se diagnostica con el HAR. Los otros dos topes (número de archivos y
// bytes del directorio) son la red por si una caja hace un volumen anormal: el que
// primero se cumple, manda.
const RETENTION_DAYS = Math.max(1, intEnv('NESTOR_XHR_RETENTION_DAYS', 10));
const KEEP_SESSIONS = Math.max(1, intEnv('NESTOR_XHR_KEEP', 30));
const DIR_MAX_BYTES = intEnv('NESTOR_XHR_DIR_MAX_BYTES', 768 * 1024 * 1024);

// La limpieza no puede depender de que alguien cierre el punto de venta: una caja se
// queda semanas abierta. Se barre al arrancar y luego cada 6 horas.
const SWEEP_MS = Math.max(60 * 1000, intEnv('NESTOR_XHR_SWEEP_MS', 6 * 60 * 60 * 1000));

const CAPTURED_TYPES = new Set(
    String(process.env.NESTOR_XHR_TYPES || 'XHR,Fetch')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

// Peticiones en vuelo que se quedan sin respuesta (pestaña cerrada a media descarga):
// se sueltan a los 5 minutos para que el mapa no crezca sin fin.
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 500;

// Marcadores en memoria (login, detach por DevTools, borrado de caché...). Van al cierre
// del archivo, en `_fin.eventos`.
const MAX_MARKERS = 300;

// ── Qué se considera secreto ────────────────────────────────────────────────────

// Mismo criterio que services/session.diagnostics.js del frontend, más lo de tarjeta.
// Los nombres largos van sueltos; los de tres letras necesitan frontera o se llevan
// medio catálogo por delante ("shipping" contiene "pin", "panel" contiene "pan").
const SECRET_KEY_REGEX = /(pass(word)?|contrase(n|ñ)a|secret|authorization|api[-_]?key|token|clave|firma|signature|(^|[^a-z])(nip|pin|pan|cvv2?|track[12]?)([^a-z]|$))/i;
// Encabezados de sesión. NO se redactan: la captura existe para reproducir la petición
// tal cual (copiar como cURL y volver a mandarla), y sin el token eso no se puede hacer.
// La consecuencia hay que tenerla clara: un .har de estos vale como credencial de ese
// cajero mientras el token viva — se trata como una contraseña, no como un log.
// `NESTOR_XHR_KEEP_AUTH=0` los vuelve a tapar sin tocar código.
const KEEP_AUTH_HEADERS = String(process.env.NESTOR_XHR_KEEP_AUTH || '1') !== '0';

const AUTH_HEADERS = new Set([
    'x-access-token', 'authorization', 'proxy-authorization', 'cookie', 'set-cookie'
]);

// Sólo se guarda cuerpo de lo que es texto. Un PNG o un PDF entran como metadato.
const TEXT_MIME = /(json|text\/|xml|javascript|x-www-form-urlencoded|csv|plain)/i;

// ── Estado ──────────────────────────────────────────────────────────────────────

let dir = '';
let initError = '';
let appVersion = '';
let current = null;      // sesión abierta: { fd, file, name, entries, bytes, ... }
const attached = new Map(); // webContents.id -> { label, pending, wc, dbg, paused }
let totalEntries = 0;
let totalDropped = 0;
let sweepTimer = null;
let lastSweep = null;

// ── Rutas ───────────────────────────────────────────────────────────────────────

// Igual que el ledger de ventas: fuera de `userData`, para que ni el botón rojo de
// "Eliminar datos y caché" ni un perfil de Chromium rehecho se lleven las capturas —
// que es justo lo que uno quiere leer DESPUÉS de un borrado.
function hardenedDir() {
    const override = String(process.env.NESTOR_XHR_DIR || '').trim();
    if (override) return override;

    if (process.platform === 'win32') {
        const base = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
        return path.join(base, 'NestorPOS', 'capturas-xhr');
    }
    if (process.platform === 'darwin') {
        return path.join('/Users/Shared', 'NestorPOS', 'capturas-xhr');
    }
    return path.join('/var/lib', 'nestorpos', 'capturas-xhr');
}

function canUseDir(candidate) {
    try {
        fs.mkdirSync(candidate, { recursive: true });
        const probe = path.join(candidate, '.escritura');
        fs.writeFileSync(probe, String(Date.now()));
        fs.rmSync(probe, { force: true });
        return true;
    } catch {
        return false;
    }
}

// Con los encabezados de sesión dentro, el directorio deja de ser un log: se cierra al
// dueño. En Windows —el sistema real de las cajas— manda la ACL de ProgramData y esto no
// aplica; en mac/Linux evita que cualquier otra cuenta del equipo lea los tokens.
function tightenDir(target) {
    if (!target || process.platform === 'win32') return;
    try { fs.chmodSync(target, 0o700); } catch { }
}

function resolveDir(userDataDir) {
    const hard = hardenedDir();
    if (canUseDir(hard)) return hard;

    const soft = userDataDir ? path.join(userDataDir, 'capturas-xhr') : '';
    if (soft && canUseDir(soft)) {
        console.warn('[xhr] no se pudo escribir en', hard, '- se usa el perfil de la aplicación');
        return soft;
    }

    const alt = path.join(os.homedir(), '.nestorpos', 'capturas-xhr');
    if (canUseDir(alt)) return alt;

    return '';
}

// ── Utilidades ──────────────────────────────────────────────────────────────────

function stamp(ms) {
    const d = new Date(ms || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slug(s) {
    return String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 40);
}

function safeParse(text) {
    try { return JSON.parse(text); } catch { return null; }
}

function redactUrl(rawUrl) {
    const url = String(rawUrl || '');
    const q = url.indexOf('?');
    if (q < 0) return url;

    const base = url.slice(0, q);
    const query = url.slice(q + 1).split('&').map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const key = pair.slice(0, eq);
        return SECRET_KEY_REGEX.test(key) ? `${key}=***` : pair;
    }).join('&');

    return `${base}?${query}`;
}

function headerList(headers) {
    const out = [];
    for (const name of Object.keys(headers || {})) {
        const lower = name.toLowerCase();
        const raw = headers[name];

        // Un encabezado de sesión se tapa sólo si nos lo piden; cualquier otro que huela
        // a secreto (una llave de API en un encabezado propio, por ejemplo) se tapa igual.
        const esAuth = AUTH_HEADERS.has(lower);
        const tapar = esAuth ? !KEEP_AUTH_HEADERS : SECRET_KEY_REGEX.test(lower);

        out.push({ name, value: tapar ? '***' : String(raw == null ? '' : raw).slice(0, 4096) });
    }
    return out;
}

function queryList(rawUrl) {
    const out = [];
    try {
        const u = new URL(rawUrl);
        for (const [name, value] of u.searchParams.entries()) {
            out.push({ name, value: SECRET_KEY_REGEX.test(name) ? '***' : String(value).slice(0, 512) });
        }
    } catch { }
    return out;
}

// Redacta recursivamente las llaves sospechosas de un JSON. Conserva la forma (la
// estructura del cuerpo es la mitad del diagnóstico), sólo cambia el valor por '***'.
function redactJson(value, depth) {
    if (depth > 8 || value == null) return value;

    if (Array.isArray(value)) {
        return value.map((v) => redactJson(v, depth + 1));
    }
    if (typeof value !== 'object') return value;

    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = SECRET_KEY_REGEX.test(key) ? '***' : redactJson(value[key], depth + 1);
    }
    return out;
}

// Devuelve { text, truncated, size } listo para el HAR.
function prepareBody(raw, mimeType, base64Encoded) {
    const size = raw ? Buffer.byteLength(raw, base64Encoded ? 'base64' : 'utf8') : 0;
    if (!raw) return { text: '', truncated: false, size: 0 };

    if (base64Encoded || !TEXT_MIME.test(String(mimeType || ''))) {
        // Binario: sólo se anota que venía y cuánto pesaba.
        return { text: '', truncated: false, size, binary: true };
    }

    const parsed = safeParse(raw);
    let text = parsed !== null && typeof parsed === 'object'
        ? JSON.stringify(redactJson(parsed, 0))
        : redactFormLike(raw);

    let truncated = false;
    if (text.length > MAX_BODY) {
        text = text.slice(0, MAX_BODY);
        truncated = true;
    }
    return { text, truncated, size };
}

// Cuerpos que no son JSON pero llevan pares llave=valor (form-urlencoded, y de paso
// cualquier `"password":"x"` dentro de un texto que no parseó).
function redactFormLike(raw) {
    let text = String(raw);

    if (/^[^\s{[]+=[^&]*(&|$)/.test(text)) {
        text = text.split('&').map((pair) => {
            const eq = pair.indexOf('=');
            if (eq < 0) return pair;
            const key = pair.slice(0, eq);
            return SECRET_KEY_REGEX.test(key) ? `${key}=***` : pair;
        }).join('&');
    }

    return text.replace(/("(?:[^"\\]|\\.)*?(?:pass|password|contrasena|nip|pin|token|secret|cvv|clave)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"');
}

// ── Archivo de sesión (HAR incremental) ─────────────────────────────────────────

function ready() {
    return ENABLED && !!dir && !initError;
}

// El sello llega al segundo, y en un segundo caben dos sesiones (un login seguido de un
// logout, o dos "guardar ahora"). Sin este desempate el segundo archivo se abría en modo
// anexar sobre el primero: dos documentos HAR en un archivo, que no parsea.
function sessionFileName(user, at) {
    const base = `sesion-${stamp(at)}-${slug(user) || 'sin-sesion'}`;

    for (let i = 1; i < 100; i++) {
        const name = i === 1 ? `${base}.har` : `${base}-${i}.har`;
        if (!fs.existsSync(path.join(dir, name))) return name;
    }
    return `${base}-${Date.now()}.har`;
}

function writeChunk(text) {
    if (!current) return;
    try {
        const buf = Buffer.from(text, 'utf8');
        fs.writeSync(current.fd, buf);
        current.bytes += buf.length;
    } catch (e) {
        // Disco lleno o descriptor caído: la captura se apaga sola, la caja sigue.
        console.warn('[xhr] no se pudo escribir la captura:', e && e.message ? e.message : e);
        try { fs.closeSync(current.fd); } catch { }
        current = null;
        initError = 'escritura fallida';
    }
}

function openSession(reason, user) {
    if (!ready() || current) return null;

    const at = Date.now();
    const name = sessionFileName(user, at);
    const file = path.join(dir, name);

    let fd = null;
    try {
        fd = fs.openSync(file, 'a');
    } catch (e) {
        initError = e && e.message ? e.message : String(e);
        console.warn('[xhr] no se pudo abrir', file, initError);
        return null;
    }

    current = {
        fd,
        file,
        name,
        user: user || '',
        reason: reason || 'arranque',
        startedAt: at,
        entries: 0,
        bytes: 0,
        bodyBytes: 0,
        bodiesOff: false,
        markers: [],
        gaps: []
    };

    const head = '{"log":{"version":"1.2","creator":'
        + JSON.stringify({ name: 'Nestor POS Client', version: appVersion || '0', comment: 'captura de sesiones XHR' })
        + ',"comment":' + JSON.stringify('Sesión XHR capturada por el cliente de Nestor POS. Se abre tal cual en DevTools (Network → importar HAR).'
            + (KEEP_AUTH_HEADERS
                ? ' CONTIENE ENCABEZADOS DE SESIÓN (x-access-token, cookie) para poder reproducir las peticiones: trátese como una credencial, no como un log.'
                : ' Los encabezados de sesión van tapados (NESTOR_XHR_KEEP_AUTH=0).'))
        + ',"_inicio":' + JSON.stringify({
            motivo: current.reason,
            usuario: current.user,
            iniciada: new Date(at).toISOString(),
            equipo: os.hostname(),
            plataforma: `${process.platform} ${os.release()}`,
            tope_cuerpo: MAX_BODY,
            tope_sesion: SESSION_MAX_BYTES,
            // Para que quien reciba el archivo sepa qué tiene en la mano sin leer el código.
            encabezados_de_sesion: KEEP_AUTH_HEADERS ? 'incluidos' : 'tapados',
            credenciales: 'contraseñas, NIP y datos de tarjeta NUNCA se guardan'
        })
        + ',"pages":[],"entries":[\n';

    writeChunk(head);
    console.log(`[xhr] captura abierta: ${file}`);
    return current;
}

function finalizeSession(reason) {
    if (!current) return null;

    const done = current;
    const fin = {
        motivo_cierre: reason || 'cierre',
        cerrada: new Date().toISOString(),
        peticiones: done.entries,
        bytes: done.bytes,
        cuerpos_apagados: done.bodiesOff,
        descartadas: totalDropped,
        eventos: done.markers,
        huecos: done.gaps
    };

    writeChunk('\n],"_fin":' + JSON.stringify(fin) + '}}\n');

    try { fs.closeSync(done.fd); } catch { }
    current = null;

    appendIndex({
        archivo: done.name,
        usuario: done.user,
        motivo: done.reason,
        iniciada: new Date(done.startedAt).toISOString(),
        cerrada: fin.cerrada,
        peticiones: done.entries,
        bytes: done.bytes,
        motivo_cierre: fin.motivo_cierre
    });

    console.log(`[xhr] captura cerrada (${reason}): ${done.file} — ${done.entries} peticiones, ${done.bytes} bytes`);
    return done;
}

// Rueda de archivo: cierra el actual y abre otro. Es lo que ocurre en cada login.
function roll(reason, user) {
    const previous = finalizeSession(reason);
    prune();
    const next = openSession(reason, user);
    if (next && previous) next.markers.push({ t: new Date().toISOString(), tipo: 'viene-de', archivo: previous.name });
    return next;
}

function appendIndex(row) {
    if (!dir) return;
    try {
        fs.appendFileSync(path.join(dir, 'indice.jsonl'), JSON.stringify(row) + '\n');
    } catch { }
}

function note(tipo, data) {
    const marker = Object.assign({ t: new Date().toISOString(), tipo }, data || {});
    if (current) {
        current.markers.push(marker);
        if (current.markers.length > MAX_MARKERS) current.markers.splice(0, current.markers.length - MAX_MARKERS);
    }
    console.log('[xhr]', tipo, data ? JSON.stringify(data) : '');
    return marker;
}

// ── Recuperación y retención ────────────────────────────────────────────────────

function listSessionFiles() {
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.startsWith('sesion-') && f.endsWith('.har'))
            .map((f) => {
                const full = path.join(dir, f);
                let size = 0;
                let mtime = 0;
                try {
                    const st = fs.statSync(full);
                    size = st.size;
                    mtime = st.mtimeMs;
                } catch { }
                return { name: f, file: full, size, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

// Un HAR abierto por un cierre sucio (corte de luz, kill del proceso) no tiene cierre.
// Aquí se le pone: se recorta el último renglón si quedó a medias y se anexa el `_fin`
// marcado como recuperado. El archivo queda abrible como cualquier otro.
function repairSession(file) {
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.size) {
        try { fs.rmSync(file, { force: true }); } catch { }
        return false;
    }

    // Se mira la última ventana del archivo. Todo el recorte se hace sobre el BUFFER y en
    // bytes: medir en caracteres deja medio carácter multibyte vivo y el HAR no parsea.
    const readLen = Math.min(st.size, 1024 * 1024);
    let buf;
    try {
        const fd = fs.openSync(file, 'r');
        buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, st.size - readLen);
        fs.closeSync(fd);
    } catch {
        return false;
    }

    if (buf.includes('"_fin"')) return false; // ya estaba cerrada

    // Se conserva hasta el último renglón que sí parsea. Un cierre sucio deja una línea a
    // medias, no cincuenta: con cuatro pasadas sobra.
    let end = buf.length;
    for (let i = 0; i < 4; i++) {
        const nl = buf.lastIndexOf(0x0A, end - 1);
        if (nl < 0) break;

        const seg = buf.subarray(nl + 1, end).toString('utf8').trim();
        if (!seg) { end = nl; continue; }
        if (safeParse(seg.replace(/^,/, ''))) break;
        end = nl;
    }

    const newSize = (st.size - readLen) + end;

    try {
        if (newSize < st.size) fs.truncateSync(file, newSize);
        fs.appendFileSync(file, '\n],"_fin":' + JSON.stringify({
            motivo_cierre: 'recuperada',
            recuperada: true,
            cerrada: new Date().toISOString(),
            nota: 'La aplicación no cerró limpiamente; el cierre se anexó en el arranque siguiente.'
        }) + '}}\n');
        console.log('[xhr] captura recuperada:', file);
        return true;
    } catch (e) {
        console.warn('[xhr] no se pudo recuperar', file, e && e.message ? e.message : e);
        return false;
    }
}

// Limpieza automática, la misma en toda caja y sin que nadie la dispare. Tres cortes, en
// este orden: caducidad (10 días), número de sesiones y bytes del directorio. El archivo
// que está abierto ahora mismo NUNCA se toca.
function prune() {
    if (!dir) return null;

    const files = listSessionFiles().filter((f) => !current || f.file !== current.file);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const removed = [];
    const remove = (f, motivo) => {
        try {
            fs.rmSync(f.file, { force: true });
            removed.push({ archivo: f.name, bytes: f.size, motivo });
            return true;
        } catch (e) {
            console.warn('[xhr] no se pudo borrar', f.file, e && e.message ? e.message : e);
            return false;
        }
    };

    // 1. Caducadas. Se mide por la fecha del archivo, no por el nombre: renombrar o copiar
    //    una captura no la vuelve eterna, y una sesión que siguió escribiendo caduca desde
    //    su última escritura.
    let kept = [];
    for (const f of files) {
        if (f.mtime && f.mtime < cutoff) remove(f, `caducada (más de ${RETENTION_DAYS} días)`);
        else kept.push(f);
    }

    // 2. Número de sesiones (las más viejas primero: la lista viene descendente).
    for (const f of kept.slice(KEEP_SESSIONS)) remove(f, `sobre el tope de ${KEEP_SESSIONS} sesiones`);
    kept = kept.slice(0, KEEP_SESSIONS);

    // 3. Bytes del directorio.
    let total = kept.reduce((acc, f) => acc + f.size, 0);
    while (total > DIR_MAX_BYTES && kept.length > 1) {
        const oldest = kept.pop();
        if (remove(oldest, 'sobre el tope de bytes del directorio')) total -= oldest.size;
    }

    if (removed.length) {
        pruneIndex();
        console.log(`[xhr] limpieza: ${removed.length} sesiones borradas (${removed.map((r) => r.motivo)[0]}...)`);
    }

    lastSweep = {
        t: new Date().toISOString(),
        borradas: removed.length,
        bytes_liberados: removed.reduce((acc, r) => acc + r.bytes, 0),
        quedan: kept.length + (current ? 1 : 0),
        bytes: total + (current ? current.bytes : 0)
    };

    if (removed.length && current) {
        current.markers.push(Object.assign({ tipo: 'limpieza' }, lastSweep));
    }

    return lastSweep;
}

// El índice es un .jsonl que sólo crece; se recorta a lo que sigue existiendo en disco.
function pruneIndex() {
    const file = path.join(dir, 'indice.jsonl');
    let rows = [];
    try {
        rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(safeParse).filter(Boolean);
    } catch {
        return;
    }

    const vivos = rows.filter((row) => {
        try { return fs.existsSync(path.join(dir, String(row.archivo || ''))); } catch { return false; }
    }).slice(-500);

    if (vivos.length === rows.length) return;
    try {
        fs.writeFileSync(file, vivos.map((r) => JSON.stringify(r)).join('\n') + (vivos.length ? '\n' : ''));
    } catch { }
}

// ── Enganche CDP ────────────────────────────────────────────────────────────────

function isCaptured(p) {
    if (p.type && CAPTURED_TYPES.has(p.type)) return true;

    // El tipo llega en `responseReceived`; si la petición murió antes (sin red, host
    // caído) nos quedamos sin él. Esos son justo los casos que hay que ver, así que
    // la ruta decide: /api/v1 es la API del negocio, la impresora y el EMV.
    if (!p.type) return /\/api\/v\d/.test(String(p.url || ''));
    return false;
}

// Devuelve '' cuando el cuerpo se debe pedir, o el motivo por el que no. El motivo va al
// HAR: "no hay cuerpo" y "el cuerpo pesaba 8 MB" se diagnostican distinto.
function bodySkipReason(p, size) {
    if (!current) return 'sin sesión abierta';
    if (current.bodiesOff) return 'cuerpos apagados: la sesión alcanzó su tope';
    if (!size) return '';

    const mime = p.response && p.response.mimeType ? p.response.mimeType : '';
    if (!TEXT_MIME.test(mime)) return `cuerpo no textual (${mime || 'sin tipo'}): no se guarda`;
    if (size > MAX_BODY * 8) return `cuerpo omitido: ${size} bytes sobre el tope de ${MAX_BODY * 8}`;
    return '';
}

function prunePending(pending) {
    if (pending.size <= MAX_PENDING) return;
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, p] of pending) {
        if (p.startedAt < cutoff) pending.delete(id);
    }
    // Si sigue lleno, se suelta lo más viejo por orden de inserción.
    while (pending.size > MAX_PENDING) {
        const first = pending.keys().next();
        if (first.done) break;
        pending.delete(first.value);
        totalDropped++;
    }
}

// Los listeners de `debugger` y de la ventana se quedan pegados al webContents aunque
// nos desenganchemos, así que se cablean UNA sola vez: re-enganchar tras cerrar DevTools
// no puede duplicar el manejador de mensajes (serían renglones dobles en el HAR).
const wired = new WeakSet();

function attach(webContents, label) {
    if (!ready()) return { ok: false, error: initError || 'captura apagada' };
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: 'sin webContents' };

    const id = webContents.id;
    if (attached.has(id)) return { ok: true, already: true };

    const dbg = webContents.debugger;
    try {
        dbg.attach('1.3');
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        note('enganche-fallido', { label, error: msg });
        return { ok: false, error: msg };
    }

    attached.set(id, { label: label || `wc${id}`, pending: new Map(), wc: webContents, dbg });

    if (!wired.has(webContents)) {
        wired.add(webContents);

        // Todos los manejadores resuelven el estado por `id` en el momento del evento:
        // el que quedó capturado en el closure sería el del primer enganche.
        dbg.on('message', (_event, method, params) => {
            const state = attached.get(id);
            if (!state) return;
            try {
                onCdp(state, method, params);
            } catch (e) {
                console.warn('[xhr] evento CDP falló:', e && e.message ? e.message : e);
            }
        });

        dbg.on('detach', (_event, reason) => {
            const state = attached.get(id);
            attached.delete(id);
            note('desenganchado', { label: state ? state.label : `wc${id}`, motivo: String(reason || '') });
            if (current) current.gaps.push({ desde: new Date().toISOString(), motivo: String(reason || '') });
        });

        // DevTools también es un cliente CDP. Chromium moderno admite varios, pero no en
        // todas las plataformas: si alguien abre DevTools, la captura se aparta y vuelve
        // cuando lo cierra. El hueco queda anotado en el HAR (`_fin.huecos`).
        webContents.on('devtools-opened', () => {
            if (!attached.has(id)) return;
            note('pausa-por-devtools', { label });
            detach(webContents, 'devtools');
        });

        webContents.on('devtools-closed', () => {
            if (attached.has(id)) return;
            note('reanuda-tras-devtools', { label });
            attach(webContents, label);
        });

        webContents.on('destroyed', () => {
            const state = attached.get(id);
            if (state) state.pending.clear();
            attached.delete(id);
        });
    }

    dbg.sendCommand('Network.enable', {
        maxTotalBufferSize: 32 * 1024 * 1024,
        maxResourceBufferSize: 8 * 1024 * 1024,
        maxPostDataSize: MAX_BODY
    }).catch((e) => {
        note('network-enable-fallido', { label, error: e && e.message ? e.message : String(e) });
    });

    note('enganchada', { label, tipos: [...CAPTURED_TYPES] });
    return { ok: true };
}

function detach(webContents, reason) {
    if (!webContents || webContents.isDestroyed()) return { ok: false };
    const state = attached.get(webContents.id);
    if (!state) return { ok: false };

    attached.delete(webContents.id);
    state.pending.clear();
    try { webContents.debugger.detach(); } catch { }
    if (current) current.gaps.push({ desde: new Date().toISOString(), motivo: reason || 'detach' });
    return { ok: true };
}

function onCdp(state, method, params) {
    if (!current) return;

    if (method === 'Network.requestWillBeSent') {
        const { requestId, request, timestamp, wallTime, type, documentURL } = params;
        if (!request) return;

        state.pending.set(requestId, {
            method: request.method || 'GET',
            url: request.url || '',
            headers: request.headers || {},
            postData: request.postData || '',
            hasPostData: !!request.hasPostData,
            postMime: (request.headers && (request.headers['Content-Type'] || request.headers['content-type'])) || '',
            startedAt: wallTime ? Math.round(wallTime * 1000) : Date.now(),
            t0: timestamp || 0,
            type: type || '',
            page: documentURL || '',
            ventana: state.label
        });

        // El cuerpo grande no viene inline: se pide mientras la petición está viva.
        if (request.hasPostData && !request.postData) {
            state.dbg.sendCommand('Network.getRequestPostData', { requestId })
                .then((r) => {
                    const p = state.pending.get(requestId);
                    if (p) p.postData = (r && r.postData) || '';
                })
                .catch(() => { });
        }

        prunePending(state.pending);
        return;
    }

    if (method === 'Network.responseReceived') {
        const p = state.pending.get(params.requestId);
        if (!p) return;
        p.type = params.type || p.type;
        p.response = params.response || {};
        p.tResp = params.timestamp || 0;
        return;
    }

    if (method === 'Network.loadingFinished') {
        const p = state.pending.get(params.requestId);
        if (!p) return;
        state.pending.delete(params.requestId);
        if (!isCaptured(p)) return;

        const ms = p.t0 && params.timestamp ? Math.max(0, Math.round((params.timestamp - p.t0) * 1000)) : 0;
        const size = params.encodedDataLength || (p.response && p.response.encodedDataLength) || 0;

        const skip = bodySkipReason(p, size);
        if (skip) {
            writeEntry(p, { ms, size, bodyError: skip });
            return;
        }

        state.dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((r) => writeEntry(p, { ms, size }, r && r.body, r && r.base64Encoded))
            .catch(() => writeEntry(p, { ms, size, bodyError: 'cuerpo no disponible' }));
        return;
    }

    if (method === 'Network.loadingFailed') {
        const p = state.pending.get(params.requestId);
        if (!p) return;
        state.pending.delete(params.requestId);
        if (!isCaptured(p)) return;

        const ms = p.t0 && params.timestamp ? Math.max(0, Math.round((params.timestamp - p.t0) * 1000)) : 0;
        writeEntry(p, {
            ms,
            size: 0,
            failed: String(params.errorText || 'error de red'),
            canceled: !!params.canceled
        });
    }
}

// ── Renglón HAR ─────────────────────────────────────────────────────────────────

function pathOf(url) {
    try { return new URL(url).pathname; } catch { return String(url || '').split('?')[0]; }
}

function loginUserFrom(p, responseText) {
    const req = safeParse(p.postData);
    if (req && typeof req === 'object' && req.user) return String(req.user);

    const res = safeParse(responseText || '');
    const data = res && (res.data || res);
    if (data && typeof data === 'object') {
        return String(data.username || data.user || (data.user_name || '') || '');
    }
    return '';
}

function writeEntry(p, meta, rawBody, base64Encoded) {
    if (!current) return;

    const status = p.response && p.response.status ? p.response.status : 0;
    const mime = (p.response && p.response.mimeType) || '';
    const body = prepareBody(rawBody, mime, base64Encoded);
    const post = p.postData ? prepareBody(p.postData, p.postMime || 'application/json', false) : null;

    // La sesión de cajero empieza en el login: se cierra el archivo anterior y este
    // renglón —el propio login— es el primero del nuevo.
    const ruta = pathOf(p.url);
    const esLogin = p.method === 'POST' && /\/auth\/login$/.test(ruta) && status >= 200 && status < 300;
    const esLogout = p.method === 'POST' && /\/auth\/logout$/.test(ruta) && status >= 200 && status < 300;

    if (esLogin) {
        const user = loginUserFrom(p, rawBody);
        note('login', { usuario: user || '(sin nombre)', ruta });
        roll('login', user);
        if (!current) return;
        current.markers.push({ t: new Date().toISOString(), tipo: 'login', usuario: user || '' });
    }

    const entry = {
        startedDateTime: new Date(p.startedAt).toISOString(),
        time: meta.ms || 0,
        request: {
            method: p.method,
            url: redactUrl(p.url),
            httpVersion: (p.response && p.response.protocol) || 'HTTP/1.1',
            cookies: [],
            headers: headerList(p.headers),
            queryString: queryList(p.url),
            headersSize: -1,
            bodySize: post ? post.size : 0
        },
        response: {
            status,
            statusText: (p.response && p.response.statusText) || (meta.failed ? 'ERROR' : ''),
            httpVersion: (p.response && p.response.protocol) || 'HTTP/1.1',
            cookies: [],
            headers: headerList(p.response && p.response.headers),
            content: {
                size: body.size || meta.size || 0,
                mimeType: mime || 'application/octet-stream'
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: meta.size || 0
        },
        cache: {},
        timings: { send: 0, wait: meta.ms || 0, receive: 0 },
        _nestor: {
            tipo: p.type || 'XHR',
            ventana: p.ventana,
            pagina: p.page || '',
            sesion: current.name,
            usuario: current.user || ''
        }
    };

    if (post) {
        entry.request.postData = {
            mimeType: p.postMime || 'application/json',
            text: post.text,
            params: []
        };
        if (post.truncated) entry._nestor.peticion_recortada = true;
        if (post.binary) entry._nestor.peticion_binaria = true;
    }

    if (body.text) entry.response.content.text = body.text;
    if (body.truncated) entry._nestor.respuesta_recortada = true;
    if (body.binary) entry.response.content.comment = 'cuerpo binario: no se guarda';
    if (meta.bodyError) entry.response.content.comment = meta.bodyError;
    if (meta.failed) {
        entry._nestor.error = meta.failed;
        entry._nestor.cancelada = !!meta.canceled;
        entry.response.content.comment = meta.failed;
    }
    if (current.bodiesOff) entry._nestor.cuerpos_apagados = true;

    const line = (current.entries ? ',' : '') + JSON.stringify(entry) + '\n';
    writeChunk(line);
    if (!current) return;

    current.entries++;
    totalEntries++;

    if (!current.bodiesOff && current.bytes > SESSION_MAX_BYTES) {
        current.bodiesOff = true;
        note('tope-de-sesion', { bytes: current.bytes, nota: 'a partir de aquí sólo metadatos' });
    }

    if (esLogout) {
        note('logout', { ruta });
        roll('logout', '');
    }
}

// ── API pública ─────────────────────────────────────────────────────────────────

function init(userDataDir, options) {
    appVersion = (options && options.appVersion) || '';

    if (!ENABLED) {
        console.log('[xhr] captura de sesiones APAGADA (NESTOR_XHR_CAPTURE=0)');
        return { ok: false, enabled: false };
    }

    dir = resolveDir(userDataDir);
    tightenDir(dir);
    if (!dir) {
        initError = 'sin directorio escribible';
        console.warn('[xhr] captura deshabilitada:', initError);
        return { ok: false, error: initError };
    }

    // Primero se cierran las capturas que dejó un cierre sucio, luego se poda, y sólo
    // entonces se abre la de esta corrida: así la poda nunca se lleva la nueva.
    for (const f of listSessionFiles()) repairSession(f.file);
    prune();
    openSession('arranque', '');

    // Barrido periódico: la caja se limpia sola aunque no se apague en semanas.
    // `unref` para que este temporizador no sea motivo de que Electron siga vivo.
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(() => {
        try { prune(); } catch (e) {
            console.warn('[xhr] limpieza falló:', e && e.message ? e.message : e);
        }
    }, SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();

    return { ok: !!current, dir, file: current ? current.file : '' };
}

function status() {
    return {
        enabled: ENABLED,
        ok: !!current,
        dir,
        error: initError,
        enganchadas: [...attached.values()].map((s) => s.label),
        tipos: [...CAPTURED_TYPES],
        encabezados_de_sesion: KEEP_AUTH_HEADERS ? 'incluidos' : 'tapados',
        topes: {
            cuerpo: MAX_BODY,
            sesion: SESSION_MAX_BYTES,
            dias_retencion: RETENTION_DAYS,
            sesiones: KEEP_SESSIONS,
            directorio: DIR_MAX_BYTES
        },
        ultima_limpieza: lastSweep,
        sesion: current ? {
            archivo: current.name,
            ruta: current.file,
            usuario: current.user,
            motivo: current.reason,
            iniciada: new Date(current.startedAt).toISOString(),
            peticiones: current.entries,
            bytes: current.bytes,
            cuerpos_apagados: current.bodiesOff
        } : null,
        total_peticiones: totalEntries,
        descartadas: totalDropped
    };
}

function list(limit) {
    const max = Math.max(1, Math.min(200, parseInt(limit, 10) || 30));
    const files = listSessionFiles().slice(0, max);

    let index = [];
    try {
        index = fs.readFileSync(path.join(dir, 'indice.jsonl'), 'utf8')
            .split('\n').filter(Boolean).map(safeParse).filter(Boolean);
    } catch { }

    const byName = new Map(index.map((row) => [row.archivo, row]));

    return {
        ok: true,
        dir,
        sesiones: files.map((f) => Object.assign(
            {
                archivo: f.name,
                ruta: f.file,
                bytes: f.size,
                modificada: new Date(f.mtime).toISOString(),
                abierta: !!current && current.file === f.file
            },
            byName.get(f.name) || {}
        ))
    };
}

// "Guardar la sesión ahora": cierra el archivo actual y sigue capturando en otro. Es lo
// que se pide antes de mandar una captura por correo, sin cerrar el punto de venta.
function saveNow(reason) {
    if (!ready()) return { ok: false, error: initError || 'captura apagada' };
    if (!current) {
        openSession('manual', '');
        return { ok: !!current, error: current ? '' : initError };
    }

    const user = current.user;
    const done = finalizeSession(reason || 'manual');
    prune();
    openSession('continua', user);

    return {
        ok: !!done,
        archivo: done ? done.name : '',
        ruta: done ? done.file : '',
        peticiones: done ? done.entries : 0,
        bytes: done ? done.bytes : 0,
        sigue_en: current ? current.name : ''
    };
}

// Marcador desde el renderer: "aquí falló la venta". Cae en `_fin.eventos` del HAR.
function mark(entry) {
    if (!ready() || !current) return { ok: false, error: initError || 'sin sesión abierta' };
    const data = entry && typeof entry === 'object' ? entry : { nota: String(entry || '') };
    const marker = note(String(data.tipo || 'nota'), Object.assign({ origen: 'renderer' }, data));
    return { ok: true, marcador: marker };
}

function shutdown() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;

    for (const state of [...attached.values()]) {
        try { detach(state.wc, 'cierre'); } catch { }
    }
    attached.clear();
    const done = finalizeSession('cierre-de-la-aplicacion');
    return { ok: !!done, ruta: done ? done.file : '' };
}

module.exports = {
    init,
    attach,
    detach,
    status,
    list,
    saveNow,
    mark,
    note,
    // Adelanta el barrido de retención (lo mismo que corre solo cada 6 horas).
    sweep: () => (ready() ? Object.assign({ ok: true }, prune()) : { ok: false, error: initError || 'captura apagada' }),
    shutdown,
    directory: () => dir
};
