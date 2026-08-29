// Revisa la compuerta de tráfico del daemon de servicios (src/services.watchdog.js).
//
// Por qué existe: el daemon no rescata un servicio que se está usando, y decide "se
// está usando" a partir de las peticiones que ve pasar hacia :8331 y :5000. El
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
    svc.noteTraffic(url);
    const conto = traffic(id) !== antes;
    if (conto !== deberiaContar) {
        fallas.push(deberiaContar
            ? `${que} NO cuenta como uso (${url}); el daemon podría reiniciar el servicio a media operación`
            : `${que} SÍ cuenta como uso (${url}); la compuerta nunca se abriría y el rescate quedaría muerto`);
    }
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

svc.shutdown();

if (fallas.length) {
    console.error('daemon de servicios: FALLAS');
    for (const f of fallas) console.error('  - ' + f);
    process.exit(1);
}
console.log(`daemon de servicios: ok (${CASOS.length} rutas clasificadas, vocabulario y vigilancia inicial)`);
