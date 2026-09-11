// Revisa el diagnóstico de tareas programadas (src/services.tasks.js).
//
// Por qué existe: este módulo es el que decide si una tarea programada VA A ARRANCAR
// algo. Esa decisión es la diferencia entre rescatar la terminal y dejar la caja en
// «Restableciendo…» para siempre, y sus dos formas de romperse son silenciosas:
//
//   1. Un problema que se cuenta como BLOQUEANTE sin serlo. La tarea deja de
//      intentarse, el rescate cae al escalón siguiente (o a ninguno) y una caja que se
//      arreglaba sola pasa a "requiere atención" sin motivo.
//   2. Un problema que NO se cuenta y sí lo era. Se dispara una tarea que nunca va a
//      arrancar nada, `schtasks /Run` devuelve 0, el daemon se cree el 0 y vuelve el
//      atasco original — que es exactamente el fallo que este módulo vino a arreglar.
//
// `problemasDe` es pura: recibe la definición de una tarea ya leída y devuelve el
// diagnóstico. Así que se puede comprobar entera sin Windows y sin tocar el Programador.
//
//   node scripts/check-services-tasks.js     (o: npm run check)

const path = require('path');
const tasks = require('../src/services.tasks');

const fallas = [];

// Una tarea sana: existe, habilitada, a nombre de quien usa la caja, apuntando a un
// ejecutable que SÍ está (se usa este mismo script, que obviamente existe) y con la
// política que permite relanzar.
const YO = path.join(__dirname, 'check-services-tasks.js');
const USUARIO = 'CAJA1\\cajera';

function tarea(extra) {
    return Object.assign({
        nombre: 'NestorSantanderEMV',
        existe: true,
        habilitada: true,
        usuario: USUARIO,
        logonType: 'InteractiveToken',
        runLevel: 'HighestAvailable',
        elevada: true,
        comando: YO,
        argumentos: '',
        multipleInstances: 'StopExisting',
        tieneDisparadorLogon: true,
        ultimoResultado: 0,
        ultimoResultadoTexto: '',
        ultimaEjecucion: '2026-09-03T10:00:00',
        nuncaEjecutada: false,
        estado: 'Ready'
    }, extra || {});
}

const OPTS = { usuarioEsperado: USUARIO, procesoLargo: true };

// [qué se cambia, ¿debe salir en problemas?, ¿debe BLOQUEAR?, qué es]
const CASOS = [
    [{}, false, false, 'una tarea sana'],

    // ── Bloqueantes: intentar dispararlas sólo gasta el rato que la caja pasa sin cobrar
    [{ habilitada: false }, true, true, 'la tarea deshabilitada'],
    [{ comando: 'C:\\NestorMX\\SantanderEMV\\no-existe.exe' }, true, true,
        'la acción apuntando a un .exe que ya no está (antivirus, carpeta movida)'],
    [{ comando: '' }, true, true, 'una tarea sin acción de tipo "ejecutar programa"'],
    [{ usuario: 'CAJA1\\admin' }, true, true,
        'la tarea a nombre de quien instaló y no de quien usa la caja (schtasks /Create sin /RU)'],
    [{ ultimoResultado: 2 }, true, true, 'último resultado 0x2: no encontró el ejecutable'],
    [{ ultimoResultado: 2147942405 }, true, true, 'último resultado 0x80070005: acceso denegado'],

    // ── Problema, pero NO bloqueante ────────────────────────────────────────────
    // IgnoreNew a veces arranca y a veces no, según si el Programador ya reaparejó la
    // instancia anterior. Contarlo como bloqueante dejaría sin intentar la única vía que
    // tienen hoy las cajas instaladas — que es peor que intentarlo y comprobarlo.
    [{ multipleInstances: 'IgnoreNew' }, true, false,
        'la política IgnoreNew que deja schtasks /Create por omisión'],
    // Se le pidió correr y no llegó a ejecutarse. Vale como aviso, pero NO bloquea: la
    // prueba de verdad es si aparece el proceso al dispararla, y eso el daemon lo
    // comprueba en el acto. Bloquear aquí apagaría la vía principal de rescate en una
    // caja donde la tarea sólo tardaba en arrancar — que es lo que pasó en una real.
    [{ ultimoResultado: 267011 }, true, false, 'se le pidió correr y no llegó a ejecutarse (0x41303)'],
    [{ ultimoResultado: 2147943645 }, true, false, 'se le pidió correr y el usuario no tenía sesión (0x8007041D)'],

    // ── Lo que NO debe contar como problema ─────────────────────────────────────
    [{ usuario: 'SYSTEM' }, false, false, 'una tarea que corre como SYSTEM (la de respaldo del printer)'],
    [{ ultimoResultado: 267009 }, false, false, 'último resultado 0x41301: se está ejecutando ahora mismo'],
    [{ ultimoResultado: 0 }, false, false, 'último resultado 0: la última vez arrancó bien'],
    [{ usuario: 'cajera' }, false, false, 'el usuario escrito sin dominio (es el mismo)'],

    // ── El caso que rompió una caja de verdad ───────────────────────────────────
    // Una tarea RECIÉN CREADA y nunca disparada trae último resultado 0x41303 y fecha
    // centinela — los mismos valores que una que sí se pidió y no llegó a correr. Al
    // contarlo como problema, el paso «Requisitos» instalaba la tarea de respaldo
    // correctamente y seguía diciendo que faltaba: el operador volvía a pulsar el botón,
    // aceptaba otro UAC y no cambiaba nada. Hay que distinguirlos por la fecha.
    [{ ultimoResultado: 267011, nuncaEjecutada: true, ultimaEjecucion: '', tieneDisparadorLogon: false },
        false, false, 'una tarea recién creada que todavía no se ha disparado nunca']
];

for (const [extra, hayProblema, bloquea, que] of CASOS) {
    const d = tasks.problemasDe(tarea(extra), OPTS);
    const tuvo = d.problemas.length > 0;
    const bloqueo = d.bloqueantes.length > 0;

    if (tuvo !== hayProblema) {
        fallas.push(hayProblema
            ? `${que}: NO se detecta como problema; el daemon dispararía una tarea que no arranca nada y se creería el 0 de schtasks`
            : `${que}: se marca como problema sin serlo; el asistente pediría "reparar" una tarea que está bien`);
    }
    if (bloqueo !== bloquea) {
        fallas.push(bloquea
            ? `${que}: no se cuenta como BLOQUEANTE; se gastaría un intento de rescate contra una tarea que no puede arrancar`
            : `${que}: se cuenta como BLOQUEANTE y no lo es; la tarea dejaría de intentarse y la caja perdería su única vía de rescate`);
    }
}

// ── El IgnoreNew sólo importa si la acción es un proceso LARGO ──────────────────
// La tarea de respaldo del printer hace `sc start` y termina en un segundo: ahí
// IgnoreNew no molesta a nadie, y avisarlo sería ruido en la pantalla de requisitos.
{
    const d = tasks.problemasDe(tarea({ multipleInstances: 'IgnoreNew', usuario: 'SYSTEM' }), { procesoLargo: false });
    if (d.problemas.length) {
        fallas.push('IgnoreNew se avisa en una tarea de proceso corto (la de respaldo del printer): es ruido');
    }
}

// ── Los códigos que se traducen a algo legible ─────────────────────────────────
// El operador de una caja no busca "0x41303" en internet: lee lo que pone la pantalla.
for (const [codigo, debeDecir] of [[267011, /nunca/i], [2, /ejecutable/i], [0, /bien/i]]) {
    const t = tasks.textoResultado(codigo);
    if (!debeDecir.test(t)) {
        fallas.push(`el último resultado ${codigo} se traduce como "${t}", que no explica nada`);
    }
}
// Uno desconocido tiene que salir en hexadecimal, que es como lo enseña el Programador
// de tareas y como se puede buscar.
if (!/0x[0-9A-F]+/.test(tasks.textoResultado(3221225477))) {
    fallas.push('un último resultado desconocido no se enseña en hexadecimal: no hay por dónde buscarlo');
}

// ── El nombre de tarea que se acepta ───────────────────────────────────────────
// Sale de config.json, que es un archivo de texto editable a mano, y acaba dentro de un
// `powershell -Command`. Los datos viajan por variable de entorno, pero el filtro es la
// segunda barrera y la que se puede comprobar aquí.
const NOMBRES = [
    ['NestorSantanderEMV', true, 'el nuestro'],
    ['NestorPrinterRescue', true, 'el de respaldo'],
    ['Microsoft\\Windows\\Defrag\\ScheduledDefrag', true, 'uno con carpetas'],
    ['Tarea De La Caja', true, 'uno con espacios'],
    ['x"; Remove-Item C:\\ -Recurse', false, 'una inyección de PowerShell'],
    ['x$(whoami)', false, 'una interpolación de PowerShell'],
    ['x`nwhoami', false, 'un salto de línea escapado'],
    ['', false, 'vacío']
];
for (const [nombre, esperado, que] of NOMBRES) {
    if (tasks.NOMBRE_TAREA_OK.test(nombre) !== esperado) {
        fallas.push(esperado
            ? `el nombre de tarea de ${que} se rechaza y es legítimo: no se podría configurar`
            : `el nombre de tarea de ${que} se acepta: acabaría dentro de un powershell -Command`);
    }
}

// ── El descriptor de seguridad tiene que conceder EJECUCIÓN ────────────────────
// Sin el FX para usuarios autenticados, el cajero —que no es administrador— recibe
// "Acceso denegado" al disparar la tarea, y el rescate del EMV queda muerto justo en la
// caja donde hace falta. Es la mitad de por qué esto no funcionaba.
if (!/\(A;;FRFX;;;AU\)/.test(tasks.SDDL_TAREA)) {
    fallas.push('el SDDL de las tareas no concede ejecución a los usuarios autenticados: '
        + 'un cajero sin permisos de administrador no podría disparar el rescate');
}

// ── El script que corre elevado tiene que compilar ─────────────────────────────
//
// Es PowerShell dentro de un template literal de JavaScript: `node --check` lo da por
// bueno pase lo que pase dentro de las comillas. Un error de sintaxis ahí sólo se vería
// como «la reparación no dejó resultado», DESPUÉS del aviso de UAC, con el operador
// delante y sin más pista. Así que se le pasa el analizador de PowerShell — que no lo
// ejecuta, sólo lo lee.
//
// Y se comprueba que NO lea ninguna variable de entorno propia. Esto es una trampa que
// ya se pisó una vez: `Start-Process -Verb RunAs` no crea el proceso hijo, se lo pide al
// servicio AppInfo, y ése arma el entorno desde el perfil del usuario en vez de heredar
// el del proceso que lo pidió. O sea que cruzar la elevación PIERDE las variables: un
// $env:NESTOR_FIX_* llegaría vacío y la tarea se registraría con el nombre en blanco,
// después del aviso de UAC y con el operador delante. Los parámetros van por archivo,
// junto al script ($PSScriptRoot).
let extra = '';
if (process.platform === 'win32') {
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');

    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const tmp = path.join(os.tmpdir(), `nestor-elevado-check-${process.pid}.ps1`);
    try {
        fs.writeFileSync(tmp, '\uFEFF' + tasks.scriptElevado(), 'utf8');
        const salida = execFileSync(ps, [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            '$e = $null; $t = $null;'
            + ' $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:NESTOR_CHECK_PS1, [ref]$t, [ref]$e);'
            + ' if ($e.Count) { $e | ForEach-Object { "ERROR " + $_.Extent.StartLineNumber + ": " + $_.Message } }'
            + ' else { $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)'
            + ' | ForEach-Object { $_.VariablePath.UserPath } | Where-Object { $_ -like "env:*" } | Sort-Object -Unique'
            + ' | ForEach-Object { "VAR " + $_ } }'
        ], { encoding: 'utf8', env: { ...process.env, NESTOR_CHECK_PS1: tmp }, windowsHide: true });

        const renglones = salida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const errores = renglones.filter((l) => l.startsWith('ERROR '));
        for (const e of errores) fallas.push(`el script elevado no compila — ${e.slice(6)}`);

        // Sólo las que pone Windows en cualquier proceso. Cualquier otra cruzaría la
        // elevación y llegaría vacía.
        const PERMITIDAS = ['env:SystemRoot', 'env:windir', 'env:ProgramFiles', 'env:ProgramData'];
        const usadas = renglones.filter((l) => l.startsWith('VAR ')).map((l) => l.slice(4));
        for (const v of usadas) {
            if (!PERMITIDAS.includes(v)) {
                fallas.push(`el script elevado lee ${v}: al cruzar la elevación llegaría VACÍA `
                    + '(Start-Process -Verb RunAs no hereda el entorno). Los parámetros van por archivo, '
                    + 'junto al script, y se leen de $PSScriptRoot');
            }
        }
        // Y tiene que seguir leyéndolos de su propio directorio.
        if (!/\$PSScriptRoot/.test(tasks.scriptElevado())) {
            fallas.push('el script elevado ya no lee sus parámetros de $PSScriptRoot: '
                + 'si vuelven a viajar por entorno o por línea de comandos, llegarán vacíos o quedarán a la vista');
        }
        if (!errores.length) extra = `, script elevado (${usadas.length} variables)`;
    } catch (e) {
        // Sin PowerShell no se puede comprobar, y eso no es motivo para fallar el check:
        // el resto de este archivo sigue valiendo.
        extra = ', script elevado sin comprobar (no se pudo analizar)';
    } finally {
        try { fs.unlinkSync(tmp); } catch { }
    }
}

if (fallas.length) {
    console.error('tareas programadas: FALLAS');
    for (const f of fallas) console.error('  - ' + f);
    process.exit(1);
}
console.log(`tareas programadas: ok (${CASOS.length} diagnósticos, códigos, nombres y descriptor${extra})`);
