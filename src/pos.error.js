// src/pos.error.js
//
// ERRORES POS — el paquete de incidencia que se arma en la caja y viaja a la nube.
//
// Por qué existe
// --------------
// Cuando `/pos/register-ticket` falla, el cajero ve un aviso y sigue trabajando. Lo que
// hacía falta para entender qué pasó queda repartido en cinco sitios que se borran a
// ritmos distintos y a los que soporte no tiene acceso: el HAR de la sesión y el volcado
// de consola (en el disco de la caja), la base de ventas locales (idem), el anillo de
// consola del servidor (en MEMORIA, 2000 líneas, minutos de vida) y la bitácora de
// requests (en el servidor, que es justo lo que a veces no responde).
//
// Esto los junta EN EL INSTANTE DEL FALLO y los manda a Fact, donde el módulo "Errores POS"
// los muestra por licencia, caja y usuario.
//
// Decisiones que importan
// -----------------------
//  1. **El anillo del servidor se lee AHORA, no al subir.** `GET /system/console-log` es un
//     anillo de 2000 líneas en memoria; con la bitácora SQL activa se consume en minutos.
//     Si se leyera al momento de subir (que puede ser horas después, si la caja estaba sin
//     red) llegaría ruido en lugar del error. Se pide dentro del reporte, con un tope de
//     tiempo corto, y si no contesta se sube el paquete sin esa parte.
//  2. **Sin ZIP: un archivo, una subida.** El HAR de una jornada pesa 60 MB; comprimirlo
//     todo junto en memoria en una caja de gama baja es la forma de que el reporte tumbe el
//     punto de venta. Cada pieza va por su lado (gzip en streaming, trozos de 8 MB), y en el
//     panel se pueden ver y borrar por separado — que es lo que de verdad se necesita para
//     recuperar espacio: casi siempre sobra con tirar el HAR y conservar lo demás.
//  3. **La sesión se CIERRA y se manda entera.** `saveNow()` cierra el .har en curso (queda
//     completo y abrible) y la captura sigue en uno nuevo. Así el paquete lleva la sesión
//     desde el arranque hasta el error, sin recortes, y sin volver a subir esos MB en la
//     siguiente incidencia.
//  4. **Nada de esto bloquea la venta.** Todo el reporte corre fuera del camino del cajero
//     y ningún fallo suyo se propaga: si no se puede armar, se anota y ya.
//  5. **Se deduplica en la caja.** Un 4xx determinista se repite en CADA venta. Sin freno,
//     una caja mal configurada sube cientos de paquetes iguales en una tarde. Se agrupa por
//     (código, licencia, caja) con ventana de 6 h: el primero sube completo y los
//     siguientes sólo incrementan un contador que viaja en el siguiente paquete.
//
// Palancas:
//   NESTOR_POS_ERRORS=0             apaga el reporte por completo
//   NESTOR_POS_ERRORS_WINDOW_MS     ventana de deduplicación (por omisión 6 h)
//   NESTOR_POS_ERRORS_MAX_DAY       tope de paquetes por día (por omisión 20)
//   NESTOR_POS_ERRORS_KEEP_HAR=0    no adjunta el .har (paquetes chicos)

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const ENABLED = String(process.env.NESTOR_POS_ERRORS || '1') !== '0';
const DEDUPE_WINDOW_MS = Math.max(0, parseInt(process.env.NESTOR_POS_ERRORS_WINDOW_MS || '', 10) || 6 * 60 * 60 * 1000);
const MAX_PER_DAY = Math.max(1, parseInt(process.env.NESTOR_POS_ERRORS_MAX_DAY || '', 10) || 20);
const KEEP_HAR = String(process.env.NESTOR_POS_ERRORS_KEEP_HAR || '1') !== '0';

// Cuánto se conserva un paquete que no ha podido subir. Es una CADUCIDAD, no un número de
// intentos: una tienda sin internet medio día no puede perder sus paquetes, y son justo los
// días con la red caída los que más incidencias generan (las ventas se encolan y fallan).
const KEEP_DAYS = Math.max(1, parseInt(process.env.NESTOR_POS_ERRORS_KEEP_DAYS || '', 10) || 7);

// Tope del directorio de la cola. Con la red caída, 20 paquetes al día a ~22 MB llenan un
// disco chico en una semana. Al pasarlo NO se tiran paquetes: se les quitan los adjuntos
// PESADOS a los más viejos (primero el .har, luego la consola) y se conserva el manifiesto,
// que es lo que contesta quién, en qué caja y qué falló. Sólo si aun así no cabe se
// descartan paquetes enteros, del más viejo al más nuevo.
const QUEUE_MAX_BYTES = Math.max(64 * 1024 * 1024,
    parseInt(process.env.NESTOR_POS_ERRORS_MAX_BYTES || '', 10) || 1024 * 1024 * 1024);

// Orden en el que se sacrifican los adjuntos cuando falta espacio. El manifiesto
// (`incidencia.json`) y los dos volcados chicos no se tocan nunca: pesan KB y son los que
// más veces bastan.
const SACRIFICABLES = ['har', 'consola'];

// Tope de lo que se pide al servidor. El anillo son 2000 líneas y la bitácora de errores se
// acota por ventana: los dos caben de sobra aquí y el tope sólo evita una sorpresa.
const SERVER_FETCH_TIMEOUT_MS = 4000;
const SERVER_FETCH_MAX_BYTES = 8 * 1024 * 1024;

let dir = '';                 // cola de paquetes por subir
let initError = '';
let appVersion = '';
let getServerOrigin = () => '';
let xhr = null;
let ledger = null;

// Huellas recientes: llave -> { at, uuid, veces }. Sólo en memoria a propósito: si la caja
// se reinicia, que vuelva a subir un paquete es preferible a perder el primero de una
// racha nueva.
const recientes = new Map();
let hoy = '';
let subidosHoy = 0;

// ── Rutas ───────────────────────────────────────────────────────────────────────

function resolveDir(userDataDir) {
    // Junto a las capturas, no en `userData`: un paquete pendiente de subir tiene que
    // sobrevivir al botón rojo igual que el .har al que apunta.
    const override = String(process.env.NESTOR_POS_ERRORS_DIR || '').trim();
    const candidatos = [];
    if (override) candidatos.push(override);

    if (process.platform === 'win32') {
        const base = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
        candidatos.push(path.join(base, 'NestorPOS', 'errores-pos'));
    } else if (process.platform === 'darwin') {
        candidatos.push(path.join('/Users/Shared', 'NestorPOS', 'errores-pos'));
    } else {
        candidatos.push(path.join('/var/lib', 'nestorpos', 'errores-pos'));
    }
    if (userDataDir) candidatos.push(path.join(userDataDir, 'errores-pos'));
    candidatos.push(path.join(os.homedir(), '.nestorpos', 'errores-pos'));

    for (const c of candidatos) {
        try {
            fs.mkdirSync(c, { recursive: true });
            const probe = path.join(c, '.escritura');
            fs.writeFileSync(probe, String(Date.now()));
            fs.rmSync(probe, { force: true });
            return c;
        } catch { }
    }
    return '';
}

// ── Utilidades ──────────────────────────────────────────────────────────────────

function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function stamp(ms) {
    const d = new Date(ms || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slug(s) {
    return String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .toLowerCase().slice(0, 40);
}

function sha256File(file) {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(file));
    return h.digest('hex');
}

// gzip de archivo a archivo, en streaming: un .har de 60 MB no entra en memoria dos veces.
function gzipFile(src, dst) {
    return new Promise((resolve, reject) => {
        const entrada = fs.createReadStream(src);
        const salida = fs.createWriteStream(dst);
        const gz = zlib.createGzip({ level: 6 });
        entrada.on('error', reject);
        gz.on('error', reject);
        salida.on('error', reject);
        salida.on('close', () => resolve(dst));
        entrada.pipe(gz).pipe(salida);
    });
}

function writeJson(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return file;
}

// ── Lo que aporta el servidor ───────────────────────────────────────────────────

// Se pide con el token del cajero, que es el que tiene el POS: `/system/console-log` y
// `/system/http-log/recent` no exigen ser master (sólo `/engineer` lo exige), así que no
// hace falta ningún permiso nuevo ni una credencial de máquina.
async function fetchServer(ruta, token) {
    const origin = String(getServerOrigin() || '').replace(/\/+$/, '');
    if (!origin || !token) return null;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SERVER_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${origin}/api/v1${ruta}`, {
            headers: { 'x-access-token': token, Accept: 'application/json' },
            signal: ctrl.signal
        });
        if (!res.ok) return { _error: `HTTP ${res.status}` };
        const texto = await res.text();
        if (texto.length > SERVER_FETCH_MAX_BYTES) {
            return { _error: `respuesta de ${texto.length} bytes, sobre el tope` };
        }
        try { return JSON.parse(texto); } catch { return { _crudo: texto.slice(0, 65536) }; }
    } catch (e) {
        return { _error: String((e && e.message) || e) };
    } finally {
        clearTimeout(t);
    }
}


// ── Armado del paquete ──────────────────────────────────────────────────────────

function ready() {
    return ENABLED && !!dir && !initError;
}

function dedupeKey(info) {
    const id = xhr ? xhr.currentIdentity() : {};
    return [String(info.code || info.message || 'sin-codigo').slice(0, 80),
            id.license_number || '', id.sale_spot_id || 0].join('|');
}

// ¿Se sube este error o ya está representado por uno reciente? Devuelve el registro
// anterior cuando se suprime, para que el llamador sepa a cuál pertenece.
function shouldReport(info) {
    const dia = new Date().toISOString().slice(0, 10);
    if (dia !== hoy) { hoy = dia; subidosHoy = 0; }
    if (subidosHoy >= MAX_PER_DAY) return { report: false, reason: 'tope-diario' };

    const llave = dedupeKey(info);
    const previo = recientes.get(llave);
    const ahora = Date.now();

    if (previo && ahora - previo.at < DEDUPE_WINDOW_MS) {
        previo.veces++;
        previo.lastAt = ahora;
        return { report: false, reason: 'repetido', uuid: previo.uuid, veces: previo.veces };
    }

    recientes.set(llave, { at: ahora, lastAt: ahora, uuid: '', veces: 1 });
    // El mapa no puede crecer sin fin: se sueltan las huellas caducadas.
    for (const [k, v] of recientes) {
        if (ahora - v.lastAt > DEDUPE_WINDOW_MS * 2) recientes.delete(k);
    }
    return { report: true, llave };
}

/**
 * Arma el paquete de incidencia y lo deja en la cola. Nunca lanza.
 *
 * `info` viene del POS: { code, message, status, phase, ticket, response, journal_key, ... }
 */
async function report(info) {
    if (!ready()) return { ok: false, error: initError || 'reporte de errores apagado' };

    const dato = info && typeof info === 'object' ? info : { message: String(info || '') };
    const decision = shouldReport(dato);
    if (!decision.report) {
        // Suprimido por repetido: no se arma otro paquete (serían los mismos 22 MB), pero
        // el contador SÍ tiene que llegar a la nube — sin él, una caja que lleva toda la
        // tarde sin poder vender se ve en el panel igual que un caso aislado.
        if (decision.uuid) bumpOccurrences(decision.uuid, decision.veces);
        return { ok: true, reported: false, reason: decision.reason, veces: decision.veces || 0 };
    }

    const id = xhr ? xhr.currentIdentity() : {};
    const token = String(dato.token || id.token || '');
    const at = Date.now();
    const incidente = uuid();

    try {
        const carpeta = path.join(dir, incidente);
        fs.mkdirSync(carpeta, { recursive: true });

        const archivos = [];
        const adjuntar = (nombre, ruta, clase) => {
            try {
                const st = fs.statSync(ruta);
                if (st.size > 0) archivos.push({ nombre, ruta, clase, bytes: st.size, sha256: sha256File(ruta) });
            } catch { }
        };

        // 1. El servidor, AHORA. Las dos peticiones en paralelo y con tope de tiempo: si el
        //    servidor es justo lo que está caído, el paquete sale igual, sin esta parte.
        const [consola, errores] = await Promise.all([
            fetchServer('/system/console-log', token),
            fetchServer('/engineer/http-error-logs?limit=200', token)
        ]);
        adjuntar('servidor.json', writeJson(path.join(carpeta, 'servidor.json'), {
            tomado: new Date().toISOString(),
            nota: 'Anillo de consola del servidor (2000 líneas, en memoria) leído en el instante del fallo.',
            consola_del_servidor: consola,
            bitacora_de_errores: errores
        }), 'servidor');

        // 2. Ventas en local: el estado de la base y la venta que falló, no la base entera.
        if (ledger) {
            try {
                adjuntar('ventas-local.json', writeJson(path.join(carpeta, 'ventas-local.json'), {
                    tomado: new Date().toISOString(),
                    estado: ledger.stats(),
                    integridad: ledger.verify(200000),
                    archivados: ledger.archives(),
                    ventas: ledger.exportAll({ limit: 500 })
                }), 'ventas');
            } catch (e) {
                console.warn('[errores-pos] no se pudo volcar el ledger:', e && e.message);
            }
        }

        // 3. La sesión XHR completa + su consola. `saveNow` cierra la que está en curso
        //    (queda abrible tal cual en DevTools) y la captura sigue en una nueva.
        let sesion = null;
        if (xhr) {
            try {
                sesion = xhr.saveNow('error-pos');
                if (sesion && sesion.ok) {
                    if (KEEP_HAR && sesion.ruta) {
                        const gz = path.join(carpeta, sesion.archivo + '.gz');
                        await gzipFile(sesion.ruta, gz);
                        adjuntar(path.basename(gz), gz, 'har');
                    }
                    if (sesion.ruta_consola) {
                        const gz = path.join(carpeta, sesion.consola + '.gz');
                        await gzipFile(sesion.ruta_consola, gz);
                        adjuntar(path.basename(gz), gz, 'consola');
                    }
                }
            } catch (e) {
                console.warn('[errores-pos] no se pudo adjuntar la sesión:', e && e.message);
            }
        }

        // 4. El manifiesto. Es lo que viaja primero y lo que el panel indexa: tiene que
        //    bastarse solo para responder "quién, en qué caja, con qué versión y qué falló"
        //    aunque los adjuntos se hayan borrado para recuperar espacio.
        const manifiesto = {
            incident_uuid: incidente,
            occurred_at: new Date(at).toISOString(),
            error_code: String(dato.code || '').slice(0, 80),
            error_message: String(dato.message || '').slice(0, 1000),
            http_status: parseInt(dato.status, 10) || 0,
            phase: String(dato.phase || 'register-ticket').slice(0, 60),
            endpoint: String(dato.endpoint || '/pos/register-ticket').slice(0, 120),

            license_number: id.license_number || '',
            sale_spot_id: id.sale_spot_id || 0,
            sale_spot_name: id.sale_spot_name || '',
            user_name: id.user_name || dato.user_name || '',
            business_name: id.business_name || '',

            client_version: appVersion || '',
            frontend_build: String(dato.frontend_build || '').slice(0, 80),
            platform: `${process.platform} ${os.release()}`,
            hostname: os.hostname(),

            ticket_uuid: String(dato.ticket_uuid || '').slice(0, 120),
            client_invoice_id: String(dato.client_invoice_id || '').slice(0, 120),
            folio: String(dato.folio || '').slice(0, 60),
            journal_key: String(dato.journal_key || '').slice(0, 120),
            total: parseInt(dato.total, 10) || 0,

            // Repeticiones agrupadas bajo esta incidencia. Arranca en 1 y sube con cada
            // fallo suprimido por la deduplicación (ver bumpOccurrences).
            occurrences: 1,

            session_file: sesion && sesion.archivo ? sesion.archivo : '',
            session_started: sesion && sesion.iniciada ? sesion.iniciada : '',
            session_requests: sesion && sesion.peticiones ? sesion.peticiones : 0,

            detalle: dato.detail || dato.response || null,
            archivos: archivos.map((a) => ({ nombre: a.nombre, clase: a.clase, bytes: a.bytes, sha256: a.sha256 }))
        };
        writeJson(path.join(carpeta, 'incidencia.json'), manifiesto);

        const cola = {
            incident_uuid: incidente,
            creado: new Date(at).toISOString(),
            intentos: 0,
            proximo_intento: 0,
            manifiesto,
            archivos
        };
        writeJson(path.join(carpeta, 'cola.json'), cola);

        const marca = recientes.get(decision.llave);
        if (marca) marca.uuid = incidente;
        subidosHoy++;

        console.log(`[errores-pos] incidencia ${incidente} (${manifiesto.error_code || 'sin código'}): ` +
            `${archivos.length} archivos, ${archivos.reduce((a, f) => a + f.bytes, 0)} bytes`);

        // Con la red caída los paquetes se acumulan: se poda AQUÍ, en cuanto entra uno
        // nuevo, y no sólo en el temporizador — así el disco nunca depende de que alguien
        // deje la caja encendida el tiempo suficiente.
        try { pruneQueue(); } catch (e) {
            console.warn('[errores-pos] la poda de la cola falló:', e && e.message);
        }

        if (xhr) {
            xhr.note('error-pos', { incidente, codigo: manifiesto.error_code, folio: manifiesto.folio });
        }

        flush();
        return { ok: true, reported: true, incident_uuid: incidente, archivos: archivos.length };
    } catch (e) {
        const msg = String((e && e.message) || e);
        console.warn('[errores-pos] no se pudo armar la incidencia:', msg);
        return { ok: false, error: msg };
    }
}

// Actualiza el contador de repeticiones de una incidencia YA subida.
//
// No hay endpoint nuevo: se encola un refresco de SÓLO MANIFIESTO con el mismo
// `incident_uuid`. La ingesta de Fact es idempotente por ese campo, así que el manifiesto
// vuelve a caer sobre la misma fila y sólo cambia el contador. Sin adjuntos, la subida son
// unos KB.
//
// Con freno: esto se llama en CADA venta fallida de una racha, y refrescar el manifiesto
// cientos de veces por tarde sería peor que el problema que resuelve.
const BUMP_EVERY_MS = 5 * 60 * 1000;
const ultimoBump = new Map();

function bumpOccurrences(incidente, veces) {
    if (!ready() || !incidente || !(veces > 1)) return;

    const previo = ultimoBump.get(incidente) || 0;
    if (Date.now() - previo < BUMP_EVERY_MS) return;
    ultimoBump.set(incidente, Date.now());

    try {
        // SIEMPRE en carpeta aparte, nunca tocando la cola del paquete original —aunque
        // siga sin subir—. `flush()` lee `cola.json` a memoria y luego espera a la red:
        // escribir sobre ese archivo mientras tanto no cambia lo que se está subiendo y
        // encima la carpeta se borra al confirmar, así que el contador se perdía. Un
        // refresco propio no tiene esa carrera y cuesta unos KB.
        const refresco = path.join(dir, incidente + '-rep');
        fs.mkdirSync(refresco, { recursive: true });

        const anterior = fs.existsSync(path.join(refresco, 'cola.json'))
            ? readCola(path.join(refresco, 'cola.json'))
            : null;
        const manifiesto = anterior && anterior.manifiesto
            ? anterior.manifiesto
            : { incident_uuid: incidente };

        manifiesto.occurrences = veces;
        writeJson(path.join(refresco, 'cola.json'), {
            incident_uuid: incidente,
            creado: new Date().toISOString(),
            intentos: 0,
            proximo_intento: 0,
            solo_manifiesto: true,
            manifiesto,
            archivos: []
        });
        flush();
    } catch (e) {
        console.warn('[errores-pos] no se pudo actualizar el contador:', e && e.message);
    }
}

// ── Cola y subida ───────────────────────────────────────────────────────────────

const CHUNK_BYTES = 8 * 1024 * 1024;
let flushing = false;
// Alguien pidió vaciar la cola mientras ya se estaba vaciando. No se puede ignorar: la
// petición suele venir justo del momento que importa —acaba de volver la red, o soporte
// tocó el botón— y descartarla dejaría la cola esperando al temporizador de 5 minutos.
// Se anota y se repasa al terminar, una sola vez más.
let flushWanted = false;
let flushTimer = null;

// En orden de creación, no el del sistema de archivos. Importa: el refresco del contador
// de una incidencia (`<uuid>-rep`) sólo tiene sentido después de su paquete original, y
// `readdirSync` no garantiza ningún orden.
function pendientes() {
    if (!dir) return [];
    try {
        return fs.readdirSync(dir)
            .filter((d) => !d.startsWith('.'))
            .map((d) => path.join(dir, d, 'cola.json'))
            .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } })
            .map((f) => ({ f, creado: (readCola(f) || {}).creado || '' }))
            .sort((a, b) => String(a.creado).localeCompare(String(b.creado)))
            .map((x) => x.f);
    } catch {
        return [];
    }
}

function readCola(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Multipart a mano: son cuatro campos y un trozo de archivo, y traer una dependencia por
// esto en un binario que se distribuye a cientos de cajas no compensa.
function multipart(campos, archivo) {
    const frontera = '----NestorPosError' + crypto.randomBytes(12).toString('hex');
    const partes = [];
    for (const [k, v] of Object.entries(campos)) {
        partes.push(Buffer.from(
            `--${frontera}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
    }
    if (archivo) {
        partes.push(Buffer.from(
            `--${frontera}\r\nContent-Disposition: form-data; name="file"; filename="${archivo.nombre}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n', 'utf8'));
        partes.push(archivo.datos);
        partes.push(Buffer.from('\r\n', 'utf8'));
    }
    partes.push(Buffer.from(`--${frontera}--\r\n`, 'utf8'));
    return { body: Buffer.concat(partes), contentType: `multipart/form-data; boundary=${frontera}` };
}

async function postJson(ruta, token, cuerpo) {
    const origin = String(getServerOrigin() || '').replace(/\/+$/, '');
    if (!origin) throw new Error('sin origen del servidor');
    const res = await fetch(`${origin}/api/v1${ruta}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-token': token || '' },
        body: JSON.stringify(cuerpo)
    });
    const texto = await res.text();
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${texto.slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }
    try { return JSON.parse(texto); } catch { return {}; }
}

async function subirArchivo(incidente, token, archivo) {
    const origin = String(getServerOrigin() || '').replace(/\/+$/, '');
    const total = Math.max(1, Math.ceil(archivo.bytes / CHUNK_BYTES));
    const uploadId = incidente + '-' + slug(archivo.nombre);
    const fd = fs.openSync(archivo.ruta, 'r');

    try {
        for (let i = 0; i < total; i++) {
            const largo = Math.min(CHUNK_BYTES, archivo.bytes - i * CHUNK_BYTES);
            const buf = Buffer.alloc(largo);
            fs.readSync(fd, buf, 0, largo, i * CHUNK_BYTES);

            const { body, contentType } = multipart({
                incident_uuid: incidente,
                file_name: archivo.nombre,
                kind: archivo.clase,
                sha256: archivo.sha256,
                total_bytes: String(archivo.bytes),
                upload_id: uploadId,
                chunk_index: String(i),
                total_chunks: String(total)
            }, { nombre: archivo.nombre, datos: buf });

            const res = await fetch(`${origin}/api/v1/system/pos-errors/file`, {
                method: 'POST',
                headers: { 'Content-Type': contentType, 'x-access-token': token || '' },
                body
            });
            if (!res.ok) {
                const texto = await res.text();
                const err = new Error(`HTTP ${res.status} en el trozo ${i + 1}/${total}: ${texto.slice(0, 200)}`);
                err.status = res.status;
                throw err;
            }
        }
    } finally {
        try { fs.closeSync(fd); } catch { }
    }
    return true;
}

// 4xx = rechazo definitivo (salvo 401/408/429, que se arreglan solos con otra sesión o con
// tiempo). Reintentar un rechazo definitivo doce veces sólo gasta red de la caja.
function esDefinitivo(err) {
    const s = err && err.status;
    if (!s || s < 400 || s >= 500) return false;
    return s !== 401 && s !== 408 && s !== 429;
}

function backoff(intentos) {
    const base = Math.min(60000 * Math.pow(2, Math.max(0, intentos - 1)), 30 * 60 * 1000);
    return base + Math.floor(Math.random() * 10000);
}

// Bytes que ocupa un paquete en la cola (sus adjuntos, que es todo lo que pesa).
function pesoDe(carpeta) {
    let total = 0;
    try {
        for (const f of fs.readdirSync(carpeta)) {
            try { total += fs.statSync(path.join(carpeta, f)).size; } catch { }
        }
    } catch { }
    return total;
}

// Quita de un paquete el adjunto pesado que toque, conservando el manifiesto y los volcados
// chicos. Devuelve los bytes liberados, o 0 si ya no queda nada que sacrificar.
function aligerar(file, cola) {
    const carpeta = path.dirname(file);

    for (const clase of SACRIFICABLES) {
        const idx = (cola.archivos || []).findIndex((a) => a.clase === clase);
        if (idx < 0) continue;

        const a = cola.archivos[idx];
        let bytes = 0;
        try { bytes = fs.statSync(a.ruta).size; } catch { bytes = 0; }
        try { fs.rmSync(a.ruta, { force: true }); } catch { }

        cola.archivos.splice(idx, 1);
        cola.aligerado = cola.aligerado || [];
        cola.aligerado.push({ archivo: a.nombre, clase, bytes, t: new Date().toISOString() });

        // El manifiesto también lo dice: en el panel tiene que verse que ese adjunto no
        // falta por un error, sino porque la caja se quedó sin espacio esperando red.
        if (cola.manifiesto) {
            cola.manifiesto.archivos = (cola.manifiesto.archivos || []).filter((x) => x.clase !== clase);
            cola.manifiesto.error_message = String(cola.manifiesto.error_message || '');
            cola.manifiesto.aligerado = cola.aligerado;
        }
        writeJson(file, cola);

        console.warn(`[errores-pos] incidencia ${cola.incident_uuid}: se soltó el adjunto ` +
            `"${clase}" (${bytes} bytes) para no llenar el disco esperando red`);
        return bytes;
    }
    return 0;
}

/**
 * Poda de la cola. Dos cortes, en este orden:
 *
 *   1. **Caducidad.** Un paquete que lleva más de KEEP_DAYS sin poder subir ya no se
 *      diagnostica con él; se va entero.
 *   2. **Bytes del directorio.** Al pasar el tope NO se tiran paquetes: se les quitan los
 *      adjuntos pesados a los más viejos y se conserva el manifiesto. Sólo si aun así no
 *      cabe se descartan enteros. Perder el .har de una incidencia vieja es barato; perder
 *      la incidencia es lo que este módulo existe para evitar.
 */
function pruneQueue() {
    if (!dir) return null;

    const soltados = [];
    const paquetes = pendientes().map((f) => {
        const cola = readCola(f) || {};
        return { file: f, carpeta: path.dirname(f), cola, creado: cola.creado || '', bytes: pesoDe(path.dirname(f)) };
    });

    const corte = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    let vivos = [];
    for (const p of paquetes) {
        const t = Date.parse(p.creado);
        if (Number.isFinite(t) && t < corte) {
            try { fs.rmSync(p.carpeta, { recursive: true, force: true }); } catch { }
            soltados.push({ uuid: p.cola.incident_uuid, motivo: `caducado (${KEEP_DAYS} días sin subir)`, bytes: p.bytes });
        } else {
            vivos.push(p);
        }
    }

    // Del más viejo al más nuevo: es a los viejos a los que se les quita el peso.
    vivos.sort((a, b) => String(a.creado).localeCompare(String(b.creado)));
    let total = vivos.reduce((acc, p) => acc + p.bytes, 0);

    for (const p of vivos) {
        while (total > QUEUE_MAX_BYTES) {
            const liberado = aligerar(p.file, p.cola);
            if (!liberado) break;
            total -= liberado;
            p.bytes -= liberado;
        }
        if (total <= QUEUE_MAX_BYTES) break;
    }

    // Última red: si ni soltando adjuntos cabe, se descartan paquetes enteros.
    while (total > QUEUE_MAX_BYTES && vivos.length) {
        const p = vivos.shift();
        try { fs.rmSync(p.carpeta, { recursive: true, force: true }); } catch { }
        total -= p.bytes;
        soltados.push({ uuid: p.cola.incident_uuid, motivo: 'sobre el tope de bytes de la cola', bytes: p.bytes });
    }

    if (soltados.length) {
        console.warn(`[errores-pos] poda de la cola: ${soltados.length} paquetes descartados`);
    }
    return { descartados: soltados, bytes: total, paquetes: vivos.length };
}

/** Intenta subir lo que haya en la cola. Nunca lanza; se puede llamar tan seguido como se quiera. */
async function flush() {
    if (!ready()) return { ok: false, error: initError || 'reporte de errores apagado' };
    if (flushing) {
        flushWanted = true;
        return { ok: true, skipped: true, reason: 'ya había uno en curso; se repasará al terminar' };
    }

    const id = xhr ? xhr.currentIdentity() : {};
    const token = String(id.token || '');
    if (!token) return { ok: true, skipped: true, reason: 'sin sesión' };

    flushing = true;
    let subidos = 0;
    try {
        for (const file of pendientes()) {
            const cola = readCola(file);
            if (!cola) continue;
            if (cola.proximo_intento && Date.now() < cola.proximo_intento) continue;

            const carpeta = path.dirname(file);
            try {
                await postJson('/system/pos-errors', token, cola.manifiesto);

                for (const a of cola.archivos) {
                    try { if (!fs.statSync(a.ruta).isFile()) continue; } catch { continue; }
                    await subirArchivo(cola.incident_uuid, token, a);
                }

                await postJson('/system/pos-errors/complete', token, {
                    incident_uuid: cola.incident_uuid,
                    archivos: cola.archivos.map((a) => a.nombre)
                });

                // Subida confirmada: la copia local sobra. Los originales (el .har de la
                // carpeta de capturas, la base) no se tocan — aquí sólo vivían las copias
                // comprimidas del paquete.
                fs.rmSync(carpeta, { recursive: true, force: true });
                subidos++;
                console.log(`[errores-pos] incidencia ${cola.incident_uuid} subida`);
            } catch (e) {
                cola.intentos = (cola.intentos || 0) + 1;
                cola.ultimo_error = String((e && e.message) || e);

                // Un rechazo DEFINITIVO se descarta en el acto: Fact no lo va a aceptar
                // mañana tampoco. Todo lo demás —sin red, servidor caído, 401— se reintenta
                // mientras el paquete no caduque. Contar intentos era el error: con la
                // espera creciente, doce intentos son tres horas y media, así que una
                // tienda con el internet caído medio día perdía todo lo del día.
                if (esDefinitivo(e)) {
                    console.warn(`[errores-pos] incidencia ${cola.incident_uuid} rechazada por el ` +
                        `servidor: ${cola.ultimo_error}`);
                    fs.rmSync(carpeta, { recursive: true, force: true });
                } else {
                    // Se RELEE antes de escribir y sólo se tocan los campos del reintento:
                    // entre que este flush leyó la cola y falló la red pudo pasar la poda y
                    // soltar un adjunto (`aligerar`). Escribir la copia en memoria lo
                    // resucitaría en el manifiesto — el archivo ya no está en disco.
                    const enDisco = readCola(file) || cola;
                    enDisco.intentos = cola.intentos;
                    enDisco.ultimo_error = cola.ultimo_error;
                    enDisco.proximo_intento = Date.now() + backoff(cola.intentos);
                    writeJson(file, enDisco);
                    if (cola.intentos === 1 || cola.intentos % 20 === 0) {
                        console.warn(`[errores-pos] incidencia ${cola.incident_uuid} sigue sin subir ` +
                            `(intento ${cola.intentos}): ${cola.ultimo_error}`);
                    }
                }
            }
        }
    } finally {
        flushing = false;
    }

    if (flushWanted) {
        flushWanted = false;
        const otra = await flush();
        return { ok: true, subidos: subidos + ((otra && otra.subidos) || 0) };
    }
    return { ok: true, subidos };
}

function status() {
    const cola = pendientes().map((f) => readCola(f)).filter(Boolean);

    // Antigüedad del paquete más viejo sin subir. Es el número con el que soporte se entera
    // de que una caja lleva días sin poder hablar con la nube, en vez de descubrirlo al ir
    // a buscar una incidencia que nunca llegó.
    let masViejoMs = 0;
    for (const c of cola) {
        const t = Date.parse(c.creado);
        if (Number.isFinite(t)) masViejoMs = Math.max(masViejoMs, Date.now() - t);
    }

    return {
        enabled: ENABLED,
        ok: ready(),
        error: initError,
        dir,
        pendientes: cola.length,
        atorada_horas: masViejoMs ? Math.round(masViejoMs / 3600000) : 0,
        dias_retencion: KEEP_DAYS,
        tope_bytes: QUEUE_MAX_BYTES,
        bytes_pendientes: cola.reduce((a, c) => a + (c.archivos || []).reduce((b, x) => b + (x.bytes || 0), 0), 0),
        subidos_hoy: subidosHoy,
        tope_diario: MAX_PER_DAY,
        ventana_dedupe_ms: DEDUPE_WINDOW_MS,
        recientes: [...recientes.entries()].map(([k, v]) => ({ llave: k, veces: v.veces, uuid: v.uuid })),
        items: cola.map((c) => ({
            incident_uuid: c.incident_uuid,
            creado: c.creado,
            intentos: c.intentos,
            codigo: c.manifiesto ? c.manifiesto.error_code : '',
            aligerado: (c.aligerado || []).map((a) => a.clase),
            ultimo_error: c.ultimo_error || ''
        }))
    };
}

function init(userDataDir, options) {
    const o = options || {};
    appVersion = String(o.appVersion || '');
    getServerOrigin = typeof o.serverOrigin === 'function' ? o.serverOrigin : () => '';
    xhr = o.xhr || null;
    ledger = o.ledger || null;

    if (!ENABLED) {
        console.log('[errores-pos] reporte de errores APAGADO (NESTOR_POS_ERRORS=0)');
        return { ok: false, enabled: false };
    }

    dir = resolveDir(userDataDir);
    if (!dir) {
        initError = 'sin directorio escribible';
        console.warn('[errores-pos] deshabilitado:', initError);
        return { ok: false, error: initError };
    }
    if (process.platform !== 'win32') {
        try { fs.chmodSync(dir, 0o700); } catch { }
    }

    // Reintento periódico: una caja sin red guarda el paquete y lo sube cuando vuelve.
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => {
        try { pruneQueue(); } catch { }
        flush().catch(() => { });
    }, 5 * 60 * 1000);
    if (flushTimer.unref) flushTimer.unref();

    // Al arrancar: primero se poda lo caducado de la corrida anterior y luego se intenta
    // subir. Una caja que estuvo apagada una semana no arranca con la cola llena.
    try { pruneQueue(); } catch { }

    const cola = pendientes().length;
    console.log(`[errores-pos] cola en ${dir}` + (cola ? ` (${cola} pendientes)` : ''));
    flush().catch(() => { });
    return { ok: true, dir, pendientes: cola };
}

function shutdown() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
}

module.exports = { init, shutdown, report, flush, status, directory: () => dir };
