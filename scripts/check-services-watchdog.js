// Revisa la compuerta de tráfico del daemon de servicios (src/services.watchdog.js).
//
// Por qué existe: el daemon no rescata un servicio que se está usando, y decide "se
// está usando" a partir de las peticiones que ve pasar hacia sus puertos. El
// indicador de la barra de estado del POS sondea /api/health del EMV CADA 3 SEGUNDOS.
// Si esos latidos contaran como uso, la compuerta jamás se abriría y el daemon no
// podría rescatar nada NUNCA — y lo peor es que se vería igual que si funcionara:
// sondeando, reportando estado, sin un solo error en la bitácora.
//
// Ese fallo no lo detecta ningún `node --check`, así que se comprueba aquí: latidos
// fuera, trabajo dentro.
//
//   node scripts/check-services-watchdog.js     (o: npm run check)

// El daemon no debe arrancar sus rondas ni escribir bitácora sólo por importarlo.
process.env.NESTOR_SERVICES = process.env.NESTOR_SERVICES || '1';

const svc = require('../src/services.watchdog');

const fallas = [];

// [url, servicio, ¿cuenta como trabajo?, qué es]
const CASOS = [
    ['http://127.0.0.1:5000/api/health', 'emv', false, 'latido del EMV (el indicador lo pide cada 3 s)'],
    ['http://127.0.0.1:8331/api/v1/health', 'printer', false, 'latido del printer'],
    ['http://127.0.0.1:8331/api/v1', 'printer', false, 'la "cara" del printer (calcula el HWID)'],
    ['http://127.0.0.1:8331/api/v1/', 'printer', false, 'la "cara" del printer, con barra final'],
    ['http://localhost:5000/api/health', 'emv', false, 'latido del EMV por localhost'],

    ['http://127.0.0.1:5000/api/emv/venta', 'emv', true, 'cobro con tarjeta'],
    ['http://127.0.0.1:5000/api/emv/consulta', 'emv', true, 'consulta de transacciones'],
    ['http://127.0.0.1:5000/api/session/handshake', 'emv', true, 'handshake del canal cifrado'],
    ['http://127.0.0.1:8331/api/v1/print', 'printer', true, 'impresión de PDF'],
    ['http://127.0.0.1:8331/api/v1/print-raw', 'printer', true, 'impresión ESC/POS'],
    ['http://127.0.0.1:8331/api/v1/print-ticket', 'printer', true, 'impresión del ticket'],
    ['http://127.0.0.1:8331/api/v1/fingerprint/capture', 'printer', true, 'captura de huella'],
    ['http://127.0.0.1:8331/api/v1/weight', 'printer', true, 'lectura de la báscula'],
];

function traffic(id) {
    const s = svc.status().services.find((x) => x.id === id);
    return s ? s.lastTrafficAt : -1;
}

function enVuelo(id) {
    const s = svc.status().services.find((x) => x.id === id);
    return s ? s.enVuelo : -1;
}

let seq = 0;
/** Una petición completa de la ventana: sale y termina. */
function peticion(url, ok, error) {
    const rid = ++seq;
    svc.noteTraffic(url, rid);
    svc.noteTrafficDone(url, rid, ok, error === undefined ? (ok ? '' : 'net::ERR_CONNECTION_REFUSED') : error);
}

// Dos noteTraffic en el mismo milisegundo son indistinguibles: se separan las medidas.
function esperarOtroMs() {
    const t = Date.now();
    while (Date.now() === t) { /* < 1 ms */ }
}

for (const [url, id, deberiaContar, que] of CASOS) {
    const antes = traffic(id);
    if (antes < 0) {
        fallas.push(`el daemon no expone el servicio "${id}"`);
        continue;
    }
    esperarOtroMs();
    peticion(url, true);
    const conto = traffic(id) !== antes;
    if (conto !== deberiaContar) {
        fallas.push(deberiaContar
            ? `${que} NO cuenta como uso (${url}); el daemon podría reiniciar el servicio a media operación`
            : `${que} SÍ cuenta como uso (${url}); la compuerta nunca se abriría y el rescate quedaría muerto`);
    }
}

// ── Una petición que FALLA no es uso ────────────────────────────────────────────
//
// Aquí estaba el fallo que hacía que el rescate llegara tardísimo o nunca: el uso se
// anotaba al SALIR la petición, sin mirar cómo terminaba. Con el servicio caído, cada
// intento del cajero contaba como "se está usando" y empujaba la espera otros 90 s —
// de modo que cuanto más intentaba imprimir, más se retrasaba el arreglo. Justo al
// revés de lo que hace falta.
{
    const antes = traffic('printer');
    esperarOtroMs();
    peticion('http://127.0.0.1:8331/api/v1/print', false);
    if (traffic('printer') !== antes) {
        fallas.push('una impresión que NO llegó al servicio cuenta como uso: cada reintento del cajero retrasaría el rescate');
    }
}

// ── Una petición en curso sí protege, y se suelta al terminar ───────────────────
// Es lo que impide reiniciar el servicio a media impresión o a media venta con
// tarjeta, dure lo que dure la operación.
{
    const rid = ++seq;
    svc.noteTraffic('http://127.0.0.1:5000/api/emv/venta', rid);
    if (enVuelo('emv') < 1) {
        fallas.push('una venta con tarjeta en curso no queda registrada como trabajo en vuelo: el daemon podría matar el cobro');
    }
    svc.noteTrafficDone('http://127.0.0.1:5000/api/emv/venta', rid, true);
    if (enVuelo('emv') !== 0) {
        fallas.push('la venta terminó y sigue contando como en vuelo: el servicio quedaría blindado y no se rescataría nunca');
    }
}

// Un latido no es ni uso ni trabajo en vuelo. El indicador del POS pregunta cada 3 s:
// si contara, la compuerta no se abriría jamás.
{
    const rid = ++seq;
    const antes = traffic('emv');
    svc.noteTraffic('http://127.0.0.1:5000/api/health', rid);
    if (enVuelo('emv') !== 0) fallas.push('un latido cuenta como trabajo en vuelo: el rescate quedaría bloqueado para siempre');
    svc.noteTrafficDone('http://127.0.0.1:5000/api/health', rid, true);
    if (traffic('emv') !== antes) fallas.push('un latido cuenta como uso: la compuerta de silencio no se abriría nunca');
}

// El vocabulario de `state` lo pinta el frontend (services/client.services.js →
// stateLabel). Un estado nuevo sin etiqueta sale como texto vacío en la barra.
const ESTADOS = ['desconocido', 'ok', 'sospechoso', 'rescatando', 'caido', 'rendido'];
for (const s of svc.status().services) {
    if (!ESTADOS.includes(s.state)) {
        fallas.push(`el servicio "${s.id}" arranca con un estado fuera del vocabulario: "${s.state}"`);
    }
}

// El printer se vigila desde el arranque; el EMV NO, hasta que el POS diga que esta
// caja tiene terminal. Al revés, una caja sin terminal intentaría lanzar el EMV sola.
const printer = svc.status().services.find((s) => s.id === 'printer');
const emv = svc.status().services.find((s) => s.id === 'emv');
if (printer && printer.supervised !== true) fallas.push('el servicio de impresión debería vigilarse desde el arranque');
if (emv && emv.supervised !== false) fallas.push('la terminal EMV NO debe vigilarse hasta que el POS lo pida (ensure)');

// ── La compuerta sigue viendo el tráfico con puertos configurados ───────────────
// Los puertos se pueden cambiar desde el asistente (una instancia adicional corre su
// printer en otro puerto). Si la clasificación se quedara con ":8331" quemado, en esa
// caja NADA contaría como uso: la compuerta de silencio quedaría abierta para siempre
// y el daemon reiniciaría el servicio a media impresión o a media venta con tarjeta.
// Es el peor fallo posible aquí y no deja rastro en la bitácora.
const os = require('os');
const fsp = require('fs');
const tmp = fsp.mkdtempSync(require('path').join(os.tmpdir(), 'nestor-svc-check-'));
process.env.NESTOR_SERVICES_DIR = tmp;

try {
    svc.init(tmp, {});
    const r = svc.configure({ printer_port: 9911, emv_port: 5911 });
    if (!r.ok) {
        fallas.push(`no se pudo guardar la configuración de prueba: ${r.error}`);
    } else {
        const CASOS_PUERTO = [
            ['http://127.0.0.1:9911/api/v1/print', 'printer', true, 'impresión en el puerto configurado'],
            ['http://127.0.0.1:5911/api/emv/venta', 'emv', true, 'cobro en el puerto configurado'],
            ['http://127.0.0.1:9911/api/v1/health', 'printer', false, 'latido en el puerto configurado'],
            ['http://127.0.0.1:8331/api/v1/print', 'printer', false, 'el puerto de fábrica, que esta caja ya no usa']
        ];
        for (const [url, id, deberiaContar, que] of CASOS_PUERTO) {
            const antes = traffic(id);
            esperarOtroMs();
            peticion(url, true);
            const conto = traffic(id) !== antes;
            if (conto !== deberiaContar) {
                fallas.push(deberiaContar
                    ? `con puertos configurados, ${que} NO cuenta como uso (${url}): el daemon podría reiniciar el servicio a media operación`
                    : `con puertos configurados, ${que} SÍ cuenta como uso (${url})`);
            }
        }
    }
} finally {
    svc.resetConfig();
    try { fsp.rmSync(tmp, { recursive: true, force: true }); } catch { }
}

// ── Nunca tocar un servicio que no es nuestro ───────────────────────────────────
//
// Incidente real: el Spooler de Windows se llama «Cola de impresión», y el filtro que
// destacaba "lo que parece nuestro" miraba también el nombre visible. El Spooler subía
// al grupo de arriba del desplegable, alguien lo elegía —dice impresión— y a partir de
// ahí, cada vez que nestor_printer no contestaba en :8331, el rescate le hacía
// `sc stop` + `sc start`. Hasta cinco veces por hora, y cuando el arranque no prendía
// la máquina se quedaba sin imprimir NADA.
//
// Tres barreras, y las tres se comprueban aquí: no se destaca, no se guarda, no se
// reinicia.
const SUGERENCIAS = [
    ['Spooler', 'Cola de impresión', false, 'el Spooler de Windows (el caso del incidente)'],
    ['PrintNotify', 'Extensiones y notificaciones de impresora', false, 'notificaciones de impresora de Windows'],
    ['PrintWorkflowUserSvc', 'Flujo de trabajo de impresión', false, 'flujo de impresión de Windows'],
    ['NestorPrinter', 'Nestor Printer', true, 'el nuestro'],
    ['NestorPrinter_2', '', true, 'el nuestro en una instancia adicional'],
    ['nestorprinter', '', true, 'el nuestro en minúsculas']
];
for (const [name, display, esperado, que] of SUGERENCIAS) {
    if (svc.pareceServicioNuestro(name, display) !== esperado) {
        fallas.push(esperado
            ? `"${name}" (${que}) NO se destaca en el asistente y debería`
            : `"${name}" (${que}) se destaca como si fuera nuestro: es como se acaba reiniciando un servicio del sistema`);
    }
}

const cfgStore = require('../src/services.config');
for (const nombre of ['Spooler', 'spooler', 'SPOOLER']) {
    if (!cfgStore.motivoProhibido('printer_service', nombre)) {
        fallas.push(`"${nombre}" se puede guardar como servicio de impresión: el rescate lo pararía`);
    }
}
if (cfgStore.motivoProhibido('printer_service', 'NestorPrinter')) {
    fallas.push('el servicio de Nestor está siendo rechazado por la lista de protegidos');
}

// ── El estado que se difunde tiene que poder explicar un atasco ────────────────
//
// `state` es un vocabulario cerrado de seis palabras, y con seis palabras no se
// distingue «se está levantando ahora mismo» de «lleva media hora diciendo lo mismo».
// Esas dos se veían idénticas desde la barra del POS —«RESTABLECIENDO…»— y por eso una
// caja atascada parecía una caja trabajando. Los dos campos que las separan viajan en
// el payload; si desaparecen, el síntoma vuelve y no deja rastro.
for (const s of svc.status().services) {
    if (!('settleUntil' in s)) {
        fallas.push(`el servicio "${s.id}" no expone settleUntil: no habría forma de distinguir un arranque en curso de un atasco`);
    }
    if (!('fatal' in s)) {
        fallas.push(`el servicio "${s.id}" no expone fatal: "no se puede rescatar" y "sigue intentándolo" se verían igual`);
    }
}

// ── El último escalón del EMV viene encendido ──────────────────────────────────
//
// La tarea programada es la vía principal, pero en las cajas ya instaladas está mal
// registrada (schtasks /Create sin /RU y sin descriptor de seguridad) y acepta el
// disparo sin arrancar nada. Sin este escalón, esas cajas no tienen NINGUNA vía de
// rescate — que es el estado del que se viene.
if (cfgStore.defaults().emv_direct_launch !== true) {
    fallas.push('el arranque directo del ejecutable del EMV viene apagado de fábrica: '
        + 'una caja con la tarea mal registrada se quedaría sin ninguna vía de rescate');
}

svc.shutdown();

if (fallas.length) {
    console.error('daemon de servicios: FALLAS');
    for (const f of fallas) console.error('  - ' + f);
    process.exit(1);
}
console.log(`daemon de servicios: ok (${CASOS.length} rutas clasificadas, puertos configurados, vocabulario y vigilancia inicial)`);
