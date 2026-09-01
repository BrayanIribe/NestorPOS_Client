/**
 * Configuración del daemon de servicios (ver services.watchdog.js).
 *
 * Hasta aquí el daemon se sintonizaba SÓLO con variables de entorno, y el cliente no
 * lee ningún .env: en la práctica eso significaba que una caja corría con los valores
 * de fábrica y que cambiar cualquier cosa —el nombre del servicio de impresión, poner
 * una caja en observación— pedía entrar por escritorio remoto a tocar el entorno del
 * usuario y reiniciar. Esto le pone un archivo detrás y una ventana enfrente.
 *
 * ── Precedencia: entorno > archivo > fábrica ────────────────────────────────────
 *
 * El entorno gana SIEMPRE, y esa es la decisión importante. Una variable de entorno es
 * la vía de emergencia (arrancar una caja rota con NESTOR_SERVICES=0) y la de
 * desarrollo (el script `dev`); si el archivo pudiera pisarla, esa vía dejaría de ser
 * fiable justo cuando se necesita. A cambio, un campo fijado por entorno se le muestra
 * al operador BLOQUEADO y con el nombre de la variable que lo fija — porque el único
 * fallo peor que no poder configurar algo es configurarlo y que no surta efecto sin
 * que nadie lo diga.
 *
 * ── Dónde vive ──────────────────────────────────────────────────────────────────
 *
 * Junto a la bitácora (C:\ProgramData\NestorPOS\servicios\config.json), no en el
 * userData del cliente. Por lo mismo que la bitácora: tiene que sobrevivir al botón
 * rojo de "Eliminar datos y caché" de la ventana de Configuración. Que borrar el caché
 * te devuelva una caja apuntando al servicio equivocado sería una trampa.
 *
 * Este módulo no depende de Electron a propósito: lo carga el daemon, y también
 * scripts/check-services-wizard.js para comprobar que el asistente cubre el esquema.
 */

const fs = require('fs');
const path = require('path');

const NOMBRE_ARCHIVO = 'config.json';

/**
 * Servicios de Windows que este daemon NO puede tocar jamás.
 *
 * Nació de un incidente real: el Spooler de Windows se llama «Cola de impresión», así
 * que el filtro que destaca "lo que parece nuestro" lo subía al grupo de arriba del
 * desplegable, junto a los nuestros. Elegirlo era lo natural — dice impresión— y a
 * partir de ahí, cada vez que nestor_printer no contestaba en :8331, el rescate veía el
 * Spooler en RUNNING y le hacía `sc stop` + `sc start`. Hasta cinco veces por hora, y
 * cuando el arranque no prendía, la máquina entera se quedaba sin imprimir NADA.
 *
 * La lista vive aquí y no en la interfaz porque lo que hace daño es el `sc stop`, no el
 * desplegable: un config.json editado a mano tiene que chocar contra el mismo muro.
 * Se compara en minúsculas y por nombre exacto de servicio.
 */
const SERVICIOS_PROTEGIDOS = [
    'spooler',          // Cola de impresión. El caso que provocó esta lista.
    'winmgmt',          // WMI
    'rpcss',            // RPC
    'dcomlaunch',
    'lanmanserver', 'lanmanworkstation',
    'dhcp', 'dnscache',
    'eventlog',
    'schedule',         // Programador de tareas: el propio rescate lo necesita
    'plugplay',
    'power',
    'profsvc',
    'termservice',      // Escritorio remoto: sin él nadie entra a arreglar la caja
    'audiosrv',
    'wuauserv',
    'mssqlserver',      // Bases de datos de terceros que conviven en las cajas
    'mysql', 'mysql80'
];

/** '' si se puede usar; si no, la razón por la que no. */
function motivoProhibido(clave, valor) {
    if (clave !== 'printer_service') return '';
    const nombre = String(valor || '').trim().toLowerCase();
    if (!nombre) return '';
    if (SERVICIOS_PROTEGIDOS.includes(nombre)) {
        return `"${valor}" es un servicio del sistema: pararlo y arrancarlo dejaría la máquina peor de lo que está. `
            + 'El servicio de impresión de Nestor lo instala el componente de impresión y su nombre empieza por "Nestor".';
    }
    return '';
}

/**
 * El esquema es la única fuente de verdad: de aquí salen los valores de fábrica, el
 * saneado, la precedencia del entorno y la comprobación de que el asistente no se dejó
 * ningún campo fuera. Agregar un ajuste es agregar un renglón AQUÍ y su control en
 * src/pages/services.wizard.html; el check falla si falta cualquiera de los dos.
 *
 *   tipo    'bool' | 'int' | 'texto' | 'opcion'
 *   env     variable que lo fija (y bloquea) si está presente
 *   paso    en qué paso del asistente se edita (1..4; el 5 es el resumen)
 */
const ESQUEMA = {
    // ── Paso 1: interruptor maestro ────────────────────────────────────────────
    enabled: {
        tipo: 'bool', def: true, paso: 1, env: 'NESTOR_SERVICES',
        label: 'Vigilar los servicios de esta caja',
        ayuda: 'Apagado, el daemon ni siquiera sondea. La caja se queda como antes: si un servicio se cae, alguien tiene que ir.'
    },
    rescue: {
        tipo: 'bool', def: true, paso: 1, env: 'NESTOR_SERVICES_RESCUE',
        label: 'Rescatar automáticamente',
        ayuda: 'Apagado queda en OBSERVACIÓN: sondea, registra y reporta, pero no toca nada. Es el modo con el que conviene estrenar una caja.'
    },

    // ── Paso 2: servicio de impresión ──────────────────────────────────────────
    printer_watch: {
        tipo: 'opcion', def: 'siempre', paso: 2,
        valores: ['siempre', 'nunca'],
        label: 'Vigilancia del servicio de impresión',
        ayuda: '"nunca" es para una caja que no imprime aquí (imprime en otra, o no imprime).'
    },
    printer_service: {
        tipo: 'texto', def: '', paso: 2, env: 'NESTOR_PRINTER_SERVICE',
        label: 'Servicio de Windows',
        ayuda: 'Vacío = se descubre solo del instance.json que dejó el instalador. Una instancia adicional lo deja vacío a propósito: comparte el servicio de la principal.'
    },
    printer_instance_file: {
        tipo: 'texto', def: '', paso: 2,
        label: 'Archivo instance.json',
        ayuda: 'De dónde leer el nombre del servicio. Vacío = los dos sitios de siempre (NestorPOS y NestorComplementos).'
    },
    printer_port: {
        tipo: 'int', def: 8331, min: 1, max: 65535, paso: 2, env: 'NESTOR_PRINTER_PORT',
        label: 'Puerto',
        ayuda: 'Donde escucha nestor_printer. Cámbialo sólo si esta caja corre una instancia con puerto propio.'
    },
    printer_rescue_task: {
        tipo: 'texto', def: 'NestorPrinterRescue', paso: 2, env: 'NESTOR_PRINTER_RESCUE_TASK',
        label: 'Tarea de respaldo',
        ayuda: 'La tarea elevada que registra el instalador. Es el último escalón, para cuando el usuario de la caja no puede arrancar el servicio por sí mismo.'
    },

    // ── Paso 3: terminal EMV ───────────────────────────────────────────────────
    emv_watch: {
        tipo: 'opcion', def: 'auto', paso: 3,
        valores: ['auto', 'siempre', 'nunca'],
        label: 'Vigilancia de la terminal',
        ayuda: '"auto" = la enciende el POS cuando el paquete dice que esta caja tiene terminal. "nunca" la apaga aunque el POS la pida: es lo que se pone en una caja sin terminal para que no intente lanzar un microservicio que no le toca.'
    },
    emv_task: {
        tipo: 'texto', def: 'NestorSantanderEMV', paso: 3, env: 'NESTOR_EMV_TASK',
        label: 'Tarea programada',
        ayuda: 'La ÚNICA vía de rescate del EMV: el exe es requireAdministrator y el cliente no corre elevado, así que lanzarlo directo plantaría un UAC en la cara del cajero.'
    },
    emv_exe: {
        tipo: 'texto', def: 'NestorSantanderEmvService.exe', paso: 3, env: 'NESTOR_EMV_EXE',
        label: 'Proceso',
        ayuda: 'Sólo se usa para ver si está vivo y para terminarlo cuando quedó colgado.'
    },
    emv_port: {
        tipo: 'int', def: 5000, min: 1, max: 65535, paso: 3, env: 'NESTOR_EMV_PORT',
        label: 'Puerto',
        ayuda: 'Donde escucha el servicio EMV.'
    },

    // ── Paso 4: comportamiento ─────────────────────────────────────────────────
    watch_ms: {
        tipo: 'int', def: 15000, min: 5000, max: 600000, paso: 4, env: 'NESTOR_SERVICES_WATCH_MS',
        label: 'Cada cuánto se sondea (ms)',
        ayuda: 'Dos consultas HTTP a localhost. Bajarlo no hace daño; subirlo retrasa la detección.'
    },
    probe_ms: {
        tipo: 'int', def: 2500, min: 800, max: 30000, paso: 4, env: 'NESTOR_SERVICES_PROBE_MS',
        label: 'Paciencia de cada sondeo (ms)',
        ayuda: 'Cuánto se espera una respuesta antes de contar el sondeo como fallido.'
    },
    strikes: {
        tipo: 'int', def: 3, min: 1, max: 20, paso: 4, env: 'NESTOR_SERVICES_STRIKES',
        label: 'Fallos seguidos antes de actuar',
        ayuda: 'Un timeout suelto es normal: el printer renderiza PDFs en el mismo hilo. En 1 se actuaría ante cualquier hipo.'
    },
    quiet_ms: {
        tipo: 'int', def: 90000, min: 0, max: 900000, paso: 4, env: 'NESTOR_SERVICES_QUIET_MS',
        label: 'Silencio exigido antes de rescatar (ms)',
        ayuda: 'Si hubo trabajo hacia ese puerto hace menos que esto, no se toca. 90 s cubre una venta con tarjeta completa. En 0 se rescata sobre una venta en curso: no lo pongas en 0.'
    },
    max_per_hour: {
        tipo: 'int', def: 5, min: 1, max: 50, paso: 4, env: 'NESTOR_SERVICES_MAX_HOUR',
        label: 'Rescates por hora antes de rendirse',
        ayuda: 'Pasado el tope se declara "requiere atención" y sube una incidencia, en vez de quedarse en un bucle de reinicios que entierra la causa real.'
    },
    settle_printer_ms: {
        tipo: 'int', def: 20000, min: 3000, max: 300000, paso: 4, env: 'NESTOR_SERVICES_SETTLE_PRINTER_MS',
        label: 'Espera a que el printer conteste (ms)',
        ayuda: 'Tras lanzarlo, cuánto se le da para empezar a atender antes de contar el intento como fallido.'
    },
    settle_emv_ms: {
        tipo: 'int', def: 60000, min: 5000, max: 300000, paso: 4, env: 'NESTOR_SERVICES_SETTLE_EMV_MS',
        label: 'Espera a que el EMV conteste (ms)',
        ayuda: 'El EMV es lento de verdad: hace login contra el host de Santander y detecta el puerto COM. Quedarse corto aquí pide otro rescate encima del que está arrancando, y eso mata el proceso que acaba de nacer.'
    }
};

const CLAVES = Object.keys(ESQUEMA);

/** Valores de fábrica, sin entorno ni archivo. */
function defaults() {
    const out = {};
    for (const k of CLAVES) out[k] = ESQUEMA[k].def;
    return out;
}

/**
 * Sanea UN valor contra su definición. Devuelve el valor válido, o null si no hay
 * forma de interpretarlo (y entonces el que llama se queda con el anterior).
 *
 * Todo entra por aquí: el archivo de una caja puede estar editado a mano, y el
 * asistente manda texto de un formulario. Un watch_ms en 50 sería un sondeo cada 50 ms
 * contra dos servicios locales.
 */
function sanea(clave, valor) {
    const def = ESQUEMA[clave];
    if (!def) return null;

    if (def.tipo === 'bool') {
        if (typeof valor === 'boolean') return valor;
        const s = String(valor).trim().toLowerCase();
        if (['1', 'true', 'si', 'sí', 'on'].includes(s)) return true;
        if (['0', 'false', 'no', 'off'].includes(s)) return false;
        return null;
    }

    if (def.tipo === 'int') {
        const n = parseInt(String(valor).trim(), 10);
        if (!Number.isFinite(n)) return null;
        return Math.max(def.min, Math.min(def.max, n));
    }

    if (def.tipo === 'opcion') {
        const s = String(valor).trim().toLowerCase();
        return def.valores.includes(s) ? s : null;
    }

    // texto: se recorta y se acota. Nombres de servicio, de tarea y una ruta.
    const s = String(valor == null ? '' : valor).trim();
    return s.length > 400 ? s.slice(0, 400) : s;
}

/**
 * Qué claves fija el entorno AHORA. Se recalcula en cada llamada y no se cachea: en
 * desarrollo el proceso se relanza con variables distintas y una caché aquí haría que
 * el asistente mintiera sobre qué está bloqueado.
 */
function envOverrides() {
    const out = {};
    for (const k of CLAVES) {
        const def = ESQUEMA[k];
        if (!def.env) continue;
        const crudo = process.env[def.env];
        if (crudo === undefined || String(crudo).trim() === '') continue;
        const v = sanea(k, crudo);
        if (v !== null) out[k] = { valor: v, variable: def.env };
    }
    return out;
}

function rutaArchivo(dir) {
    return dir ? path.join(dir, NOMBRE_ARCHIVO) : '';
}

/** Lee el archivo tal cual. Nunca lanza: sin archivo (o roto) se corre de fábrica. */
function leeArchivo(dir) {
    const file = rutaArchivo(dir);
    if (!file) return { valores: {}, error: '' };
    try {
        const crudo = fs.readFileSync(file, 'utf8');
        const obj = JSON.parse(crudo);
        if (!obj || typeof obj !== 'object') return { valores: {}, error: 'el archivo no contiene un objeto' };
        return { valores: obj, error: '' };
    } catch (e) {
        if (e && e.code === 'ENOENT') return { valores: {}, error: '' };
        return { valores: {}, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * Configuración efectiva: fábrica, encima el archivo, encima el entorno.
 *
 * Devuelve también DE DÓNDE salió cada valor. Eso no es adorno: es lo que hace que el
 * asistente pueda bloquear un campo y decir por qué, y lo que convierte "lo configuré
 * y no pasó nada" en una línea de texto en vez de en una llamada a soporte.
 */
function resolve(dir) {
    const valores = defaults();
    const fuentes = {};
    for (const k of CLAVES) fuentes[k] = 'fábrica';

    const vetados = [];
    const archivo = leeArchivo(dir);
    for (const [k, v] of Object.entries(archivo.valores)) {
        if (!ESQUEMA[k]) continue;
        const limpio = sanea(k, v);
        if (limpio === null) continue;
        // El archivo pudo escribirse con una versión anterior —la que dejaba elegir el
        // Spooler— o a mano. Se ignora el valor y se sigue con el de fábrica.
        const veto = motivoProhibido(k, limpio);
        if (veto) { vetados.push({ clave: k, valor: limpio, motivo: veto }); continue; }
        valores[k] = limpio;
        fuentes[k] = 'archivo';
    }

    const env = envOverrides();
    for (const [k, o] of Object.entries(env)) {
        const veto = motivoProhibido(k, o.valor);
        if (veto) { vetados.push({ clave: k, valor: o.valor, motivo: veto }); continue; }
        valores[k] = o.valor;
        fuentes[k] = 'entorno';
    }

    return {
        valores,
        fuentes,
        env,
        archivo: rutaArchivo(dir),
        existe: !!archivo.valores && Object.keys(archivo.valores).length > 0,
        // Valores que estaban guardados y NO se están aplicando. El daemon los registra
        // en la bitácora y el asistente los enseña: un ajuste que se ignora en silencio
        // es cómo se pierde media mañana.
        vetados,
        error: archivo.error
    };
}

/**
 * Guarda un cambio PARCIAL y devuelve la configuración efectiva resultante.
 *
 * Sólo se escriben las claves que el entorno no fija: guardar un valor que no se va a
 * aplicar dejaría el archivo diciendo una cosa y la caja haciendo otra. Las claves
 * bloqueadas se devuelven en `ignoradas` para que el asistente lo diga en pantalla.
 *
 * La escritura es atómica (archivo temporal + rename). Un corte de luz a media
 * escritura dejaría un JSON truncado, y eso es una caja que arranca de fábrica sin
 * avisar.
 */
function save(dir, parcial) {
    if (!dir) return { ok: false, error: 'no hay dónde escribir la configuración' };

    const env = envOverrides();
    const actual = leeArchivo(dir).valores || {};
    const guardado = {};
    for (const [k, v] of Object.entries(actual)) {
        if (ESQUEMA[k]) guardado[k] = v;
    }

    const ignoradas = [];
    const rechazadas = [];
    const aplicadas = [];
    for (const [k, v] of Object.entries(parcial || {})) {
        if (!ESQUEMA[k]) continue;
        if (env[k]) { ignoradas.push({ clave: k, variable: env[k].variable }); continue; }
        const limpio = sanea(k, v);
        if (limpio === null) continue;

        // Guardar esto sería armar la trampa para dentro de una semana, cuando el
        // printer falle por primera vez y el rescate tumbe un servicio del sistema.
        const veto = motivoProhibido(k, limpio);
        if (veto) { rechazadas.push({ clave: k, valor: limpio, motivo: veto }); continue; }

        guardado[k] = limpio;
        aplicadas.push(k);
    }

    const file = rutaArchivo(dir);
    const tmp = `${file}.tmp`;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ ...guardado, updated_at: new Date().toISOString() }, null, 2));
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { }
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }

    return { ok: true, aplicadas, ignoradas, rechazadas, config: resolve(dir) };
}

/** Borra el archivo: la caja vuelve a fábrica (más lo que fije el entorno). */
function reset(dir) {
    const file = rutaArchivo(dir);
    if (!file) return { ok: false, error: 'no hay archivo de configuración' };
    try {
        fs.rmSync(file, { force: true });
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
    return { ok: true, config: resolve(dir) };
}

module.exports = {
    ESQUEMA, CLAVES, SERVICIOS_PROTEGIDOS, defaults, sanea, motivoProhibido,
    envOverrides, resolve, save, reset, leeArchivo, rutaArchivo
};
