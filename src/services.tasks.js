/**
 * Tareas programadas y permisos de la caja: diagnóstico y reparación.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────────
 *
 * El daemon (services.watchdog.js) rescata la terminal EMV con `schtasks /Run`. Ese
 * comando devuelve 0 en cuanto el Programador de tareas ACEPTA la petición: no espera
 * al proceso, no mira si la tarea llegó a arrancar y no dice por qué no. El daemon lo
 * tomaba como éxito, se quedaba 60 s esperando en el puerto 5000, no pasaba nada, y
 * volvía a intentarlo — para siempre. Desde la caja eso se ve como «Rescatando» fijo.
 *
 * Las cuatro formas reales de que `/Run` devuelva 0 sin arrancar nada:
 *
 *   1. MultipleInstancesPolicy = IgnoreNew, que es lo que deja `schtasks /Create` por
 *      omisión. La acción de la tarea ES el ejecutable del EMV, y ese ejecutable vive
 *      mientras viva su ícono de bandeja: para el Programador la instancia sigue
 *      CORRIENDO, así que ignora la nueva. `/Run` devuelve 0 igual. Es la causa más
 *      probable del atasco, y la más difícil de ver: matar el proceso antes no basta
 *      porque el Programador tarda en darse cuenta y el daemon sólo esperaba 1.5 s.
 *   2. La tarea está registrada a nombre del usuario que INSTALÓ (`schtasks /Create`
 *      sin `/RU`) y la caja inicia sesión con otro. Último resultado 0x41303: «nunca
 *      se ejecutó». `/Run` devuelve 0.
 *   3. La acción apunta a un .exe que ya no está (antivirus, carpeta movida,
 *      reinstalación en otra ruta). Último resultado 0x2.
 *   4. La tarea está deshabilitada.
 *
 * Ninguna se distingue desde el código de salida. Todas se distinguen leyendo la
 * DEFINICIÓN de la tarea y su ÚLTIMO RESULTADO, que es lo que hace este módulo.
 *
 * ── Y por qué además la repara ──────────────────────────────────────────────────
 *
 * docs/daemon-servicios.md describía tres procedimientos del instalador —
 * `HardenPrinterService`, `GrantServiceControlToInteractiveUsers` y
 * `RegisterPrinterRescueTask`— que NUNCA se escribieron: `NestorPrinterRescue` no
 * aparece en NestorPOS_Setup.iss por ningún lado. O sea que el tercer escalón del
 * rescate del printer —el que existe justo para la caja cuyo cajero no puede hacer
 * `sc start`— nunca estuvo ahí, y el asistente ofrecía configurar el nombre de una
 * tarea inexistente. De ahí que «Tarea de respaldo» no se entendiera: no había nada
 * que entender.
 *
 * Arreglarlo sólo en el instalador no sirve: las cajas ya instaladas no se reinstalan.
 * Así que el cliente sabe montarlo él mismo, desde el asistente, con un botón.
 *
 * ── La elevación, dicha en voz alta ─────────────────────────────────────────────
 *
 * Registrar tareas y tocar la DACL de un servicio pide administrador, y el cliente NO
 * corre elevado (el instalador crea su tarea de autoarranque sin /RL HIGHEST, a
 * propósito). Así que la reparación abre UN aviso de UAC, UNA vez, y sólo cuando una
 * persona pulsa el botón. Nunca automáticamente: un UAC apareciendo solo a media venta
 * es peor que el fallo que vendría a arreglar.
 *
 * El script elevado se escribe en un directorio temporal del PROPIO usuario
 * (mkdtemp), no junto a la bitácora: ProgramData es escribible por cualquier usuario
 * de la máquina, y dejar ahí un script que va a correr como administrador es regalar
 * una escalada de privilegios a cambio de nada.
 *
 * Nada de esto lanza. Todo responde { ok:false, error } — es instrumentación, y un
 * fallo suyo no puede tumbar una venta.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

/** Ruta habitual del componente EMV. Es la que deja el instalador (#define EmvDir). */
const EMV_EXE_DEFAULT = 'C:\\NestorMX\\SantanderEMV\\NestorSantanderEmvService.exe';

/**
 * Descriptor de seguridad de las tareas que registramos.
 *
 * Administradores y SYSTEM con control total; usuarios autenticados con lectura y
 * EJECUCIÓN (FRFX). Ese FX es todo el asunto: sin él, el cajero —que no es
 * administrador— recibe «Acceso denegado» al hacer `schtasks /Run`, y el rescate del
 * EMV queda muerto en la única caja donde de verdad hace falta.
 */
const SDDL_TAREA = 'D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FRFX;;;AU)';

/**
 * Nombres de tarea aceptables.
 *
 * No es paranoia de más: el nombre sale de config.json, que es un archivo de texto
 * editable a mano, y de ahí acaba dentro de un `powershell -Command`. `execFile` con
 * argumentos en arreglo protege del shell de Windows, pero NO del intérprete de
 * PowerShell. Lo que se le pasa a PowerShell viaja por variable de entorno (ver
 * psJson) y además el nombre tiene que encajar aquí.
 */
const NOMBRE_TAREA_OK = /^[A-Za-z0-9 _\-.\\()]{1,120}$/;

/** Últimos resultados que sabemos leer. Lo demás se enseña en hexadecimal. */
const RESULTADOS = {
    0: 'la última vez arrancó bien',
    1: 'la última vez terminó con un error genérico (0x1)',
    2: 'NO ENCONTRÓ EL EJECUTABLE de la acción (0x2): la ruta que tiene guardada ya no existe',
    267009: 'ahora mismo se está ejecutando (0x41301)',
    267010: 'está en cola, esperando a que termine la instancia anterior (0x41302)',
    267011: 'NUNCA SE HA EJECUTADO (0x41303)',
    267014: 'la última ejecución se canceló a mano (0x41306)',
    2147942401: 'no encontró el ejecutable (0x80070002)',
    2147942405: 'ACCESO DENEGADO al ejecutar (0x80070005)',
    2147943645: 'no se ejecutó porque el usuario de la tarea NO TENÍA SESIÓN INICIADA (0x8007041D)',
    3221225786: 'el proceso se cerró con Ctrl+C (0xC000013A)'
};

function textoResultado(codigo) {
    if (codigo === null || codigo === undefined || codigo === '') return '';
    const n = Number(codigo);
    if (!Number.isFinite(n)) return String(codigo);
    if (RESULTADOS[n]) return RESULTADOS[n];
    // Sin signo y en hexadecimal, que es como lo enseña el Programador de tareas y
    // como se busca en internet.
    const sinSigno = n < 0 ? n >>> 0 : n;
    return `último resultado 0x${sinSigno.toString(16).toUpperCase()}`;
}

/**
 * Corre un ejecutable y devuelve { code, stdout, stderr }. Nunca lanza y siempre tiene
 * tope de tiempo: `schtasks` se cuelga contra un Programador ocupado, y aquí no
 * podemos permitirnos un await eterno. Copia deliberada de la de services.watchdog.js:
 * este módulo lo cargan también los scripts de comprobación, y no debe arrastrar el
 * daemon entero sólo para reutilizar diez líneas.
 */
function run(exe, args, timeoutMs, extraEnv) {
    return new Promise((resolve) => {
        try {
            execFile(exe, args, {
                timeout: Math.max(1000, timeoutMs || 15000),
                windowsHide: true,
                encoding: 'utf8',
                maxBuffer: 4 * 1024 * 1024,
                env: extraEnv ? { ...process.env, ...extraEnv } : process.env
            }, (err, stdout, stderr) => {
                resolve({
                    code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                    error: err && err.message ? err.message : ''
                });
            });
        } catch (e) {
            resolve({ code: -1, stdout: '', stderr: '', error: e && e.message ? e.message : String(e) });
        }
    });
}

function sysExe(nombre) {
    const base = process.env.SystemRoot || 'C:\\Windows';
    return path.join(base, 'System32', nombre);
}

function psExe() {
    const base = process.env.SystemRoot || 'C:\\Windows';
    return path.join(base, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Corre un fragmento de PowerShell que imprime JSON y lo devuelve parseado.
 *
 * Los datos variables van por VARIABLE DE ENTORNO, nunca interpolados en el texto del
 * script: el nombre de la tarea sale de un archivo de configuración editable a mano, y
 * `powershell -Command` sí interpreta lo que le llega.
 */
async function psJson(script, entorno, timeoutMs) {
    const r = await run(psExe(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], timeoutMs || 20000, entorno);
    const texto = String(r.stdout || '').trim();
    if (!texto) return { ok: false, error: (r.stderr || r.error || 'sin salida').trim().slice(0, 300) };
    try {
        return { ok: true, datos: JSON.parse(texto) };
    } catch {
        return { ok: false, error: `salida no interpretable: ${texto.slice(0, 200)}` };
    }
}

// ── Quién es el usuario de esta caja ─────────────────────────────────────────────

/**
 * El usuario con el que corre el cliente, en la forma DOMINIO\usuario que espera el
 * Programador de tareas. Es a nombre de QUIEN hay que registrar la tarea del EMV: la
 * que dejó el instalador va a nombre de quien instaló, y si la caja inicia sesión con
 * otra cuenta el disparador ONLOGON no se dispara nunca para ella.
 */
function usuarioActual() {
    const dominio = process.env.USERDOMAIN || process.env.COMPUTERNAME || '';
    const usuario = process.env.USERNAME || '';
    if (!usuario) return '';
    return dominio ? `${dominio}\\${usuario}` : usuario;
}

/**
 * ¿Este usuario es administrador de la máquina?
 *
 * Por el SID S-1-5-32-544 en `whoami /groups`, no por `IsInRole`. Un administrador sin
 * elevar lleva ese grupo marcado "sólo para denegar", así que `IsInRole` devuelve
 * False y diríamos que no es administrador cuando sí lo es — y esa respuesta cambia el
 * consejo que se le da al operador. El SID no se traduce; los nombres de grupo sí.
 */
async function esAdministrador() {
    if (!IS_WIN) return false;
    const r = await run(sysExe('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], 10000);
    return /S-1-5-32-544/.test(`${r.stdout}${r.stderr}`);
}

// ── Leer una tarea ───────────────────────────────────────────────────────────────

function xmlTexto(xml, etiqueta) {
    const m = new RegExp(`<${etiqueta}[^>]*>([\\s\\S]*?)</${etiqueta}>`, 'i').exec(xml);
    if (!m) return '';
    return m[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}

/** SIDs de cuenta de servicio que el XML de una tarea trae sin traducir. */
const SIDS = {
    'S-1-5-18': 'SYSTEM',
    'S-1-5-19': 'LOCAL SERVICE',
    'S-1-5-20': 'NETWORK SERVICE'
};

/**
 * Una cuenta de usuario normal viene en el XML como SID crudo, no como DOMINIO\usuario.
 *
 * Esto se descubrió con una caja delante: la tarea del EMV traía
 * `S-1-5-21-…-1002` en el UserId. Comparar eso contra "EQUIPO\usuario" da SIEMPRE
 * distinto — o sea que una tarea perfectamente registrada se habría declarado «a nombre
 * de otro usuario», bloqueante, y el daemon habría dejado de intentarla. Un falso
 * positivo aquí es peor que no comprobar nada: apaga la vía principal de rescate.
 *
 * Así que la comparación se hace por SID cuando se conocen los dos, y por nombre sólo
 * cuando el XML trae un nombre de verdad.
 */
function esSid(v) {
    return /^S-1-[0-9-]+$/i.test(String(v || '').trim());
}

/**
 * Todo lo que se puede saber de una tarea SIN elevar.
 *
 * Devuelve siempre un objeto; `existe:false` no es un error. El campo que de verdad
 * importa es `problemas`: la lista de razones por las que `schtasks /Run` va a
 * devolver 0 sin arrancar nada. Eso es lo que el daemon convierte en un mensaje
 * accionable en vez de dejar la caja en «Rescatando» hasta que alguien llame.
 */
async function taskInfo(nombre, opciones) {
    const opts = opciones || {};
    const info = {
        nombre: String(nombre || ''),
        existe: false,
        habilitada: null,
        // A nombre de quién corre la tarea, en legible; y su SID, que es lo que trae el
        // XML para una cuenta de usuario normal y por lo que de verdad se compara.
        usuario: '',
        usuarioSid: '',
        // Quién está usando la caja AHORA, según Windows. Se lee aquí mismo para no
        // depender de USERNAME/USERDOMAIN, que son variables de entorno.
        usuarioActual: '',
        usuarioActualSid: '',
        logonType: '',
        runLevel: '',
        elevada: false,
        comando: '',
        argumentos: '',
        multipleInstances: '',
        tieneDisparadorLogon: false,
        ultimoResultado: null,
        ultimoResultadoTexto: '',
        ultimaEjecucion: '',
        // Recién creada y nunca disparada. Es el estado normal de la tarea de respaldo,
        // que no tiene disparador y existe sólo para que alguien la llame.
        nuncaEjecutada: false,
        estado: '',
        // Por qué esta tarea no va a rescatar nada. Vacío = no se le ve problema.
        problemas: [],
        // El subconjunto de `problemas` que hace INÚTIL intentar dispararla. Se separa
        // porque no todos pesan igual: una tarea en "IgnoreNew" a veces arranca (si el
        // Programador ya reaparejó la instancia anterior) y a veces no, así que se
        // intenta igual y se comprueba el resultado; una tarea deshabilitada o apuntando
        // a un .exe que no está no va a arrancar nunca, y probar sólo gasta el tiempo
        // que la caja pasa sin cobrar.
        bloqueantes: [],
        error: ''
    };

    if (!IS_WIN) {
        info.error = `no aplica en ${process.platform}`;
        return info;
    }
    if (!NOMBRE_TAREA_OK.test(info.nombre)) {
        info.error = `"${info.nombre}" no es un nombre de tarea válido`;
        return info;
    }

    // El XML es la única lectura independiente del idioma: los NOMBRES de los campos de
    // `/V /FO LIST` están traducidos en un Windows en español, los de las etiquetas XML
    // no. Las cajas corren Windows en español.
    const r = await run(sysExe('schtasks.exe'), ['/Query', '/TN', info.nombre, '/XML', 'ONE'], 15000);
    const salida = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0 || !/<Task[\s>]/i.test(r.stdout)) {
        if (/denegado|denied|0x80070005/i.test(salida)) {
            info.error = 'existe pero este usuario no puede consultarla (acceso denegado)';
            info.problemas.push('este usuario no tiene permiso ni para LEER la tarea, así que tampoco podrá dispararla');
            info.bloqueantes = info.problemas.slice();
            return info;
        }
        return info;   // no existe
    }

    info.existe = true;
    const xml = r.stdout;

    const habilitada = xmlTexto(xml, 'Enabled');
    info.habilitada = habilitada === '' ? true : /true/i.test(habilitada);

    const principal = (/<Principal[\s\S]*?<\/Principal>/i.exec(xml) || [''])[0];
    const uid = xmlTexto(principal, 'UserId');
    info.usuarioSid = esSid(uid) ? uid : '';
    info.usuario = SIDS[uid.toUpperCase()] || uid;
    info.logonType = xmlTexto(principal, 'LogonType');
    info.runLevel = xmlTexto(principal, 'RunLevel');
    info.elevada = /highest/i.test(info.runLevel);

    const exec = (/<Exec[\s\S]*?<\/Exec>/i.exec(xml) || [''])[0];
    info.comando = xmlTexto(exec, 'Command').replace(/^"|"$/g, '');
    info.argumentos = xmlTexto(exec, 'Arguments');

    info.multipleInstances = xmlTexto(xml, 'MultipleInstancesPolicy');
    info.tieneDisparadorLogon = /<LogonTrigger[\s>]/i.test(xml);

    // Último resultado y estado. Va por PowerShell porque `Get-ScheduledTaskInfo`
    // devuelve números y no texto traducido, y el número es justo lo que distingue
    // «nunca se ejecutó» de «no encontró el .exe». Si falla —una caja sin el módulo
    // ScheduledTasks— se sigue: todo lo de arriba ya sirve.
    // Cuatro cosas en una sola llamada, porque arrancar PowerShell cuesta medio segundo
    // y esto corre en mitad de un rescate:
    //
    //   · El último resultado como NÚMERO. Es lo único que distingue «nunca se ejecutó»
    //     de «no encontró el .exe», y `schtasks /V` lo imprime traducido — las cajas
    //     corren Windows en español.
    //   · La identidad de quien está usando la caja, con su SID.
    //   · El nombre de la cuenta de la tarea, traducido desde su SID.
    //
    // `if` no es una expresión en PowerShell 5.1: dentro de un @{} es un error de
    // sintaxis y la llamada devolvería salida vacía sin decir por qué. Se calcula antes.
    const ps = await psJson([
        '$ErrorActionPreference = "Stop";',
        '$n = $env:NESTOR_TASK_NAME;',
        '$i = Get-ScheduledTaskInfo -TaskName $n -TaskPath "\\";',
        '$t = Get-ScheduledTask -TaskName $n -TaskPath "\\";',
        '$u = "";',
        'if ($i.LastRunTime) { $u = $i.LastRunTime.ToString("s") };',
        '$yo = [System.Security.Principal.WindowsIdentity]::GetCurrent();',
        '$tn = "";',
        '$ts = $env:NESTOR_TASK_USER;',
        // Una cuenta borrada no se traduce. No es un error: se sigue con el SID, que
        // para comparar sirve igual.
        'if ($ts) { try { $tn = (New-Object System.Security.Principal.SecurityIdentifier($ts)).Translate([System.Security.Principal.NTAccount]).Value } catch { $tn = "" } };',
        '$o = New-Object psobject -Property @{ r = [int64]$i.LastTaskResult; u = $u; s = [string]$t.State;',
        'me = [string]$yo.Name; meSid = [string]$yo.User.Value; tn = $tn };',
        '[Console]::Out.Write(($o | ConvertTo-Json -Compress))'
    ].join(' '), {
        NESTOR_TASK_NAME: info.nombre,
        NESTOR_TASK_USER: info.usuarioSid
    }, opts.timeoutMs || 20000);

    if (ps.ok && ps.datos) {
        info.ultimoResultado = typeof ps.datos.r === 'number' ? ps.datos.r : null;
        info.ultimoResultadoTexto = textoResultado(ps.datos.r);
        info.ultimaEjecucion = String(ps.datos.u || '');
        info.estado = String(ps.datos.s || '');

        // «Nunca se ha ejecutado» es el estado NORMAL de una tarea recién creada, no una
        // avería. El Programador lo marca con una fecha centinela (30/11/1999) y el
        // último resultado 0x41303 — los mismos dos valores que tiene una tarea que sí se
        // disparó y no llegó a correr. Distinguirlos importa: sin esto, la tarea de
        // respaldo se instalaba bien y el paso «Requisitos» seguía diciendo que faltaba,
        // así que el operador volvía a pulsar el botón, aceptaba otro UAC y no cambiaba
        // nada. Es exactamente el bucle que se reportó desde la caja.
        info.nuncaEjecutada = !info.ultimaEjecucion
            || Number(String(info.ultimaEjecucion).slice(0, 4)) < 2000;
        if (info.nuncaEjecutada) info.ultimaEjecucion = '';
        info.usuarioActual = String(ps.datos.me || '');
        info.usuarioActualSid = String(ps.datos.meSid || '');
        // El SID traducido a algo legible. Enseñarle un S-1-5-21-… a quien atiende la
        // caja no le dice si es la cuenta correcta o no.
        if (ps.datos.tn) info.usuario = String(ps.datos.tn);
    }

    const diag = problemasDe(info, {
        ...opts,
        // La identidad que acabamos de leer manda sobre la que nos pasaran: sale de
        // Windows, no de unas variables de entorno que un script pudo cambiar.
        usuarioEsperado: info.usuarioActual || opts.usuarioEsperado || '',
        sidEsperado: info.usuarioActualSid || ''
    });
    info.problemas = diag.problemas;
    info.bloqueantes = diag.bloqueantes;
    return info;
}

/**
 * Las razones por las que esta tarea no va a servir de rescate.
 *
 * Cada renglón está redactado para que se pueda LEER EN LA CAJA y se sepa qué hacer.
 * "Rescatando" no es un diagnóstico; "la tarea está a nombre de MOSTRADOR2\admin y
 * quien usa la caja es MOSTRADOR2\cajera" sí.
 */
function problemasDe(info, opciones) {
    const opts = opciones || {};
    const problemas = [];
    const bloqueantes = [];

    // grave = no tiene sentido ni intentar dispararla.
    const anota = (grave, texto) => {
        problemas.push(texto);
        if (grave) bloqueantes.push(texto);
    };

    if (info.habilitada === false) {
        anota(true, 'la tarea está DESHABILITADA: el Programador acepta la petición y no hace nada');
    }

    // El caso que más cuesta ver, y el que mejor explica el «Rescatando» eterno. La
    // acción de la tarea del EMV es el propio ejecutable, que vive mientras viva su
    // ícono de bandeja: para el Programador la instancia sigue corriendo, así que con
    // IgnoreNew descarta cada nueva petición — y `schtasks /Run` devuelve 0 igual.
    // Matar el proceso antes tampoco basta: el Programador tarda en reaparejar y el
    // daemon sólo esperaba segundo y medio.
    //
    // No es bloqueante porque a veces SÍ arranca (cuando el Programador ya se dio
    // cuenta de que la instancia anterior murió). Se intenta, y se comprueba después si
    // apareció el proceso: eso distingue las dos situaciones sin adivinar.
    if (opts.procesoLargo && /ignorenew/i.test(info.multipleInstances)) {
        // Si además el Programador la tiene en cola o corriendo, ya no es un riesgo: es
        // lo que está pasando ahora mismo. Vale la pena decirlo con esas palabras,
        // porque es la prueba que convierte «Restableciendo… desde hace una hora» en un
        // diagnóstico.
        const enCurso = /^(queued|running)$/i.test(String(info.estado || ''));
        anota(false, 'la tarea está en "IgnoreNew": mientras el Programador crea que la instancia anterior sigue viva, '
            + 'descarta el arranque y schtasks /Run devuelve 0 sin hacer nada'
            + (enCurso ? ` — y ahora mismo la tiene en "${info.estado}", así que es justo lo que está ocurriendo` : ''));
    }

    // ── ¿La tarea es de quien usa la caja? ──────────────────────────────────────
    //
    // `schtasks /Create` sin `/RU` deja la tarea a nombre de quien instaló. Si la caja
    // inicia sesión con otra cuenta, el disparador ONLOGON no se dispara nunca para ella
    // y un `/Run` a mano queda en 0x41303 — devolviendo 0.
    //
    // La comparación se hace por SID, y sólo por nombre cuando el XML trae un nombre de
    // verdad. Una caja real trajo el UserId como `S-1-5-21-…-1002`: comparar eso contra
    // "EQUIPO\usuario" da distinto SIEMPRE, y habría declarado bloqueante —o sea, no
    // intentable— una tarea que estaba perfectamente registrada. Cuando no se puede
    // comparar con certeza NO se acusa: apagar la vía principal de rescate por una
    // sospecha es peor que no comprobar nada.
    const deServicio = /^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(info.usuario || '')
        || ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(String(info.usuarioSid || '').toUpperCase());

    if (!deServicio) {
        let mismo = null;   // null = no se puede saber
        if (opts.sidEsperado && info.usuarioSid) {
            mismo = String(info.usuarioSid).toLowerCase() === String(opts.sidEsperado).toLowerCase();
        } else if (opts.usuarioEsperado && info.usuario && !esSid(info.usuario)) {
            const esperado = String(opts.usuarioEsperado);
            mismo = info.usuario.toLowerCase() === esperado.toLowerCase()
                || info.usuario.toLowerCase() === esperado.split('\\').pop().toLowerCase();
        }
        if (mismo === false) {
            anota(true, `la tarea está registrada a nombre de ${info.usuario} y esta caja trabaja con `
                + `${opts.usuarioEsperado || 'otra cuenta'}: el disparador de inicio de sesión no se dispara `
                + 'para quien usa la caja, y una petición manual queda en "nunca se ejecutó"');
        }
    }

    if (info.comando) {
        // La acción apunta a algo que ya no está: antivirus que puso el .exe en
        // cuarentena, carpeta movida, EMV reinstalado en otra ruta.
        try {
            if (!fs.existsSync(info.comando)) {
                anota(true, `la acción de la tarea apunta a "${info.comando}", que no existe en esta máquina`);
            }
        } catch { /* una ruta rara no es motivo para dejar de diagnosticar el resto */ }
    } else {
        anota(true, 'la tarea no tiene una acción de tipo "ejecutar programa"');
    }

    // El último resultado es la prueba de primera mano: no es lo que creemos que va a
    // pasar, es lo que YA pasó la última vez que alguien la disparó. Pero SÓLO vale si
    // llegó a haber una última vez — ver `nuncaEjecutada`.
    if (!info.nuncaEjecutada) {
        if (info.ultimoResultado === 267011 || info.ultimoResultado === 2147943645) {
            // Se le pidió y no llegó a correr. En una tarea con disparador de inicio de
            // sesión eso apunta al usuario registrado sin sesión; en una de sólo demanda,
            // a los permisos. No bloquea: la prueba de verdad es si aparece el proceso al
            // dispararla, y eso lo comprueba el daemon en el acto.
            anota(false, 'la última vez que se le pidió correr no llegó a ejecutarse '
                + `(${info.ultimoResultado === 267011 ? '0x41303' : '0x8007041D'})`
                + (info.tieneDisparadorLogon ? ': suele ser el usuario registrado sin sesión iniciada' : ''));
        }
        if (info.ultimoResultado === 2 || info.ultimoResultado === 2147942401) {
            anota(true, 'la última vez no encontró el ejecutable de la acción');
        }
        if (info.ultimoResultado === 2147942405) {
            anota(true, 'la última vez el Programador no pudo ejecutarla: acceso denegado');
        }
    }

    return { problemas, bloqueantes };
}

// ── Requisitos de la caja ────────────────────────────────────────────────────────

/**
 * ¿Está esta caja en condiciones de rescatarse sola?
 *
 * Contesta con una lista de requisitos, cada uno con `ok` y con `reparable`: lo que el
 * botón del asistente puede arreglar y lo que no. Un requisito que no se puede
 * reparar desde aquí (no existe el .exe del EMV) se dice tal cual, con lo que hay que
 * hacer, en vez de ofrecer un botón que no va a servir.
 */
async function requirements(spec) {
    const s = spec || {};
    const emvTask = String(s.emvTask || 'NestorSantanderEMV');
    const printerTask = String(s.printerRescueTask || 'NestorPrinterRescue');
    const printerService = String(s.printerService || '');
    const emvExe = String(s.emvExePath || '') || EMV_EXE_DEFAULT;
    const vigilaEmv = s.vigilaEmv !== false;

    const out = {
        ok: true,
        esWindows: IS_WIN,
        usuario: usuarioActual(),
        administrador: false,
        emvExe,
        emvExeExiste: false,
        requisitos: []
    };

    if (!IS_WIN) {
        out.nota = `En ${process.platform} no hay tareas programadas ni servicios de Windows: `
            + 'el daemon corre en observación y no hay nada que instalar.';
        return out;
    }

    out.administrador = await esAdministrador();
    try { out.emvExeExiste = fs.existsSync(emvExe); } catch { out.emvExeExiste = false; }

    const [emv, printer] = await Promise.all([
        taskInfo(emvTask, { usuarioEsperado: out.usuario, procesoLargo: true }),
        taskInfo(printerTask, { procesoLargo: false })
    ]);
    out.emv = emv;
    out.printer = printer;

    // ── Terminal EMV ────────────────────────────────────────────────────────────
    if (vigilaEmv) {
        if (!out.emvExeExiste) {
            out.requisitos.push({
                clave: 'emv_exe',
                titulo: 'El ejecutable de la terminal EMV',
                ok: false,
                reparable: false,
                detalle: `No está en ${emvExe}. Sin el ejecutable no hay nada que lanzar: `
                    + 'hay que reinstalar el componente «Cobro con Terminal EMV Santander», '
                    + 'o apuntar la ruta correcta en este mismo paso si el componente está en otra carpeta.'
            });
        } else {
            out.requisitos.push({
                clave: 'emv_exe',
                titulo: 'El ejecutable de la terminal EMV',
                ok: true,
                reparable: false,
                detalle: emvExe
            });
        }

        const emvOk = emv.existe && !emv.problemas.length;
        out.requisitos.push({
            clave: 'emv_task',
            titulo: `Tarea programada «${emvTask}»`,
            ok: emvOk,
            reparable: out.emvExeExiste,
            detalle: !emv.existe
                ? 'No existe en esta caja. Es la vía principal de rescate de la terminal: sin ella, cuando el '
                  + 'microservicio se cae, alguien tiene que ir a la caja a levantarlo.'
                : (emv.problemas.length
                    ? emv.problemas.join(' · ')
                    : `A nombre de ${emv.usuario || '(sin usuario)'}${emv.elevada ? ', elevada' : ''}. `
                      + (emv.nuncaEjecutada ? 'Todavía no se ha disparado.' : emv.ultimoResultadoTexto))
        });
    }

    // ── Servicio de impresión ───────────────────────────────────────────────────
    // La «tarea de respaldo» del paso 2 del asistente. Hasta hoy su valor de fábrica
    // apuntaba a una tarea que el instalador NUNCA registró, así que el tercer escalón
    // del rescate del printer no existía y el campo no significaba nada.
    const printerOk = printer.existe && !printer.problemas.length;
    out.requisitos.push({
        clave: 'printer_task',
        titulo: `Tarea de respaldo «${printerTask}»`,
        ok: printerOk,
        reparable: !!printerService,
        detalle: !printer.existe
            ? 'No existe en esta caja. Es el último escalón del rescate de la impresión: corre como SYSTEM y '
              + 'arranca el servicio cuando el usuario de la caja no tiene permiso para hacerlo por su cuenta.'
            : (printer.problemas.length
                ? printer.problemas.join(' · ')
                : `Arranca ${printer.comando} ${printer.argumentos}`.trim())
    });

    if (printerService) {
        const permiso = await puedeControlarServicio(printerService);
        out.requisitos.push({
            clave: 'printer_acl',
            titulo: `Permiso para arrancar «${printerService}»`,
            ok: permiso.ok,
            reparable: true,
            detalle: permiso.ok
                ? 'El usuario de esta caja puede arrancar y parar el servicio sin elevar: el rescate normal funciona.'
                : `${permiso.detalle} Con la tarea de respaldo instalada el rescate igual funciona, `
                  + 'pero dando el permiso se resuelve en el primer escalón y sin pasar por el Programador.'
        });
    }

    out.ok = out.requisitos.every((r) => r.ok);
    out.reparables = out.requisitos.filter((r) => !r.ok && r.reparable).map((r) => r.clave);
    return out;
}

/**
 * ¿Puede este usuario arrancar el servicio de impresión sin elevar?
 *
 * `sc query` sirve de sonda barata: devuelve 5 (acceso denegado) cuando ni siquiera se
 * puede consultar. No es la misma pregunta que «puede arrancarlo» —consultar y
 * arrancar son permisos distintos— pero es la que se puede hacer sin efectos
 * secundarios, y el caso real que hay en las cajas (la DACL de fábrica de NSSM) niega
 * las dos a la vez.
 */
async function puedeControlarServicio(nombre) {
    if (!IS_WIN) return { ok: false, detalle: `no aplica en ${process.platform}` };
    const r = await run(sysExe('sc.exe'), ['query', nombre], 8000);
    const salida = `${r.stdout}\n${r.stderr}`;
    if (r.code === 1060 || /FAILED\s+1060/i.test(salida)) {
        return { ok: false, detalle: `el servicio ${nombre} no está registrado en esta máquina.` };
    }
    if (r.code === 5 || /FAILED\s+5\b/i.test(salida)) {
        return { ok: false, detalle: `este usuario no puede ni consultar el servicio ${nombre}.` };
    }
    return { ok: true, detalle: '' };
}

// ── Reparación (elevada) ─────────────────────────────────────────────────────────

/**
 * El script que corre COMO ADMINISTRADOR.
 *
 * Se registran las tareas por la API COM del Programador y no con `schtasks /Create`
 * por dos cosas que schtasks no sabe hacer y que son justamente las que faltaban:
 *
 *   · El descriptor de seguridad (SDDL). Es lo que permite que el cajero, que no es
 *     administrador, pueda DISPARAR la tarea. `schtasks` no tiene opción para esto, y
 *     por eso el instalador nunca lo puso.
 *   · MultipleInstancesPolicy = StopExisting (3). Con el IgnoreNew que deja schtasks,
 *     la tarea del EMV descarta cada relanzamiento mientras el Programador crea que la
 *     instancia anterior sigue viva — y devuelve 0. Es la causa del «Rescatando» eterno.
 *
 * Escribe su resultado en JSON a un archivo, y no por la salida estándar: entre el
 * proceso elevado y nosotros hay un `Start-Process -Verb RunAs` que no reenvía nada.
 */
function scriptElevado() {
    return `
$ErrorActionPreference = 'Stop'
$out = @{ ok = $true; pasos = @(); error = '' }

# Los parametros llegan por ARCHIVO, junto a este script, y no por variables de entorno.
#
# Cruzar la elevacion las pierde: 'Start-Process -Verb RunAs' no crea el proceso hijo,
# se lo pide al servicio AppInfo, y ese arma el entorno desde el perfil del usuario en
# vez de heredar el del proceso que lo pidio. O sea que un $env:NESTOR_FIX_* llegaria
# VACIO aqui — y el fallo seria de los caros: RegisterTaskDefinition con el nombre en
# blanco, despues del aviso de UAC y con el operador delante mirando.
#
# $PSScriptRoot vale porque el lanzador nos invoca con -File: no hay que pasarle ninguna
# ruta mas, ni por linea de comandos ni por entorno.
$Parametros = Join-Path $PSScriptRoot 'parametros.json'
$Resultado  = Join-Path $PSScriptRoot 'resultado.json'
$p = Get-Content -LiteralPath $Parametros -Raw -Encoding UTF8 | ConvertFrom-Json
$EmvTask   = $p.emvTask
$EmvExe    = $p.emvExe
$PrnTask   = $p.prnTask
$PrnSvc    = $p.prnSvc
$Usuario   = $p.usuario
$Sddl      = $p.sddl
$Hacer     = @($p.hacer)

function Paso($clave, $ok, $detalle) {
  $script:out.pasos += (New-Object psobject -Property @{ clave = $clave; ok = $ok; detalle = $detalle })
}

$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$folder = $svc.GetFolder('\\')

# Constantes de la API del Programador. Se escriben aquí porque los nombres simbolicos
# no existen en PowerShell y un numero suelto mas abajo no diria nada.
$TASK_CREATE_OR_UPDATE   = 6
$TASK_LOGON_INTERACTIVE  = 3
$TASK_LOGON_SERVICE      = 5
$TASK_RUNLEVEL_HIGHEST   = 1
$TASK_TRIGGER_LOGON      = 9
$TASK_ACTION_EXEC        = 0
$TASK_INSTANCES_STOP     = 3   # StopExisting: mata la instancia previa y arranca. Ver arriba.

# ── Tarea de la terminal EMV ───────────────────────────────────────────────────
if ($Hacer -contains 'emv_task') {
  try {
    $def = $svc.NewTask(0)
    $def.RegistrationInfo.Description = 'Arranca el microservicio de cobro con terminal Santander (Nestor POS).'
    $def.RegistrationInfo.Author = 'Nestor POS'
    $def.Principal.UserId    = $Usuario
    $def.Principal.LogonType = $TASK_LOGON_INTERACTIVE
    $def.Principal.RunLevel  = $TASK_RUNLEVEL_HIGHEST
    $def.Settings.Enabled                    = $true
    $def.Settings.AllowDemandStart           = $true
    $def.Settings.DisallowStartIfOnBatteries = $false
    $def.Settings.StopIfGoingOnBatteries     = $false
    $def.Settings.ExecutionTimeLimit         = 'PT0S'
    $def.Settings.MultipleInstances          = $TASK_INSTANCES_STOP
    $def.Settings.StartWhenAvailable         = $true
    $t = $def.Triggers.Create($TASK_TRIGGER_LOGON)
    $t.UserId = $Usuario
    $a = $def.Actions.Create($TASK_ACTION_EXEC)
    $a.Path = $EmvExe
    $a.WorkingDirectory = (Split-Path -Parent $EmvExe)
    $folder.RegisterTaskDefinition($EmvTask, $def, $TASK_CREATE_OR_UPDATE, $null, $null, $TASK_LOGON_INTERACTIVE, $Sddl) | Out-Null
    Paso 'emv_task' $true ("registrada a nombre de " + $Usuario + ", elevada, StopExisting")
  } catch {
    $out.ok = $false
    Paso 'emv_task' $false $_.Exception.Message
  }
}

# ── Tarea de respaldo del servicio de impresion ────────────────────────────────
# Corre como SYSTEM y sin disparador: existe solo para que alguien la dispare. Es el
# tercer escalon del rescate del printer, para la caja cuyo usuario no puede hacer
# 'sc start' por su cuenta.
if ($Hacer -contains 'printer_task') {
  try {
    $def = $svc.NewTask(0)
    $def.RegistrationInfo.Description = "Arranca el servicio de impresion $PrnSvc (Nestor POS)."
    $def.RegistrationInfo.Author = 'Nestor POS'
    $def.Principal.UserId    = 'S-1-5-18'
    $def.Principal.LogonType = $TASK_LOGON_SERVICE
    $def.Principal.RunLevel  = $TASK_RUNLEVEL_HIGHEST
    $def.Settings.Enabled                    = $true
    $def.Settings.AllowDemandStart           = $true
    $def.Settings.DisallowStartIfOnBatteries = $false
    $def.Settings.StopIfGoingOnBatteries     = $false
    $def.Settings.ExecutionTimeLimit         = 'PT2M'
    $def.Settings.MultipleInstances          = $TASK_INSTANCES_STOP
    $a = $def.Actions.Create($TASK_ACTION_EXEC)
    $a.Path = (Join-Path $env:SystemRoot 'System32\\sc.exe')
    $a.Arguments = "start $PrnSvc"
    $folder.RegisterTaskDefinition($PrnTask, $def, $TASK_CREATE_OR_UPDATE, 'S-1-5-18', $null, $TASK_LOGON_SERVICE, $Sddl) | Out-Null
    Paso 'printer_task' $true ("registrada como SYSTEM, arranca " + $PrnSvc)
  } catch {
    $out.ok = $false
    Paso 'printer_task' $false $_.Exception.Message
  }
}

# ── Permiso de control del servicio para los usuarios de la caja ───────────────
# Se LEE el SDDL vigente y se le AGREGA un ACE. Escribirlo desde cero dejaria al SCM
# sin sus propios permisos, y eso es un servicio que ya no se puede ni administrar.
if ($Hacer -contains 'printer_acl') {
  try {
    $sc = Join-Path $env:SystemRoot 'System32\\sc.exe'
    $actual = (& $sc sdshow $PrnSvc) -join ''
    if ($actual -notmatch 'D:') { throw "sc sdshow no devolvio un descriptor: $actual" }
    # RP=arrancar, WP=parar, DT=pausar, LC/CC/LO/CR=consultar. IU = usuarios interactivos.
    $ace = '(A;;CCLCSWRPWPDTLOCRRC;;;IU)'
    if ($actual -like "*$ace*") {
      Paso 'printer_acl' $true 'el permiso ya estaba concedido'
    } else {
      $dacl, $sacl = $actual -split '(?=S:)', 2
      $nuevo = ($dacl.TrimEnd() + $ace + $sacl)
      $r = (& $sc sdset $PrnSvc $nuevo) -join ' '
      if ($LASTEXITCODE -ne 0) { throw "sc sdset fallo ($LASTEXITCODE): $r" }
      Paso 'printer_acl' $true 'concedido a los usuarios interactivos'
    }
  } catch {
    $out.ok = $false
    Paso 'printer_acl' $false $_.Exception.Message
  }
}

$out | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $Resultado -Encoding UTF8
if ($out.ok) { exit 0 } else { exit 2 }
`;
}

/**
 * Instala/repara lo que falte. ABRE UN AVISO DE UAC: sólo se llama desde el botón del
 * asistente, nunca desde el daemon.
 *
 * `que` es la lista de claves de requisito a reparar ('emv_task', 'printer_task',
 * 'printer_acl'). Se pide explícita en vez de deducirla aquí para que lo que se ejecuta
 * elevado sea exactamente lo que el operador vio en pantalla y aceptó.
 */
async function installMissing(spec) {
    const s = spec || {};
    if (!IS_WIN) return { ok: false, error: `no aplica en ${process.platform}` };

    const que = (Array.isArray(s.que) ? s.que : [])
        .filter((k) => ['emv_task', 'printer_task', 'printer_acl'].includes(k));
    if (!que.length) return { ok: false, error: 'no se pidió instalar nada' };

    const emvTask = String(s.emvTask || 'NestorSantanderEMV');
    const printerTask = String(s.printerRescueTask || 'NestorPrinterRescue');
    const printerService = String(s.printerService || '');
    const emvExe = String(s.emvExePath || '') || EMV_EXE_DEFAULT;
    const usuario = usuarioActual();

    if (!NOMBRE_TAREA_OK.test(emvTask)) return { ok: false, error: `nombre de tarea inválido: ${emvTask}` };
    if (!NOMBRE_TAREA_OK.test(printerTask)) return { ok: false, error: `nombre de tarea inválido: ${printerTask}` };
    if (que.includes('emv_task')) {
        if (!usuario) return { ok: false, error: 'no se pudo determinar el usuario de esta sesión' };
        if (!fs.existsSync(emvExe)) {
            return { ok: false, error: `no existe ${emvExe}: registrar la tarea apuntando a un ejecutable que no está sólo cambiaría un fallo por otro` };
        }
    }
    if ((que.includes('printer_task') || que.includes('printer_acl')) && !printerService) {
        return { ok: false, error: 'no se sabe qué servicio de impresión arrancar en esta caja' };
    }

    // Directorio temporal del PROPIO usuario. ProgramData lo puede escribir cualquiera
    // de la máquina, y dejar ahí un script que va a correr elevado es regalar una
    // escalada de privilegios.
    let tmp = '';
    try {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-fix-'));
    } catch (e) {
        return { ok: false, error: `no se pudo crear el directorio temporal: ${e && e.message ? e.message : e}` };
    }

    const scriptPath = path.join(tmp, 'reparar.ps1');
    const paramPath = path.join(tmp, 'parametros.json');
    const resultPath = path.join(tmp, 'resultado.json');

    try {
        // BOM: PowerShell 5.1 lee un .ps1 sin BOM como ANSI, y ahí los acentos de los
        // mensajes se convierten en basura justo en el texto que va a leer el operador.
        fs.writeFileSync(scriptPath, '﻿' + scriptElevado(), 'utf8');

        // Los parámetros van por ARCHIVO, junto al script, y no por variables de entorno.
        //
        // Cruzar la elevación las pierde: `Start-Process -Verb RunAs` no crea el proceso
        // hijo, se lo pide al servicio AppInfo, y ése arma el entorno desde el perfil del
        // usuario en vez de heredar el del proceso que lo pidió. Un $env:NESTOR_FIX_*
        // llegaría VACÍO al otro lado — y el fallo sería de los caros: la tarea se
        // registraría con el nombre en blanco, después del aviso de UAC y con el operador
        // delante. El script lo lee de su propio directorio ($PSScriptRoot), así que no
        // hace falta pasarle ninguna ruta más.
        //
        // Tampoco por línea de comandos: el nombre de la tarea sale de un archivo de
        // configuración editable a mano, y una línea de comandos la lee cualquiera que
        // mire la lista de procesos.
        fs.writeFileSync(paramPath, JSON.stringify({
            emvTask,
            emvExe,
            prnTask: printerTask,
            prnSvc: printerService,
            usuario,
            sddl: SDDL_TAREA,
            hacer: que
        }), 'utf8');

        // `Start-Process -ArgumentList` NO entrecomilla solo lo que le pasas, y la ruta
        // del temporal lleva dentro el nombre del usuario: en una caja cuya cuenta se
        // llama "Punto de Venta" el argumento se partiría en tres y el script elevado no
        // arrancaría. Las comillas se ponen a mano.
        //
        // Este lanzador sí es un hijo normal (no elevado) de este proceso, así que aquí
        // el entorno se hereda con normalidad.
        const lanzador = [
            '$ErrorActionPreference = "Stop";',
            "$ruta = '\"' + $env:NESTOR_FIX_SCRIPT + '\"';",
            'try {',
            "$p = Start-Process -FilePath $env:NESTOR_FIX_PS -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$ruta -Verb RunAs -WindowStyle Hidden -Wait -PassThru;",
            'exit $p.ExitCode',
            '} catch { exit 1223 }'
        ].join(' ');

        const r = await run(psExe(), [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lanzador
        ], 180000, { NESTOR_FIX_PS: psExe(), NESTOR_FIX_SCRIPT: scriptPath });

        // 1223 = ERROR_CANCELLED. Es lo que sale cuando alguien dice «No» al UAC, y no
        // es un fallo: es una decisión. Decirlo como error asustaría de más.
        if (r.code === 1223) {
            return { ok: false, cancelado: true, error: 'se canceló el aviso de Windows: no se cambió nada.' };
        }

        let datos = null;
        try {
            // `Set-Content -Encoding UTF8` de PowerShell 5.1 escribe SIEMPRE con BOM, y
            // JSON.parse con un BOM delante LANZA. Sin este replace, una reparación que
            // salió perfecta se reportaba como «no dejó resultado» — el peor de los dos
            // errores posibles, porque invita a volver a pulsar el botón.
            datos = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^﻿/, ''));
        } catch { }

        if (!datos) {
            return {
                ok: false,
                error: `la reparación no dejó resultado (código ${r.code}). `
                    + `${(r.stderr || r.error || '').trim().slice(0, 200)}`.trim()
            };
        }

        // Un solo paso puede llegar como objeto en vez de arreglo de uno: ConvertTo-Json
        // de PowerShell 5.1 desenvuelve arreglos de un elemento en algunos contextos, y
        // ahí el paso se perdería sin decir nada.
        const pasos = Array.isArray(datos.pasos) ? datos.pasos : (datos.pasos ? [datos.pasos] : []);

        return {
            ok: !!datos.ok,
            pasos,
            error: datos.ok ? '' : 'alguno de los pasos falló; el detalle está abajo'
        };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
    }
}

module.exports = {
    IS_WIN,
    EMV_EXE_DEFAULT,
    SDDL_TAREA,
    NOMBRE_TAREA_OK,
    textoResultado,
    usuarioActual,
    esAdministrador,
    // Exportado para poder pasarle el analizador de PowerShell sin ejecutarlo. Un error
    // de sintaxis aquí sólo se vería como "la reparación no dejó resultado", después del
    // aviso de UAC y con el operador delante.
    scriptElevado,
    taskInfo,
    problemasDe,
    requirements,
    puedeControlarServicio,
    installMissing
};
