// src/ledger.js
//
// VENTAS EN LOCAL — la base de datos de la caja, la que no se borra.
//
// Por qué existe
// --------------
// El POS ya lleva una bitácora local de tickets (NestorPOS_Frontend/src/pos/ticket.journal.js)
// y la empuja al servidor. Las dos tienen el mismo techo:
//
//   * la del navegador vive en `localStorage`, y eso se lo lleva un "limpiar datos de
//     navegación", un perfil de Chromium corrupto, un cambio de máquina o el propio botón
//     rojo del cliente;
//   * la del servidor sólo existe si el servidor estaba encendido, que es justo lo que
//     falla cuando más importa.
//
// Esto es el tercer ejemplar, el que se queda EN LA CAJA: un SQLite fuera del perfil de
// Electron, que el proceso principal mantiene abierto de arranque a cierre y del que no se
// borra nada.
//
// Con dos salidas, y sólo dos. La primera, `archive()`, es la retención: a los 180 días una
// venta YA RESUELTA (registrada, descartada, revisada o retirada) sale de la base — pero no
// se pierde ni se puede ocultar. Sale a un `.jsonl.gz` firmado que queda en el mismo
// directorio, y en la base se queda el ANCLA: un renglón en `ledger_archives` con el rango
// de eventos retirado, el hash del último y el SHA-256 del archivo, más un evento
// `archivo` en la propia cadena. `verify()` arranca desde el ancla, así que sigue diciendo
// "alterada" si alguien saca eventos por su cuenta: archivar es la única forma de quitar
// algo, y deja recibo. Una venta SIN resolver no se archiva por vieja que sea — es
// exactamente la que no puede desaparecer.
//
// La segunda: `remove()` retira a mano una venta que NUNCA se consolidó
// (una prueba, una captura duplicada, algo que jamás va a registrarse). Y "retirar" es una
// LÁPIDA, no un DELETE: el renglón desaparece de los listados y de los conteos, pero se
// queda en la base con quién lo quitó, cuándo y por qué. Una venta que sí llegó al servidor
// no se puede retirar. Ver remove() para las tres razones.
//
// Qué lo hace difícil de eliminar (en orden de peso real)
// ------------------------------------------------------
//  1. **Vive fuera de `userData`.** El borrado de caché del cliente (`runCacheClear`) opera
//     sobre `userData/www`, la sesión de Chromium y el localStorage del renderer. Ninguno
//     de esos caminos llega hasta aquí, ni siquiera el preset `full` del botón rojo.
//  2. **El archivo se queda abierto.** SQLite abre sin `FILE_SHARE_DELETE`, así que en
//     Windows —el sistema real de las cajas— el archivo NO se puede borrar mientras Nestor
//     POS esté corriendo. Hay que cerrar el punto de venta para intentarlo siquiera.
//  3. **DELETE está prohibido en la propia base.** Cada tabla lleva un trigger
//     `BEFORE DELETE ... RAISE(ABORT)`. No es una regla de esta aplicación: la respeta
//     cualquiera que abra el archivo, incluido el `sqlite3` de línea de comandos. El retiro
//     manual no lo esquiva —marca el renglón, no lo borra—, así que el trigger sigue
//     valiendo para todo.
//  4. **Los eventos son inmutables y encadenados.** `ticket_events` no admite UPDATE y
//     cada renglón sella el anterior (`prev_hash` → `row_hash`, SHA-256). Quitar,
//     reordenar o retocar un evento rompe la cadena y `verify()` dice exactamente dónde.
//  5. **Hay un segundo ejemplar.** Cada evento se anexa además a un `.jsonl` en otro
//     directorio; borrar la base deja el rastro en el archivo de texto, y viceversa.
//
// Lo que NO pretende ser: a prueba de un administrador decidido con la caja apagada. Un
// usuario con permisos y tiempo puede borrar cualquier archivo. Lo que se persigue es que
// no se pierda por accidente, por una limpieza de rutina, por reinstalar el cliente o por
// un formateo del perfil — que es como se pierden de verdad.
//
// Modelo de datos
// ---------------
//   ticket_events   append-only, encadenado. LA VERDAD. Nunca se actualiza ni se borra.
//   tickets         proyección del estado actual de cada venta (sí se actualiza, nunca se
//                   borra ni cambia de identidad; `deleted_at > 0` = retirada a mano).
//   ticket_products renglones de la venta, versionados por `rev`: una recaptura agrega una
//                   revisión nueva en vez de pisar la anterior.
//   emv_vouchers    todo intento con la terminal, aprobado o no, con el texto íntegro de
//                   los vouchers de comercio y de cliente.
//
// Todos los importes viajan en millonésimas (1_000_000 = $1.00), igual que en el resto del
// sistema.

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
    // Electron sin `node:sqlite` (build muy anterior): el ledger queda deshabilitado y el
    // POS sigue funcionando con su bitácora de localStorage. Se avisa una vez, fuerte.
    console.error('[ledger] node:sqlite no disponible en este runtime:', err && err.message);
}

// Nombre de los archivos. Deliberadamente descriptivo y en español: quien lo encuentre en
// el disco de una caja tiene que entender qué es sin preguntar.
const DB_FILENAME = 'ventas-local.db';
const SHADOW_FILENAME = 'ventas-local.jsonl';

// Versión del esquema. Sólo sube; las migraciones son aditivas (ver ensureSchema).
// v2: `ledger_guard` + `ledger_archives` (retención por archivado con ancla).
const SCHEMA_VERSION = 2;

// Retención: 180 días de ventas RESUELTAS en la base viva. Lo anterior se archiva.
// A ~190 tickets/día una caja ocupada llega a unos 340 MB en ese plazo, que es lo que se
// puede copiar y consultar sin que la base estorbe.
const RETENTION_DAYS = Math.max(30, parseInt(process.env.NESTOR_LEDGER_RETENTION_DAYS || '180', 10) || 180);

// Cada cuánto se comprueba si toca archivar. Corre al abrir y luego junto al consolidado
// del WAL: una caja se queda semanas encendida y nadie va a dispararlo a mano.
const ARCHIVE_EVERY_MS = 6 * 60 * 60 * 1000;
let lastArchiveCheck = 0;

// Estados en los que una venta se considera RESUELTA y por tanto archivable. Todo lo demás
// —cobrada sin registrar, en cola, fallida, rechazada— se queda en la base viva por muy
// antigua que sea: son las que alguien todavía tiene que atender.
const RESOLVED_FOR_ARCHIVE = ['registered', 'discarded'];

// La misma lista, lista para incrustar en SQL. Se arma aquí y no a mano en cada consulta
// para que no haya dos definiciones de "resuelta" que puedan separarse.
const RESOLVED_SQL_IN = RESOLVED_FOR_ARCHIVE.map((s) => `'${s}'`).join(', ');

// Tope del texto que se guarda por evento. Un voucher completo cabe de sobra; lo que se
// corta son los volcados accidentales.
const MAX_DETAIL = 500;

// Estados en los que la venta está de verdad en riesgo: al `.jsonl` va también el ticket
// completo, no sólo el resumen.
const RISKY = ['charged', 'closing', 'queued', 'failed', 'discarded', 'rejected'];

// Base de una referencia EMV = el uuid del ticket con el que se pidió el cobro, que es
// justamente el `ticket_key` de su venta.
//
// La referencia es única POR INTENTO: el primero va con el uuid pelado y los siguientes
// con sufijo "-2", "-3"… (ver Ticket.nextEmvReference en el frontend; el adquirente no
// reprocesa una referencia a la que ya le dio desenlace). Así que el cruce del voucher
// suelto con su venta compara contra la base, no contra la referencia completa: `instr`
// se aplica sobre `reference || '-'` para que las referencias sin sufijo —todas las
// anteriores a ese cambio— sigan devolviéndose enteras.
const EMV_REF_BASE = "substr(reference, 1, instr(reference || '-', '-') - 1)";

let db = null;
let shadowPath = '';
let dbPath = '';
let initError = '';
let lastSeq = 0;
let lastHash = '';

// ── Rutas ───────────────────────────────────────────────────────────────────────

// Directorio "duro" por sistema operativo: fuera del perfil del usuario y fuera de
// `userData`, para que sobreviva a reinstalar el cliente o a rehacer el perfil de Windows.
function hardenedDir() {
    const override = String(process.env.NESTOR_LEDGER_DIR || '').trim();
    if (override) return override;

    if (process.platform === 'win32') {
        const base = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
        return path.join(base, 'NestorPOS', 'ventas-local');
    }
    if (process.platform === 'darwin') {
        return path.join('/Users/Shared', 'NestorPOS', 'ventas-local');
    }
    return path.join('/var/lib', 'nestorpos', 'ventas-local');
}

function canUseDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.escritura');
        fs.writeFileSync(probe, String(Date.now()));
        fs.rmSync(probe, { force: true });
        return true;
    } catch {
        return false;
    }
}

// Devuelve { primary, shadow }. El principal es el directorio duro si se puede escribir en
// él; si no (equipo con permisos cerrados), se cae a `userData` y el ejemplar de respaldo
// se intenta en el home del usuario — nunca los dos en el mismo sitio.
function resolveDirs(userDataDir) {
    const hard = hardenedDir();
    const soft = userDataDir ? path.join(userDataDir, 'ventas-local') : '';

    if (canUseDir(hard)) {
        const shadow = soft && canUseDir(soft) ? soft : '';
        return { primary: hard, shadow };
    }

    console.warn('[ledger] no se pudo escribir en', hard, '- se usa el perfil de la aplicación');
    if (soft && canUseDir(soft)) {
        const alt = path.join(os.homedir(), '.nestorpos', 'ventas-local');
        return { primary: soft, shadow: canUseDir(alt) ? alt : '' };
    }
    return { primary: '', shadow: '' };
}

// ── Esquema ─────────────────────────────────────────────────────────────────────

// Un solo lugar con los triggers: cada tabla del ledger prohíbe DELETE, y las tres tablas
// append-only prohíben además UPDATE. Los triggers viven EN EL ARCHIVO, así que valen
// también para quien lo abra por fuera.
// La guarda del borrado. El trigger ya no prohíbe el DELETE en absoluto: lo prohíbe
// MIENTRAS la llave `ledger_guard.ok` valga 0, que es siempre salvo dentro de la
// transacción de `archive()`.
//
// Por qué una llave y no quitar el trigger para archivar: quitarlo y volverlo a poner deja
// la tabla desprotegida durante la operación y, si algo falla en medio, desprotegida para
// siempre. La llave se levanta y se baja dentro de la MISMA transacción que borra, así que
// un fallo la revierte con todo lo demás.
//
// Lo que se conserva de la promesa original: un `DELETE` a secas —desde esta aplicación,
// desde el `sqlite3` de consola o desde cualquier visor— sigue abortando. Para borrar hay
// que levantar la llave a propósito, y eso lo hace un solo camino, que deja recibo.
//
// Los triggers se RECREAN en cada apertura (drop + create, no `IF NOT EXISTS`): una caja
// que ya venía anotando ventas tiene los triggers viejos sin guarda, y con `IF NOT EXISTS`
// se quedarían así para siempre y `archive()` no podría trabajar.
function guardsFor(table, { immutable = false } = {}) {
    const sql = [`
        DROP TRIGGER IF EXISTS trg_${table}_no_delete;
        CREATE TRIGGER trg_${table}_no_delete
        BEFORE DELETE ON ${table}
        WHEN COALESCE((SELECT ok FROM ledger_guard WHERE id = 1), 0) = 0
        BEGIN
            SELECT RAISE(ABORT, 'ventas-local: los renglones de ${table} no se eliminan');
        END;`];

    if (immutable) {
        sql.push(`
        DROP TRIGGER IF EXISTS trg_${table}_no_update;
        CREATE TRIGGER trg_${table}_no_update
        BEFORE UPDATE ON ${table}
        BEGIN
            SELECT RAISE(ABORT, 'ventas-local: los renglones de ${table} no se modifican');
        END;`);
    }
    return sql.join('\n');
}

function ensureSchema(handle) {
    handle.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = OFF;
    `);

    handle.exec(`
        CREATE TABLE IF NOT EXISTS ledger_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Llave del borrado. Una sola fila, vale 0 salvo dentro de archive().
        CREATE TABLE IF NOT EXISTS ledger_guard (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            ok INTEGER NOT NULL DEFAULT 0
        );

        -- Recibos de archivado: el ANCLA de la cadena. Cada renglón dice qué tramo de
        -- eventos salió de la base, con qué hash terminaba y en qué archivo está, para que
        -- verify() pueda seguir desde ahí y para que nadie pueda quitar historia sin
        -- dejar constancia. Esta tabla nunca se borra ni se modifica.
        CREATE TABLE IF NOT EXISTS ledger_archives (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            from_seq   INTEGER NOT NULL DEFAULT 0,
            to_seq     INTEGER NOT NULL DEFAULT 0,
            last_hash  TEXT    NOT NULL DEFAULT '',
            file       TEXT    NOT NULL DEFAULT '',
            sha256     TEXT    NOT NULL DEFAULT '',
            bytes      INTEGER NOT NULL DEFAULT 0,
            tickets    INTEGER NOT NULL DEFAULT 0,
            events     INTEGER NOT NULL DEFAULT 0,
            cutoff_ms  INTEGER NOT NULL DEFAULT 0,
            at_ms      INTEGER NOT NULL DEFAULT 0,
            at         TEXT    NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS tickets (
            ticket_key        TEXT PRIMARY KEY,
            folio             TEXT    NOT NULL DEFAULT '',
            client_invoice_id TEXT    NOT NULL DEFAULT '',
            invoice_number    INTEGER NOT NULL DEFAULT 0,
            sale_spot_id      INTEGER NOT NULL DEFAULT 0,
            sale_spot_cut_id  INTEGER NOT NULL DEFAULT 0,
            user_id           INTEGER NOT NULL DEFAULT 0,
            user_name         TEXT    NOT NULL DEFAULT '',
            license_number    TEXT    NOT NULL DEFAULT '',
            business_name     TEXT    NOT NULL DEFAULT '',
            status            TEXT    NOT NULL DEFAULT '',
            total             INTEGER NOT NULL DEFAULT 0,
            items             INTEGER NOT NULL DEFAULT 0,
            payment           TEXT    NOT NULL DEFAULT '',
            cancelled         INTEGER NOT NULL DEFAULT 0,
            is_purchase       INTEGER NOT NULL DEFAULT 0,
            printed           INTEGER NOT NULL DEFAULT 0,
            document_id       INTEGER NOT NULL DEFAULT 0,
            document_invoice  TEXT    NOT NULL DEFAULT '',
            last_error        TEXT    NOT NULL DEFAULT '',
            payload           TEXT    NOT NULL DEFAULT '',
            rev               INTEGER NOT NULL DEFAULT 0,
            created_at_ms     INTEGER NOT NULL DEFAULT 0,
            updated_at_ms     INTEGER NOT NULL DEFAULT 0,
            created_at        TEXT    NOT NULL DEFAULT '',
            updated_at        TEXT    NOT NULL DEFAULT '',
            -- Retiro manual de una venta que nunca se consolidó (ver remove()). Es una
            -- LÁPIDA: el renglón se queda, deja de aparecer y deja de contar.
            -- Revisada por un supervisor: deja de contar como pendiente, pero se sigue
            -- viendo. Es el equivalente del acknowledged_at de la bitacora del navegador.
            acknowledged_at    INTEGER NOT NULL DEFAULT 0,
            deleted_at         INTEGER NOT NULL DEFAULT 0,
            deleted_by_user_id INTEGER NOT NULL DEFAULT 0,
            deleted_by_name    TEXT    NOT NULL DEFAULT '',
            deleted_reason     TEXT    NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_tickets_cut     ON tickets (sale_spot_cut_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets (created_at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_tickets_status  ON tickets (status);
        CREATE INDEX IF NOT EXISTS idx_tickets_folio   ON tickets (folio);
        CREATE INDEX IF NOT EXISTS idx_tickets_cii     ON tickets (client_invoice_id);

        CREATE TABLE IF NOT EXISTS ticket_products (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_key   TEXT    NOT NULL,
            rev          INTEGER NOT NULL DEFAULT 0,
            line_no      INTEGER NOT NULL DEFAULT 0,
            product_id   INTEGER NOT NULL DEFAULT 0,
            name         TEXT    NOT NULL DEFAULT '',
            description  TEXT    NOT NULL DEFAULT '',
            sold_code    TEXT    NOT NULL DEFAULT '',
            qty          INTEGER NOT NULL DEFAULT 0,
            price        INTEGER NOT NULL DEFAULT 0,
            total        INTEGER NOT NULL DEFAULT 0,
            is_cancel    INTEGER NOT NULL DEFAULT 0,
            is_purchase  INTEGER NOT NULL DEFAULT 0,
            offer_name   TEXT    NOT NULL DEFAULT '',
            notes        TEXT    NOT NULL DEFAULT '',
            at_ms        INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_products_key ON ticket_products (ticket_key, rev);

        CREATE TABLE IF NOT EXISTS emv_vouchers (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_key       TEXT    NOT NULL DEFAULT '',
            vendor           TEXT    NOT NULL DEFAULT '',
            result           TEXT    NOT NULL DEFAULT '',
            operation_number TEXT    NOT NULL DEFAULT '',
            auth             TEXT    NOT NULL DEFAULT '',
            reference        TEXT    NOT NULL DEFAULT '',
            card_last4       TEXT    NOT NULL DEFAULT '',
            card_type        TEXT    NOT NULL DEFAULT '',
            value            INTEGER NOT NULL DEFAULT 0,
            error_code       TEXT    NOT NULL DEFAULT '',
            friendly         TEXT    NOT NULL DEFAULT '',
            voucher_comercio TEXT    NOT NULL DEFAULT '',
            voucher_cliente  TEXT    NOT NULL DEFAULT '',
            raw              TEXT    NOT NULL DEFAULT '',
            at_ms            INTEGER NOT NULL DEFAULT 0,
            at               TEXT    NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_emv_vouchers_key ON emv_vouchers (ticket_key);
        CREATE INDEX IF NOT EXISTS idx_emv_vouchers_op  ON emv_vouchers (operation_number);
        CREATE INDEX IF NOT EXISTS idx_emv_vouchers_at  ON emv_vouchers (at_ms DESC);
        -- La referencia es el segundo vínculo del voucher con su venta (ver list()/get()):
        -- el intento se anota antes de que el ticket exista, así que hay vouchers cuya
        -- única forma de encontrar su venta es ésta. El índice plano sirve a la
        -- deduplicación de insertEmv (compara la referencia completa); el de la BASE de la
        -- referencia sirve al cruce con la venta, que recorta el sufijo del intento
        -- (ver EMV_REF_BASE).
        CREATE INDEX IF NOT EXISTS idx_emv_vouchers_ref ON emv_vouchers (reference);
        CREATE INDEX IF NOT EXISTS idx_emv_vouchers_refbase
            ON emv_vouchers (substr(reference, 1, instr(reference || '-', '-') - 1));

        CREATE TABLE IF NOT EXISTS ticket_events (
            seq        INTEGER PRIMARY KEY,
            ticket_key TEXT    NOT NULL DEFAULT '',
            kind       TEXT    NOT NULL DEFAULT '',
            status     TEXT    NOT NULL DEFAULT '',
            detail     TEXT    NOT NULL DEFAULT '',
            total      INTEGER NOT NULL DEFAULT 0,
            at_ms      INTEGER NOT NULL DEFAULT 0,
            at         TEXT    NOT NULL DEFAULT '',
            prev_hash  TEXT    NOT NULL DEFAULT '',
            row_hash   TEXT    NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_events_key ON ticket_events (ticket_key, seq);
    `);

    // La llave existe SIEMPRE y arranca en 0: sin fila, el COALESCE del trigger la lee
    // como 0 igual, pero dejarla explícita evita que un INSERT accidental la levante.
    handle.exec('INSERT OR IGNORE INTO ledger_guard (id, ok) VALUES (1, 0)');
    handle.exec('UPDATE ledger_guard SET ok = 0 WHERE id = 1');

    handle.exec(guardsFor('tickets'));
    handle.exec(guardsFor('ticket_products', { immutable: true }));
    handle.exec(guardsFor('emv_vouchers', { immutable: true }));
    handle.exec(guardsFor('ticket_events', { immutable: true }));
    handle.exec(guardsFor('ledger_archives', { immutable: true }));

    // La identidad de un ticket no cambia: ni la llave, ni la caja, ni el instante en que
    // se abrió. El estado sí (una venta pasa de cobrada a registrada), por eso `tickets`
    // admite UPDATE pero con esta aduana.
    handle.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_tickets_immutable
        BEFORE UPDATE ON tickets
        WHEN OLD.ticket_key <> NEW.ticket_key
          OR (OLD.created_at_ms > 0 AND OLD.created_at_ms <> NEW.created_at_ms)
          OR NEW.total < 0
        BEGIN
            SELECT RAISE(ABORT, 'ventas-local: la identidad de un ticket no se modifica');
        END;
    `);

    // Columnas agregadas después de la primera versión. `CREATE TABLE IF NOT EXISTS` no
    // toca una tabla que ya existe, así que en una caja que ya venía anotando ventas hay
    // que añadirlas a mano.
    ensureColumn(handle, 'tickets', 'acknowledged_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(handle, 'tickets', 'deleted_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(handle, 'tickets', 'deleted_by_user_id', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(handle, 'tickets', 'deleted_by_name', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(handle, 'tickets', 'deleted_reason', "TEXT NOT NULL DEFAULT ''");
    handle.exec('CREATE INDEX IF NOT EXISTS idx_tickets_deleted ON tickets (deleted_at)');

    const version = readMeta(handle, 'schema_version');
    if (!version) {
        writeMeta(handle, 'schema_version', String(SCHEMA_VERSION));
        writeMeta(handle, 'created_at', new Date().toISOString());
    } else if (parseInt(version, 10) < SCHEMA_VERSION) {
        // Base de una versión anterior: las migraciones de arriba ya corrieron (son
        // aditivas e idempotentes), aquí sólo se deja constancia de hasta dónde llegó.
        writeMeta(handle, 'schema_version', String(SCHEMA_VERSION));
        writeMeta(handle, 'migrated_at', new Date().toISOString());
    }
    writeMeta(handle, 'opened_at', new Date().toISOString());
}

// Añade una columna sólo si falta. SQLite no tiene `ADD COLUMN IF NOT EXISTS`, así que se
// mira el PRAGMA antes; el mismo patrón que `ensureColumn` del backend.
function ensureColumn(handle, table, column, definition) {
    try {
        const cols = handle.prepare(`PRAGMA table_info(${table})`).all();
        if (cols.some(c => String(c.name) === column)) return;
        handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`[ledger] columna nueva: ${table}.${column}`);
    } catch (err) {
        console.warn(`[ledger] no se pudo agregar ${table}.${column}:`, err && err.message);
    }
}

function readMeta(handle, key) {
    try {
        const row = handle.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(key);
        return row ? String(row.value) : '';
    } catch {
        return '';
    }
}

function writeMeta(handle, key, value) {
    try {
        handle.prepare(
            'INSERT INTO ledger_meta (key, value) VALUES (?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run(key, String(value));
    } catch { }
}

// ── Arranque ────────────────────────────────────────────────────────────────────

// Abre la base en `dir` y deja el esquema listo. Devuelve el handle o null.
//
// Que el directorio sea escribible NO garantiza que SQLite pueda trabajar ahí: en Windows,
// con el Acceso Controlado a Carpetas de Defender, la base ABRE pero no puede crear su
// `-shm` y revienta a la primera escritura real (nos pasó con una instalación bajo
// Program Files). Por eso el sondeo no es un `fs.writeFile`: es el propio esquema más una
// escritura por SQLite, que es la operación que de verdad tiene que funcionar.
function openAt(dir) {
    const file = path.join(dir, DB_FILENAME);
    let handle = null;
    try {
        handle = new DatabaseSync(file);
        ensureSchema(handle);
        return { handle, file };
    } catch (err) {
        if (handle) { try { handle.close(); } catch { } }
        console.warn('[ledger] no se pudo usar', file, '-', (err && err.message) || err);
        return null;
    }
}

function init(userDataDir) {
    if (db) return status();

    // Interruptor de apagado. "Ventas en local" es OPCIONAL: con `NESTOR_LEDGER=0` el
    // cliente se comporta exactamente como un navegador —el POS sigue funcionando con su
    // bitácora de localStorage y la conciliación del corte se salta sola— sin tocar una
    // línea del frontend. Es la salida para una máquina donde el disco no coopere, o para
    // descartar el ledger en un diagnóstico.
    if (String(process.env.NESTOR_LEDGER || '').trim() === '0') {
        initError = 'desactivado por NESTOR_LEDGER=0';
        console.log('[ledger] ventas en local DESACTIVADO (NESTOR_LEDGER=0)');
        return status();
    }

    if (!DatabaseSync) {
        initError = 'node:sqlite no disponible';
        return status();
    }

    const { primary, shadow } = resolveDirs(userDataDir);
    const fallback = userDataDir ? path.join(userDataDir, 'ventas-local') : '';

    // Orden de preferencia, sin repetir directorio: el duro primero y el perfil de la
    // aplicación como red. Preferimos guardar en un sitio menos protegido antes que no
    // guardar nada: una venta sin rastro es peor que una venta con rastro fácil de borrar.
    const candidates = [primary, fallback].filter((d, i, all) => d && all.indexOf(d) === i);

    let opened = null;
    for (const dir of candidates) {
        if (!canUseDir(dir)) continue;
        opened = openAt(dir);
        if (opened) {
            if (dir !== primary) console.warn('[ledger] se usó el directorio de respaldo:', dir);
            break;
        }
    }

    if (!opened) {
        initError = 'no hay ningún directorio donde SQLite pueda escribir el ledger';
        console.error('[ledger]', initError);
        return status();
    }

    // Se abre UNA vez y no se cierra: además de ahorrar el coste por escritura, en
    // Windows un archivo abierto por SQLite no se puede borrar (ver la cabecera).
    db = opened.handle;
    dbPath = opened.file;

    const shadowDir = shadow && shadow !== path.dirname(dbPath) ? shadow : '';
    shadowPath = shadowDir ? path.join(shadowDir, SHADOW_FILENAME) : '';

    try {
        const tip = db.prepare('SELECT seq, row_hash FROM ticket_events ORDER BY seq DESC LIMIT 1').get();
        lastSeq = tip ? Number(tip.seq) : 0;
        lastHash = tip ? String(tip.row_hash) : '';
        initError = '';

        const counts = db.prepare('SELECT COUNT(*) AS n FROM tickets').get();
        console.log(`[ledger] ventas en local: ${dbPath} (${counts ? counts.n : 0} tickets, ${lastSeq} eventos)`);
        if (shadowPath) console.log('[ledger] segundo ejemplar:', shadowPath);
        startCheckpointTimer();
        // Retención: al abrir y luego junto al consolidado del WAL. Nunca bloquea el
        // arranque — si falla, se anota y la caja sigue.
        archiveIfDue();
    } catch (err) {
        db = null;
        initError = String((err && err.message) || err);
        console.error('[ledger] no se pudo leer', dbPath, '-', initError);
    }

    return status();
}

// ── Consolidación del WAL ───────────────────────────────────────────────────────
// En modo WAL lo recién escrito vive en el sidecar `-wal` hasta que se consolida. Eso está
// bien para la integridad (SQLite lo recupera solo al abrir) pero es una trampa para lo que
// de verdad se hace con este archivo: soporte lo COPIA. Una copia del `.db` sin su `-wal`
// llega sin las últimas ventas — exactamente las que se estaban buscando.
//
// Así que se consolida cada pocos minutos y al cerrar la aplicación: el `.db` se basta solo
// casi siempre, y quien lo copie no tiene que saber nada de sidecars.
const CHECKPOINT_MS = 3 * 60 * 1000;
let checkpointTimer = null;

function checkpoint() {
    if (!db) return;
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
        console.warn('[ledger] no se pudo consolidar el WAL:', err && err.message);
    }
}

function startCheckpointTimer() {
    if (checkpointTimer) return;
    checkpointTimer = setInterval(() => {
        checkpoint();
        // La retención no puede depender de que alguien cierre el punto de venta: una caja
        // se queda semanas encendida. `archiveIfDue` trae su propio cooldown de 6 h, así
        // que esto no es una consulta cada tres minutos.
        archiveIfDue();
    }, CHECKPOINT_MS);
    if (typeof checkpointTimer.unref === 'function') checkpointTimer.unref();
}

// Cierre ordenado al salir de la aplicación. No es imprescindible —el WAL se recupera
// solo—, pero deja el archivo listo para copiarse tal cual.
function shutdown() {
    if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
    checkpoint();
}

// Lo que este motor sabe hacer. El preload lleva la misma lista de forma estática (para no
// gastar un viaje por IPC), pero ésta es la que manda cuando llega: describe lo que la base
// ABIERTA puede hacer, no lo que el binario trae. Si algún día una capacidad depende de una
// migración que pudo fallar, aquí es donde se deja de anunciar.
const CAPABILITIES = [
    'status', 'stats', 'record', 'mark', 'emv',
    'list', 'get', 'summary', 'verify', 'export',
    'remove', 'acknowledge',
    // v3 — retención por archivado con ancla
    'archive', 'archives',
];

function status() {
    return {
        ok: !!db,
        available: !!db,
        error: initError,
        db_path: dbPath,
        shadow_path: shadowPath,
        events: lastSeq,
        schema_version: SCHEMA_VERSION,
        capabilities: CAPABILITIES.slice(),
    };
}

// ── Utilidades ──────────────────────────────────────────────────────────────────

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const str = (v) => (v === null || v === undefined ? '' : String(v));
const bit = (v) => (v === true || v === 1 || v === '1' ? 1 : 0);
const clip = (v, max = MAX_DETAIL) => {
    const s = str(v);
    return s.length > max ? s.slice(0, max) : s;
};

function isoOf(ms) {
    const n = num(ms);
    return new Date(n > 0 ? n : Date.now()).toISOString();
}

// Folio visible de la caja: TC-<caja>-<folio>. Es el número que el cajero ve impreso y con
// el que va a buscar la venta, así que se materializa en la tabla en lugar de recomponerlo
// en cada consulta.
function folioOf(saleSpotId, invoiceNumber) {
    return `TC-${num(saleSpotId)}-${num(invoiceNumber)}`;
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Sobre bytes, no sobre texto: el archivo de retención va comprimido y lo que se sella es
// el archivo tal cual queda en disco, que es lo que alguien va a poder comprobar después.
function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Cadena de eventos ───────────────────────────────────────────────────────────

// Todo cambio pasa por aquí. El evento es lo que queda sellado; la fila de `tickets` es
// sólo la foto del último estado, reconstruible desde estos renglones.
function appendEvent({ key, kind, status: st, detail, total, atMs, extra }) {
    const seq = lastSeq + 1;
    const at = num(atMs) || Date.now();
    const prev = lastHash;
    const body = [prev, seq, at, str(key), str(kind), str(st), num(total), clip(detail)].join('|');
    const hash = sha256(body);

    db.prepare(`
        INSERT INTO ticket_events (seq, ticket_key, kind, status, detail, total, at_ms, at, prev_hash, row_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seq, str(key), str(kind), str(st), clip(detail), num(total), at, isoOf(at), prev, hash);

    lastSeq = seq;
    lastHash = hash;

    appendShadow({ seq, at: isoOf(at), key: str(key), kind: str(kind), status: str(st), total: num(total), detail: clip(detail), hash, ...(extra || {}) });
    return { seq, hash };
}

// Segundo ejemplar en texto plano, en otro directorio. No es un espejo de la base: es una
// tira de eventos que se puede leer con cualquier cosa (y volver a cargar) si el .db
// desapareciera. Nunca lanza: si falla, la base sigue siendo la copia buena.
function appendShadow(line) {
    if (!shadowPath) return;
    try {
        fs.appendFileSync(shadowPath, JSON.stringify(line) + '\n');
    } catch (err) {
        console.warn('[ledger] no se pudo anexar al segundo ejemplar:', err && err.message);
    }
}

// ── Escritura ───────────────────────────────────────────────────────────────────

/**
 * Anota (o actualiza) una venta. Idempotente por `key`: se llama varias veces sobre la
 * misma venta a lo largo de su vida y siempre escribe sobre el mismo renglón, agregando un
 * evento por cada paso.
 *
 * Reglas heredadas de la bitácora del POS, para que las dos cuenten la misma historia:
 *   - una venta ya `registered` no retrocede de estado;
 *   - el payload no se pisa con vacío;
 *   - `printed` es irreversible: el papel salió y eso no se deshace.
 */
function record(entry) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };

    const e = entry && typeof entry === 'object' ? entry : {};
    const key = str(e.key).trim();
    if (!key) return { ok: false, error: 'ticket sin llave' };

    try {
        const now = Date.now();
        const createdAt = num(e.created_at_ms) || now;
        const updatedAt = num(e.updated_at_ms) || now;
        const prev = db.prepare('SELECT * FROM tickets WHERE ticket_key = ?').get(key) || null;

        let nextStatus = str(e.status);
        if (prev && String(prev.status) === 'registered' && nextStatus !== 'registered') {
            nextStatus = 'registered';
        }

        const payload = str(e.payload) || (prev ? str(prev.payload) : '');
        const rev = prev ? num(prev.rev) + 1 : 1;

        const row = {
            folio: str(e.folio) || folioOf(e.sale_spot_id, e.invoice_number),
            client_invoice_id: str(e.identifier) || (prev ? str(prev.client_invoice_id) : ''),
            invoice_number: num(e.invoice_number) || (prev ? num(prev.invoice_number) : 0),
            sale_spot_id: num(e.sale_spot_id) || (prev ? num(prev.sale_spot_id) : 0),
            sale_spot_cut_id: num(e.sale_spot_cut_id) || (prev ? num(prev.sale_spot_cut_id) : 0),
            user_id: num(e.user_id) || (prev ? num(prev.user_id) : 0),
            user_name: str(e.user_name) || (prev ? str(prev.user_name) : ''),
            license_number: str(e.license_number) || (prev ? str(prev.license_number) : ''),
            business_name: str(e.business_name) || (prev ? str(prev.business_name) : ''),
            status: nextStatus,
            total: num(e.total),
            items: num(e.items),
            payment: str(e.payment) || (prev ? str(prev.payment) : ''),
            cancelled: bit(e.cancelled),
            is_purchase: bit(e.is_purchase),
            printed: bit(e.printed) || (prev ? num(prev.printed) : 0),
            document_id: num(e.document_id) || (prev ? num(prev.document_id) : 0),
            document_invoice: str(e.document_invoice) || (prev ? str(prev.document_invoice) : ''),
            last_error: nextStatus === 'registered' ? '' : clip(e.detail || e.last_error),
            payload,
            rev,
            created_at_ms: prev ? num(prev.created_at_ms) : createdAt,
            updated_at_ms: updatedAt,
        };

        if (prev) {
            db.prepare(`
                UPDATE tickets SET
                    folio = ?, client_invoice_id = ?, invoice_number = ?, sale_spot_id = ?,
                    sale_spot_cut_id = ?, user_id = ?, user_name = ?, license_number = ?,
                    business_name = ?, status = ?, total = ?, items = ?, payment = ?,
                    cancelled = ?, is_purchase = ?, printed = ?, document_id = ?,
                    document_invoice = ?, last_error = ?, payload = ?, rev = ?,
                    updated_at_ms = ?, updated_at = ?
                WHERE ticket_key = ?
            `).run(
                row.folio, row.client_invoice_id, row.invoice_number, row.sale_spot_id,
                row.sale_spot_cut_id, row.user_id, row.user_name, row.license_number,
                row.business_name, row.status, row.total, row.items, row.payment,
                row.cancelled, row.is_purchase, row.printed, row.document_id,
                row.document_invoice, row.last_error, row.payload, row.rev,
                row.updated_at_ms, isoOf(row.updated_at_ms), key,
            );
        } else {
            db.prepare(`
                INSERT INTO tickets (
                    ticket_key, folio, client_invoice_id, invoice_number, sale_spot_id,
                    sale_spot_cut_id, user_id, user_name, license_number, business_name,
                    status, total, items, payment, cancelled, is_purchase, printed,
                    document_id, document_invoice, last_error, payload, rev,
                    created_at_ms, updated_at_ms, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                key, row.folio, row.client_invoice_id, row.invoice_number, row.sale_spot_id,
                row.sale_spot_cut_id, row.user_id, row.user_name, row.license_number,
                row.business_name, row.status, row.total, row.items, row.payment,
                row.cancelled, row.is_purchase, row.printed, row.document_id,
                row.document_invoice, row.last_error, row.payload, row.rev,
                row.created_at_ms, row.updated_at_ms, isoOf(row.created_at_ms), isoOf(row.updated_at_ms),
            );
        }

        saveProducts(key, rev, e.products, row.updated_at_ms);
        saveEmv(key, e.emv, row.updated_at_ms);

        const risky = RISKY.indexOf(row.status) !== -1;
        appendEvent({
            key,
            kind: prev ? 'update' : 'create',
            status: row.status,
            detail: e.detail || e.last_error || '',
            total: row.total,
            atMs: row.updated_at_ms,
            extra: {
                folio: row.folio,
                identifier: row.client_invoice_id,
                cut: row.sale_spot_cut_id,
                items: row.items,
                // El ticket íntegro sólo viaja al segundo ejemplar cuando la venta puede
                // perderse. Con la venta ya registrada, la copia buena es el documento.
                payload: risky && payload ? payload : undefined,
            },
        });

        return { ok: true, key, rev, seq: lastSeq };
    } catch (err) {
        console.error('[ledger] record falló:', err && err.message);
        return { ok: false, error: String((err && err.message) || err) };
    }
}

// Los renglones se versionan en vez de reescribirse: una venta puede recapturarse entre el
// cobro con terminal y el cierre, y perder la foto anterior sería perder justo la prueba de
// qué se cobró primero. Se guarda una revisión nueva sólo si de verdad cambió algo.
function saveProducts(key, rev, products, atMs) {
    const list = Array.isArray(products) ? products : null;
    if (!list || list.length === 0) return;

    const fingerprint = sha256(JSON.stringify(list.map(p => [
        num(p && p.product_id), num(p && p.qty), num(p && p.price), num(p && p.total), bit(p && p.is_cancel),
    ])));
    const prevFp = db.prepare(
        'SELECT rev FROM ticket_products WHERE ticket_key = ? ORDER BY rev DESC LIMIT 1'
    ).get(key);
    if (prevFp) {
        const prevRev = num(prevFp.rev);
        const prevRows = db.prepare(
            'SELECT product_id, qty, price, total, is_cancel FROM ticket_products WHERE ticket_key = ? AND rev = ? ORDER BY line_no'
        ).all(key, prevRev);
        const prevFingerprint = sha256(JSON.stringify(prevRows.map(p => [
            num(p.product_id), num(p.qty), num(p.price), num(p.total), num(p.is_cancel),
        ])));
        if (prevFingerprint === fingerprint) return;
    }

    const stmt = db.prepare(`
        INSERT INTO ticket_products (
            ticket_key, rev, line_no, product_id, name, description, sold_code,
            qty, price, total, is_cancel, is_purchase, offer_name, notes, at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    list.forEach((p, i) => {
        const it = p && typeof p === 'object' ? p : {};
        stmt.run(
            key, rev, i + 1, num(it.product_id), clip(it.name, 200), clip(it.description, 200),
            clip(it.sold_code, 64), num(it.qty), num(it.price), num(it.total),
            bit(it.is_cancel), bit(it.is_purchase), clip(it.offer_name, 120),
            clip(it.notes, 400), num(atMs) || Date.now(),
        );
    });
}

// Los vouchers se anexan una sola vez por operación: el mismo cobro se reenvía muchas veces
// mientras la venta busca registrarse, y duplicarlos convertiría el historial en ruido.
function saveEmv(key, list, atMs) {
    if (!Array.isArray(list) || list.length === 0) return;
    for (const raw of list) {
        const it = raw && typeof raw === 'object' ? raw : {};
        insertEmv({ ...it, ticket_key: key }, atMs);
    }
}

function insertEmv(entry, atMs) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const key = str(e.ticket_key);
    const op = str(e.operation_number);
    const ref = str(e.reference);

    // Identidad del cobro: número de operación cuando lo hay (es el que aparece en el
    // estado de cuenta de la terminal), y si no, la referencia con la que se pidió.
    if (op || ref) {
        const dup = db.prepare(`
            SELECT id, ticket_key FROM emv_vouchers
            WHERE (? <> '' AND operation_number = ?) OR (? = '' AND ? <> '' AND reference = ?)
            LIMIT 1
        `).get(op, op, op, ref, ref);
        if (dup) {
            // El intento ya está anotado. Si vino suelto (se reporta en cuanto responde la
            // terminal, con la cuenta todavía abierta) y ahora llega con su venta, se deja
            // constancia del enlace: el renglón está sellado y emv_vouchers no admite
            // UPDATE, así que el vínculo sólo puede vivir en la bitácora de eventos.
            //
            // Una sola vez. Sin esta guarda el enlace se reescribiría en cada anotación de
            // la venta —y una venta cambia de estado tres o cuatro veces— llenando la
            // historia del ticket de renglones repetidos.
            const alreadyLinked = key && String(dup.ticket_key || '') !== key
                ? db.prepare(
                    "SELECT seq FROM ticket_events WHERE ticket_key = ? AND kind = 'emv-link' AND detail LIKE ? LIMIT 1"
                ).get(key, `%${op || ref}%`)
                : true;

            if (key && !alreadyLinked) {
                appendEvent({
                    key, kind: 'emv-link', status: str(e.result),
                    detail: `cobro con terminal ${op || ref} enlazado a la venta`,
                    total: num(e.value), atMs,
                });
            }
            return;
        }
    }

    const at = num(atMs) || Date.now();
    db.prepare(`
        INSERT INTO emv_vouchers (
            ticket_key, vendor, result, operation_number, auth, reference, card_last4,
            card_type, value, error_code, friendly, voucher_comercio, voucher_cliente,
            raw, at_ms, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        key, str(e.vendor), str(e.result || e.estatus), op, str(e.auth), ref,
        str(e.card_last4), str(e.card_type), num(e.value), str(e.error_code),
        clip(e.friendly, 300), clip(e.voucher_comercio, 8000), clip(e.voucher_cliente, 8000),
        clip(e.raw, 20000), at, isoOf(at),
    );

    appendEvent({
        key: key || `emv:${op || ref}`,
        kind: 'emv',
        status: str(e.result || e.estatus),
        detail: `terminal ${str(e.vendor) || 'EMV'} · oper. ${op || '—'} · aut. ${str(e.auth) || '—'}`,
        total: num(e.value),
        atMs: at,
        extra: { card_last4: str(e.card_last4), reference: ref },
    });
}

/**
 * Registra un intento con la terminal — aprobado, rechazado o con error — venga o no
 * pegado a una venta. Es el gemelo local de `/pos/emv/attempt`: si el servidor no está, el
 * voucher se queda igual en la caja.
 */
function emv(entry) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };
    try {
        insertEmv(entry || {}, Date.now());
        return { ok: true, seq: lastSeq };
    } catch (err) {
        console.error('[ledger] emv falló:', err && err.message);
        return { ok: false, error: String((err && err.message) || err) };
    }
}

/**
 * Marca una venta ya anotada (registrada, rechazada, impresa, revisada…). No admite
 * borrar: `status` sólo avanza y el evento queda sellado pase lo que pase.
 */
function mark(input) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };

    const p = input && typeof input === 'object' ? input : {};
    const key = str(p.key).trim();
    if (!key) return { ok: false, error: 'ticket sin llave' };

    try {
        const prev = db.prepare('SELECT * FROM tickets WHERE ticket_key = ?').get(key);
        if (!prev) return { ok: false, error: 'la venta no está en el ledger' };

        let nextStatus = str(p.status) || String(prev.status);
        if (String(prev.status) === 'registered' && nextStatus !== 'registered') {
            nextStatus = 'registered';
        }

        const doc = p.document && typeof p.document === 'object' ? p.document : null;
        const documentId = doc ? num(doc.ID || doc.id) || num(prev.document_id) : num(prev.document_id);
        const documentInvoice = doc
            ? (str(doc.invoice || doc.Invoice) || str(prev.document_invoice))
            : str(prev.document_invoice);
        const now = Date.now();

        // "Revisada por un supervisor" es irreversible, como el papel impreso: una vez que
        // alguien la miró y dijo que estaba atendida, no vuelve a gritar sola.
        const acknowledgedAt = p.acknowledge === true
            ? (num(prev.acknowledged_at) || now)
            : num(prev.acknowledged_at);

        db.prepare(`
            UPDATE tickets SET
                status = ?, printed = ?, document_id = ?, document_invoice = ?,
                last_error = ?, acknowledged_at = ?, updated_at_ms = ?, updated_at = ?
            WHERE ticket_key = ?
        `).run(
            nextStatus,
            bit(p.printed) || num(prev.printed),
            documentId,
            documentInvoice,
            nextStatus === 'registered' ? '' : clip(p.detail || prev.last_error),
            acknowledgedAt,
            now, isoOf(now), key,
        );

        appendEvent({
            key,
            kind: 'mark',
            status: nextStatus,
            detail: p.detail || '',
            total: num(prev.total),
            atMs: now,
            extra: { document_id: documentId, document_invoice: documentInvoice },
        });

        return { ok: true, key, seq: lastSeq };
    } catch (err) {
        console.error('[ledger] mark falló:', err && err.message);
        return { ok: false, error: String((err && err.message) || err) };
    }
}

/**
 * Retira manualmente una venta que NUNCA se consolidó.
 *
 * Es la única salida que existe para sacar un renglón de la lista: una venta de prueba, una
 * captura duplicada, algo que jamás va a poder registrarse y que ensucia el panel y el
 * conteo del corte. Después de esto la venta no aparece en ningún listado, no cuenta en los
 * contadores y no entra en la conciliación del corte — que es lo que "eliminar" significa
 * para quien lo pide.
 *
 * **Es una lápida, no un DELETE.** El renglón y su historia se quedan en la base, marcados,
 * y el retiro agrega su propio evento con quién, cuándo y por qué. Tres razones:
 *
 *   1. El `BEFORE DELETE` cubre TODA la tabla. Quitarlo para poder borrar un renglón
 *      quitaría la protección de los demás, que es el motivo por el que existe esta base.
 *   2. Los eventos van encadenados. Sacar los de una venta rompería la cadena y `verify()`
 *      diría "bitácora alterada" para siempre — un borrado legítimo dejaría la base
 *      marcada como manipulada.
 *   3. Una venta sin consolidar es justo la que pudo cobrarse de verdad y no registrarse
 *      (el caso de los $313.00 con terminal). Si además se pudiera hacer desaparecer sin
 *      rastro, esta base no serviría para nada.
 *
 * **Y hoy no se retira NADA desde la caja.** Eran dos guardas y ahora cierran la lista
 * completa:
 *
 *   * `document_id > 0` — la venta consolidada existe en el servidor y esta copia es su
 *     respaldo.
 *   * sin registrar — es la que hay que RECUPERAR. Retirarla la saca de los listados, de
 *     los contadores y de la conciliación del corte: borra el único aviso de que falta
 *     registrar una venta ya cobrada. El 20/ago/2026 una caja juntó nueve así, una con
 *     $192.00 ya cargados a una tarjeta; con el retiro disponible, "limpiar la lista"
 *     habría dejado ese cargo sin contraparte en ningún lado y sin nadie que lo supiera.
 *
 * No es un permiso que a alguien le falte —no se desbloquea con la autorización de un
 * supervisor—: es una operación que no debe existir en la caja. La razón 3 de arriba lo
 * dice desde el principio; lo que faltaba era sacar la consecuencia. Sacar un renglón de
 * verdad es trabajo de ingeniería sobre la base, deliberado y con el registro que deja.
 *
 * La guarda vive aquí, en el motor, y no sólo en la interfaz: el canal IPC lo puede llamar
 * cualquiera, así que un frontend viejo —o cualquier otro llamador— recibe el mismo rechazo
 * con su motivo en vez de retirar la venta.
 */
function remove(input) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };

    const p = input && typeof input === 'object' ? input : {};
    const key = str(p.key).trim();
    if (!key) return { ok: false, error: 'ticket sin llave' };

    try {
        const prev = db.prepare('SELECT * FROM tickets WHERE ticket_key = ?').get(key);
        if (!prev) return { ok: false, code: 'E_LEDGER_NOT_FOUND', error: 'la venta no está en el ledger' };

        if (num(prev.document_id) > 0) {
            return {
                ok: false,
                code: 'E_LEDGER_TICKET_CONSOLIDATED',
                error: `la venta está registrada en el servidor (documento ${num(prev.document_id)}) y no se puede retirar`,
            };
        }
        return {
            ok: false,
            code: 'E_LEDGER_TICKET_UNREGISTERED',
            error: 'la venta no está registrada en el servidor: hay que recuperarla, no retirarla',
        };
    } catch (err) {
        console.error('[ledger] remove falló:', err && err.message);
        return { ok: false, error: String((err && err.message) || err) };
    }
}

// ── Lectura ─────────────────────────────────────────────────────────────────────

function buildFilter(query) {
    const q = query && typeof query === 'object' ? query : {};
    const where = [];
    const args = [];

    // Lo retirado a mano no se ve por omisión: para quien lo quitó, esa venta ya no está.
    // `include_deleted` lo trae de vuelta (el panel tiene su pestaña) y `only_deleted` deja
    // sólo eso.
    if (q.only_deleted === true) where.push('deleted_at > 0');
    else if (q.include_deleted !== true) where.push('deleted_at = 0');

    if (num(q.cut_id) > 0) { where.push('sale_spot_cut_id = ?'); args.push(num(q.cut_id)); }
    if (num(q.sale_spot_id) > 0) { where.push('sale_spot_id = ?'); args.push(num(q.sale_spot_id)); }
    if (str(q.status)) { where.push('status = ?'); args.push(str(q.status)); }
    // Una cuenta ELIMINADA con F5 no es una venta: quien pregunta "¿cuántas fallaron?" no
    // se refiere a ellas.
    if (q.exclude_cancelled === true) where.push('cancelled = 0');
    if (num(q.since_ms) > 0) { where.push('created_at_ms >= ?'); args.push(num(q.since_ms)); }
    // "Sin consolidar" = lo que TODAVÍA hay que atender, no "todo lo que no está
    // registrado". Una venta que un supervisor ya revisó, o que retiró de la cola, está
    // atendida: seguir contándola convierte el aviso en ruido permanente y entrena al
    // cajero a ignorarlo, que es exactamente lo contrario de para qué existe.
    //
    // Y una cuenta ELIMINADA con F5 tampoco cuenta: **no es una venta**. No hubo dinero,
    // el cliente no se llevó nada y no hay nada que recuperar — su documento CANCELLED
    // sólo existe para que el folio no desaparezca de la historia. Contarla dejaba la caja
    // sin poder cortar por algo que nadie tiene que resolver.
    if (q.only_unresolved === true) {
        where.push("status NOT IN ('registered', 'discarded') AND acknowledged_at = 0 AND cancelled = 0");
    }
    if (q.only_sales === true) { where.push('is_purchase = 0 AND cancelled = 0'); }

    const search = str(q.search).trim();
    if (search) {
        where.push('(folio LIKE ? OR client_invoice_id LIKE ? OR document_invoice LIKE ? OR ticket_key LIKE ?)');
        const like = `%${search}%`;
        args.push(like, like, like, like);
    }

    return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
}

/** Listado ordenado por fecha de creación DESCENDENTE — el orden con el que se lee la caja. */
function list(query) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible', items: [], total: 0 };

    try {
        const q = query && typeof query === 'object' ? query : {};
        const limit = Math.min(Math.max(num(q.limit) || 200, 1), 2000);
        const offset = Math.max(num(q.offset), 0);
        const { sql, args } = buildFilter(q);

        const counted = db.prepare(`SELECT COUNT(*) AS n FROM tickets${sql}`).get(...args);
        const rows = db.prepare(`
            SELECT ticket_key, folio, client_invoice_id, invoice_number, sale_spot_id,
                   sale_spot_cut_id, user_id, user_name, status, total, items, payment,
                   cancelled, is_purchase, printed, document_id, document_invoice,
                   last_error, created_at, created_at_ms, updated_at, updated_at_ms,
                   acknowledged_at, deleted_at, deleted_by_user_id, deleted_by_name, deleted_reason
            FROM tickets${sql}
            ORDER BY created_at_ms DESC, rowid DESC
            LIMIT ? OFFSET ?
        `).all(...args, limit, offset);

        // Los cobros con terminal se adjuntan en una sola consulta: la tabla es chica y una
        // consulta por renglón se notaba al abrir el panel con el turno completo.
        //
        // Se buscan por ticket_key Y por reference. El intento se anota en cuanto la
        // terminal responde —con la cuenta todavía abierta y, por tanto, sin ticket_key— y
        // la fila queda sellada: el vínculo posterior sólo se anota como evento, así que un
        // filtro por ticket_key a secas dejaba fuera precisamente los vouchers de las ventas
        // que nunca llegaron a registrarse. Eso pasó el 20/ago/2026: la copia para soporte
        // decía "emv: []" en la venta cuya tarjeta SÍ se había cobrado ($192.00, oper.
        // 612915484). La referencia con la que se pide el cobro lleva el uuid del ticket
        // como prefijo (ver startSantanderEmvPayment), así que sirve de vínculo sin
        // inventar nada: se compara contra su base (EMV_REF_BASE).
        const keys = rows.map(r => String(r.ticket_key));
        const emvByKey = new Map();
        if (keys.length > 0) {
            const placeholders = keys.map(() => '?').join(',');
            const emvRows = db.prepare(`
                SELECT ticket_key, operation_number, auth, reference, card_last4, card_type,
                       result, value, vendor, ${EMV_REF_BASE} AS ref_base
                FROM emv_vouchers
                WHERE ticket_key IN (${placeholders})
                   OR (ticket_key = '' AND ${EMV_REF_BASE} IN (${placeholders}))
            `).all(...keys, ...keys);
            for (const v of emvRows) {
                // El voucher suelto se agrupa por la base de su referencia: es el ticket al
                // que pertenece, aunque su propia fila no lo diga.
                const k = String(v.ticket_key) || String(v.ref_base);
                if (!emvByKey.has(k)) emvByKey.set(k, []);
                emvByKey.get(k).push(v);
            }
        }

        return {
            ok: true,
            total: counted ? num(counted.n) : rows.length,
            items: rows.map(r => ({ ...r, emv: emvByKey.get(String(r.ticket_key)) || [] })),
        };
    } catch (err) {
        console.error('[ledger] list falló:', err && err.message);
        return { ok: false, error: String((err && err.message) || err), items: [], total: 0 };
    }
}

/** Una venta con todo lo que la caja guardó de ella: renglones, vouchers y su historia. */
function get(key) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };
    try {
        const k = str(key).trim();
        const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_key = ?').get(k);
        if (!ticket) return { ok: false, error: 'la venta no está en el ledger' };

        const products = db.prepare(
            'SELECT * FROM ticket_products WHERE ticket_key = ? AND rev = (SELECT MAX(rev) FROM ticket_products WHERE ticket_key = ?) ORDER BY line_no'
        ).all(k, k);
        // Igual que en list(): también los vouchers que se anotaron sueltos (sin ticket_key)
        // y que corresponden a esta venta por su referencia (por su base — la referencia
        // es única por intento, ver EMV_REF_BASE).
        const vouchers = db.prepare(
            `SELECT * FROM emv_vouchers
              WHERE ticket_key = ? OR (ticket_key = '' AND ${EMV_REF_BASE} = ?)
              ORDER BY at_ms`
        ).all(k, k);
        const events = db.prepare('SELECT * FROM ticket_events WHERE ticket_key = ? ORDER BY seq').all(k);

        return { ok: true, ticket, products, vouchers, events };
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
    }
}

/**
 * Sumatoria de la caja: lo que el cliente cree que vendió. Es el lado local de la
 * conciliación contra el servidor al hacer el corte X/Z.
 *
 * `only_sales` deja fuera las compras a proveedor y las cuentas ELIMINADAS (F5), que en el
 * servidor no suman como venta; `exclude_status` deja fuera las retiradas por un
 * supervisor, que nunca debieron registrarse.
 */
function summary(query) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };

    try {
        const q = query && typeof query === 'object' ? query : {};
        const { sql, args } = buildFilter({ ...q, only_sales: q.only_sales !== false });

        const exclude = Array.isArray(q.exclude_status) && q.exclude_status.length > 0
            ? q.exclude_status.map(str)
            : ['discarded'];
        const excludeSql = ` ${sql ? 'AND' : 'WHERE'} status NOT IN (${exclude.map(() => '?').join(',')})`;

        const totals = db.prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM tickets${sql}${excludeSql}`
        ).get(...args, ...exclude);

        const byStatus = db.prepare(
            `SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM tickets${sql}${excludeSql} GROUP BY status`
        ).all(...args, ...exclude);

        const folios = db.prepare(
            `SELECT ticket_key, folio, client_invoice_id, invoice_number, total, status, document_id, document_invoice, created_at
             FROM tickets${sql}${excludeSql} ORDER BY created_at_ms`
        ).all(...args, ...exclude);

        return {
            ok: true,
            count: totals ? num(totals.count) : 0,
            total: totals ? num(totals.total) : 0,
            by_status: byStatus,
            tickets: folios,
        };
    } catch (err) {
        console.error('[ledger] summary falló:', err && err.message);
        return { ok: false, error: String((err && err.message) || err) };
    }
}

/**
 * Recorre la cadena de eventos y recalcula cada sello. Devuelve dónde se rompió, si se
 * rompió. Es lo que convierte esto en una bitácora y no en una tabla más: un renglón
 * quitado o retocado por fuera se ve, aunque quien lo hiciera tuviera acceso al archivo.
 */
function verify(limit) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };

    try {
        const max = Math.min(Math.max(num(limit) || 20000, 1), 200000);
        const rows = db.prepare(
            'SELECT * FROM ticket_events ORDER BY seq LIMIT ?'
        ).all(max);

        // La cadena no empieza necesariamente en 1: si hubo archivado por retención,
        // empieza donde lo dejó el último ancla y encadena con el hash que éste guardó.
        // Ése es todo el truco — el hueco sólo se acepta si hay recibo de por medio, así
        // que sacar eventos por fuera de archive() sigue saliendo como "alterada".
        const ancla = db.prepare(
            'SELECT to_seq, last_hash, file FROM ledger_archives ORDER BY to_seq DESC LIMIT 1'
        ).get();

        let prev = ancla ? String(ancla.last_hash) : '';
        let expectedSeq = ancla ? num(ancla.to_seq) + 1 : 1;
        const desdeArchivo = ancla ? String(ancla.file) : '';
        for (const r of rows) {
            if (num(r.seq) !== expectedSeq) {
                return {
                    ok: true, intact: false, checked: 0, events: rows.length,
                    broken_at: num(r.seq),
                    archived_until: ancla ? num(ancla.to_seq) : 0,
                    reason: `falta el evento ${expectedSeq} (el siguiente en la base es el ${num(r.seq)})`,
                };
            }
            if (String(r.prev_hash) !== prev) {
                return {
                    ok: true, intact: false, checked: expectedSeq - 1, events: rows.length,
                    broken_at: num(r.seq),
                    reason: `el evento ${num(r.seq)} no encadena con el anterior`,
                };
            }
            const body = [prev, num(r.seq), num(r.at_ms), str(r.ticket_key), str(r.kind), str(r.status), num(r.total), str(r.detail)].join('|');
            const hash = sha256(body);
            if (hash !== String(r.row_hash)) {
                return {
                    ok: true, intact: false, checked: expectedSeq - 1, events: rows.length,
                    broken_at: num(r.seq),
                    reason: `el evento ${num(r.seq)} fue modificado después de escribirse`,
                };
            }
            prev = hash;
            expectedSeq += 1;
        }

        return {
            ok: true, intact: true, checked: rows.length, events: rows.length, broken_at: 0, reason: '',
            archived_until: ancla ? num(ancla.to_seq) : 0,
            archived_file: desdeArchivo
        };
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
    }
}

function stats() {
    const base = status();
    if (!db) return base;

    try {
        const tickets = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM tickets WHERE deleted_at = 0').get();
        const unresolved = db.prepare(
            "SELECT COUNT(*) AS n FROM tickets WHERE deleted_at = 0 AND acknowledged_at = 0 " +
            "AND cancelled = 0 AND status NOT IN ('registered', 'discarded')").get();
        const removed = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE deleted_at > 0').get();
        const vouchers = db.prepare('SELECT COUNT(*) AS n FROM emv_vouchers').get();
        const products = db.prepare('SELECT COUNT(*) AS n FROM ticket_products').get();
        const first = db.prepare('SELECT created_at FROM tickets WHERE deleted_at = 0 ORDER BY created_at_ms LIMIT 1').get();

        let bytes = 0;
        try { bytes = fs.statSync(dbPath).size; } catch { bytes = 0; }
        let shadowBytes = 0;
        if (shadowPath) {
            try { shadowBytes = fs.statSync(shadowPath).size; } catch { shadowBytes = 0; }
        }

        const archivados = db.prepare(
            'SELECT COUNT(*) AS n, COALESCE(SUM(events),0) AS e, COALESCE(SUM(tickets),0) AS t, MAX(to_seq) AS s FROM ledger_archives'
        ).get();

        return {
            ...base,
            retention_days: RETENTION_DAYS,
            archives: archivados ? num(archivados.n) : 0,
            archived_events: archivados ? num(archivados.e) : 0,
            archived_tickets: archivados ? num(archivados.t) : 0,
            archived_until_seq: archivados ? num(archivados.s) : 0,
            tickets: tickets ? num(tickets.n) : 0,
            tickets_total: tickets ? num(tickets.t) : 0,
            unresolved: unresolved ? num(unresolved.n) : 0,
            removed: removed ? num(removed.n) : 0,
            vouchers: vouchers ? num(vouchers.n) : 0,
            products: products ? num(products.n) : 0,
            since: first ? String(first.created_at) : '',
            bytes,
            shadow_bytes: shadowBytes,
        };
    } catch (err) {
        return { ...base, error: String((err && err.message) || err) };
    }
}

// ── Retención: archivado con ancla ──────────────────────────────────────────────
//
// Ver la cabecera del archivo. Resumen de las reglas, que son lo que hace que esto no sea
// simplemente "borrar lo viejo":
//
//   1. Sólo salen ventas RESUELTAS. Una venta cobrada y sin registrar de hace un año se
//      queda: es justo la que alguien tiene que atender.
//   2. Los eventos salen por PREFIJO de la cadena (`seq <= toSeq`), nunca salteados: la
//      cadena que queda sigue encadenando consigo misma.
//   3. El corte del prefijo se retrasa hasta ANTES del primer evento de cualquier ticket
//      que se queda. Así ningún ticket vivo pierde su historia.
//   4. Antes de borrar se escribe el archivo y se calcula su SHA-256; el ancla lo guarda.
//      Si el archivo no se pudo escribir, no se borra nada.
//   5. El borrado va dentro de UNA transacción con la llave `ledger_guard` levantada. Un
//      fallo a media operación revierte la llave junto con todo lo demás.

function archivesDir() {
    return path.join(path.dirname(dbPath), 'archivo');
}

/** Rango y contenido que le tocaría a un archivado ahora. No escribe nada. */
function archivePlan(cutoffMs) {
    const cutoff = num(cutoffMs);

    const tope = db.prepare('SELECT MAX(seq) AS s FROM ticket_events WHERE at_ms < ?').get(cutoff);
    let toSeq = num(tope && tope.s);
    if (toSeq <= 0) return { toSeq: 0, keys: [] };

    // Tickets que se QUEDAN. El corte del prefijo no puede pasarse de su primer evento.
    const vivo = `
        SELECT ticket_key FROM tickets
        WHERE NOT (
            updated_at_ms < ?
            AND (status IN (${RESOLVED_SQL_IN}) OR deleted_at > 0 OR acknowledged_at > 0)
        )`;
    const frontera = db.prepare(
        `SELECT MIN(seq) AS s, ticket_key AS k FROM ticket_events WHERE ticket_key <> '' AND ticket_key IN (${vivo})`
    ).get(cutoff);
    const primeroVivo = num(frontera && frontera.s);

    // Consecuencia de la regla 3 que hay que tener presente: una venta ANTIGUA y SIN
    // RESOLVER frena la retención de todo lo que vino después, porque el prefijo no puede
    // rebasar su primer evento. Es el comportamiento que se quiere —esa venta no puede
    // desaparecer— pero en silencio se convertiría en "la base no para de crecer y nadie
    // sabe por qué". Así que se devuelve quién frena, y el llamador lo reporta.
    let frenadoPor = '';
    if (primeroVivo > 0 && primeroVivo - 1 < toSeq) frenadoPor = String((frontera && frontera.k) || '');
    if (primeroVivo > 0) toSeq = Math.min(toSeq, primeroVivo - 1);
    if (toSeq <= 0) return { toSeq: 0, keys: [], blockedBy: frenadoPor };

    // Y de los archivables, sólo los que caben ENTEROS en el prefijo.
    const keys = db.prepare(`
        SELECT t.ticket_key AS k FROM tickets t
        WHERE t.updated_at_ms < ?
          AND (t.status IN (${RESOLVED_SQL_IN}) OR t.deleted_at > 0 OR t.acknowledged_at > 0)
          AND COALESCE((SELECT MAX(e.seq) FROM ticket_events e WHERE e.ticket_key = t.ticket_key), 0) <= ?
    `).all(cutoff, toSeq).map((r) => String(r.k));

    return { toSeq, keys, blockedBy: frenadoPor };
}

/**
 * Saca de la base lo que ya cumplió la retención y deja el ancla. Devuelve
 * { ok, archived, file, tickets, events } — `archived:false` cuando no había nada que sacar,
 * que es el caso normal en una caja nueva.
 */
function archive(options) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };

    const o = options && typeof options === 'object' ? options : {};
    const days = Math.max(1, num(o.days) || RETENTION_DAYS);
    const cutoff = num(o.cutoff_ms) || (Date.now() - days * 24 * 60 * 60 * 1000);

    try {
        const { toSeq, keys, blockedBy } = archivePlan(cutoff);
        if (toSeq <= 0) {
            return {
                ok: true, archived: false, blocked_by: blockedBy || '',
                reason: blockedBy
                    ? `la retención está frenada por la venta ${blockedBy}, que sigue sin resolverse`
                    : 'no hay nada que cumpla la retención'
            };
        }
        if (blockedBy) {
            console.warn(`[ledger] la retención se detiene en la venta ${blockedBy} (sin resolver): ` +
                'se archiva sólo lo anterior a ella');
        }

        const eventos = db.prepare('SELECT * FROM ticket_events WHERE seq <= ? ORDER BY seq').all(toSeq);
        if (!eventos.length) return { ok: true, archived: false, reason: 'sin eventos en el tramo' };

        const fromSeq = num(eventos[0].seq);
        const lastRow = eventos[eventos.length - 1];
        const lastHashDelTramo = String(lastRow.row_hash);

        // Los renglones y vouchers de las ventas que salen. Se leen por lotes de llaves
        // para no armar un IN(...) de miles de parámetros.
        const enLotes = (sql, todas) => {
            const out = [];
            for (let i = 0; i < todas.length; i += 400) {
                const lote = todas.slice(i, i + 400);
                const marcas = lote.map(() => '?').join(',');
                out.push(...db.prepare(sql.replace('{{in}}', marcas)).all(...lote));
            }
            return out;
        };

        const tickets = keys.length ? enLotes('SELECT * FROM tickets WHERE ticket_key IN ({{in}})', keys) : [];
        const productos = keys.length ? enLotes('SELECT * FROM ticket_products WHERE ticket_key IN ({{in}})', keys) : [];
        const vouchers = keys.length ? enLotes('SELECT * FROM emv_vouchers WHERE ticket_key IN ({{in}})', keys) : [];

        // ── 1. El archivo, ANTES de tocar la base ──
        const dir = archivesDir();
        fs.mkdirSync(dir, { recursive: true });
        const sello = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(dir, `ventas-archivo-${sello}-seq${fromSeq}-${toSeq}.jsonl.gz`);

        const lineas = [];
        lineas.push(JSON.stringify({
            _tipo: 'encabezado',
            generado: new Date().toISOString(),
            motivo: `retención de ${days} días`,
            corte: new Date(cutoff).toISOString(),
            desde_seq: fromSeq,
            hasta_seq: toSeq,
            eventos: eventos.length,
            tickets: tickets.length,
            renglones: productos.length,
            vouchers: vouchers.length,
            base: dbPath,
            equipo: os.hostname(),
            nota: 'Archivo de retención de ventas-local. La base viva conserva el ancla en ledger_archives.'
        }));
        for (const r of eventos) lineas.push(JSON.stringify({ _tipo: 'evento', ...r }));
        for (const r of tickets) lineas.push(JSON.stringify({ _tipo: 'ticket', ...r }));
        for (const r of productos) lineas.push(JSON.stringify({ _tipo: 'renglon', ...r }));
        for (const r of vouchers) lineas.push(JSON.stringify({ _tipo: 'voucher', ...r }));

        const gz = zlib.gzipSync(Buffer.from(lineas.join('\n') + '\n', 'utf8'), { level: 6 });
        fs.writeFileSync(file, gz);
        const sha = sha256Buffer(gz);
        const bytes = gz.length;

        // ── 2. Ancla + borrado, en una sola transacción ──
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare(`
                INSERT INTO ledger_archives
                    (from_seq, to_seq, last_hash, file, sha256, bytes, tickets, events, cutoff_ms, at_ms, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(fromSeq, toSeq, lastHashDelTramo, path.basename(file), sha, bytes,
                tickets.length, eventos.length, cutoff, Date.now(), new Date().toISOString());

            // El propio archivado queda sellado en la cadena VIVA, después del tramo que
            // se va. Es lo que hace que quitar historia no pueda pasar desapercibido.
            appendEvent({
                kind: 'archivo',
                status: 'archived',
                detail: `seq ${fromSeq}-${toSeq} → ${path.basename(file)} (${tickets.length} ventas, sha ${sha.slice(0, 12)})`,
                atMs: Date.now(),
                extra: { archivo: path.basename(file), sha256: sha, desde_seq: fromSeq, hasta_seq: toSeq }
            });

            db.exec('UPDATE ledger_guard SET ok = 1 WHERE id = 1');
            if (keys.length) {
                for (let i = 0; i < keys.length; i += 400) {
                    const lote = keys.slice(i, i + 400);
                    const marcas = lote.map(() => '?').join(',');
                    db.prepare(`DELETE FROM ticket_products WHERE ticket_key IN (${marcas})`).run(...lote);
                    db.prepare(`DELETE FROM emv_vouchers WHERE ticket_key IN (${marcas})`).run(...lote);
                    db.prepare(`DELETE FROM tickets WHERE ticket_key IN (${marcas})`).run(...lote);
                }
            }
            db.prepare('DELETE FROM ticket_events WHERE seq <= ?').run(toSeq);
            db.exec('UPDATE ledger_guard SET ok = 0 WHERE id = 1');
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch { }
            // El archivo ya está escrito y la base intacta: se conserva. Un archivo de más
            // no rompe nada; un borrado sin archivo sí.
            throw err;
        }

        checkpoint();
        console.log(`[ledger] archivado: ${eventos.length} eventos y ${tickets.length} ventas → ${file}`);

        return {
            ok: true, archived: true, file, sha256: sha, bytes,
            blocked_by: blockedBy || '',
            from_seq: fromSeq, to_seq: toSeq,
            tickets: tickets.length, events: eventos.length,
            cutoff: new Date(cutoff).toISOString()
        };
    } catch (err) {
        const msg = String((err && err.message) || err);
        console.warn('[ledger] el archivado falló:', msg);
        return { ok: false, error: msg };
    }
}

// Se llama al abrir y junto al consolidado del WAL. Con cooldown: comprobar el corte es
// una consulta barata, pero no hace falta hacerla cada tres minutos durante semanas.
function archiveIfDue() {
    if (!db) return null;
    const ahora = Date.now();
    if (lastArchiveCheck && ahora - lastArchiveCheck < ARCHIVE_EVERY_MS) return null;
    lastArchiveCheck = ahora;
    try {
        const r = archive();
        return r && r.archived ? r : null;
    } catch (err) {
        console.warn('[ledger] archiveIfDue falló:', err && err.message);
        return null;
    }
}

/** Los archivados hechos en esta caja: el rastro de todo lo que salió de la base. */
function archives() {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };
    try {
        const rows = db.prepare('SELECT * FROM ledger_archives ORDER BY id DESC').all();
        const dir = archivesDir();
        return {
            ok: true,
            dir,
            retention_days: RETENTION_DAYS,
            items: rows.map((r) => {
                const full = path.join(dir, String(r.file));
                let existe = false;
                try { existe = fs.statSync(full).size > 0; } catch { existe = false; }
                return { ...r, ruta: full, existe };
            })
        };
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
    }
}

/** Volcado para soporte. No borra nada: sólo produce una copia legible. */
function exportAll(query) {
    if (!db) return { ok: false, error: initError || 'ledger no disponible' };
    try {
        const q = query && typeof query === 'object' ? query : {};
        const listed = list({ ...q, limit: Math.min(num(q.limit) || 1000, 2000) });
        return {
            ok: true,
            exported_at: new Date().toISOString(),
            stats: stats(),
            integrity: verify(),
            items: listed.items,
        };
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
    }
}

module.exports = {
    init,
    shutdown,
    checkpoint,
    status,
    stats,
    archive,
    archiveIfDue,
    archives,
    record,
    mark,
    remove,
    emv,
    list,
    get,
    summary,
    verify,
    exportAll,
    // Sólo para pruebas: en producción la base se abre una vez y no se cierra (ver la
    // cabecera — el archivo abierto es parte de la protección).
    _closeForTests() {
        shutdown();
        if (db) { try { db.close(); } catch { } }
        db = null; lastSeq = 0; lastHash = ''; dbPath = ''; shadowPath = ''; initError = '';
    },
};
