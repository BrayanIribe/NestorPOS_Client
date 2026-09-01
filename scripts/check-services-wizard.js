// Revisa el asistente de servicios de la caja (src/pages/services.wizard.html).
//
// Por qué existe: el asistente es la ÚNICA forma de configurar el daemon sin entrar
// por escritorio remoto a tocar variables de entorno, y sus tres formas de romperse
// son silenciosas:
//
//   1. Un ajuste nuevo en el esquema (services.config.js) sin control en el asistente:
//      el campo no se puede editar y nadie se entera, porque la página se dibuja igual.
//   2. Un getElementById sin su id en el HTML: revienta a media carga y deja el
//      formulario a medio pintar, con los datos ya cargados (parece que funciona).
//   3. Una llamada al puente que preload.js no declara en `capabilities`: `invoke`
//      RECHAZA sobre un canal inexistente, y un cliente viejo con página nueva es el
//      caso normal aquí.
//
//   node scripts/check-services-wizard.js     (o: npm run check)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { ESQUEMA, CLAVES } = require('../src/services.config');
const { servicesWizardHtml } = require('../src/proxy');

const fallas = [];
const html = servicesWizardHtml();

if (!html || html.indexOf('data-clave') < 0) {
    fallas.push('el asistente no se pudo leer desde src/pages/services.wizard.html');
}

// ── 1. El script compila y no usa ids que no existen ────────────────────────────
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!script) {
    fallas.push('no se encontró el bloque <script> en el asistente');
} else {
    try {
        new vm.Script(script, { filename: 'services.wizard.js' });
    } catch (e) {
        fallas.push(`el script del asistente no compila: ${e.message}`);
    }

    const ids = [...script.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
        .concat([...script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
    for (const id of [...new Set(ids)]) {
        if (!html.includes(`id="${id}"`)) fallas.push(`el script usa el id "${id}" y el HTML no lo tiene`);
    }

    // El cierre no puede depender de nada: la ventana no tiene marco en Windows.
    if (!html.includes('id="close-x"')) fallas.push('falta id="close-x": la ventana quedaría sin forma de cerrarse');

    // ── 3. Todo lo que se le pide al puente tiene que estar declarado ───────────
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    const bloque = preload.slice(preload.indexOf('    services: {'));
    const decl = (bloque.match(/capabilities:\s*\[([\s\S]*?)\]/) || [])[1] || '';
    const declaradas = [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1]);

    const usadas = [...new Set([...script.matchAll(/puente\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1]))];
    for (const u of usadas) {
        if (!declaradas.includes(u)) {
            fallas.push(`el asistente llama a services.${u}() y preload.js no lo declara en capabilities`);
        }
    }
}

// ── 2. Cada ajuste del esquema es editable ──────────────────────────────────────
// Los del paso 4 se generan desde el propio esquema, así que ahí basta con que el
// generador y su contenedor sigan existiendo.
const generados = script && /data-clave="' \+ clave \+ '"/.test(script) && html.includes('id="campos-comportamiento"');
for (const clave of CLAVES) {
    const def = ESQUEMA[clave];
    if (!def.paso || def.paso < 1 || def.paso > 4) {
        fallas.push(`el ajuste "${clave}" no dice en qué paso del asistente se edita`);
        continue;
    }
    if (def.paso === 4) {
        if (!generados) fallas.push(`el ajuste "${clave}" es del paso 4 y el generador de campos ya no está`);
        continue;
    }
    if (!html.includes(`data-clave="${clave}"`)) {
        fallas.push(`el ajuste "${clave}" no tiene control en el asistente: quedaría imposible de configurar`);
    }
}

// Toda opción del esquema tiene su radio: una opción sin control no se puede elegir,
// y el asistente la mostraría como si el valor guardado no existiera.
for (const clave of CLAVES) {
    const def = ESQUEMA[clave];
    if (def.tipo !== 'opcion' || def.paso === 4) continue;
    for (const v of def.valores) {
        if (!html.includes(`data-clave="${clave}" value="${v}"`)) {
            fallas.push(`la opción "${v}" de "${clave}" no tiene control en el asistente`);
        }
    }
}

// Todo radio necesita `name`, o el grupo no se excluye: quedan dos marcados a la vez,
// el operador ve marcada la opción que eligió y se guarda la otra. Es invisible en una
// revisión a ojo y silencioso en tiempo de ejecución.
for (const m of html.matchAll(/<input type="radio"([^>]*)>/g)) {
    const attrs = m[1];
    const clave = (attrs.match(/data-clave="([^"]+)"/) || [])[1] || '(sin data-clave)';
    if (!/\bname="/.test(attrs)) {
        fallas.push(`un radio de "${clave}" no tiene name: el grupo no se excluiría y se guardaría la opción equivocada`);
    }
}

// ── 4. El vocabulario de estados, otra vez ──────────────────────────────────────
// El asistente pinta el estado en vivo con su propio mapa de colores. Un estado nuevo
// sin entrada aquí sale gris y sin significado.
const ESTADOS = ['desconocido', 'ok', 'sospechoso', 'rescatando', 'caido', 'rendido'];
const mapa = (script || '').slice((script || '').indexOf('const CLASE_ESTADO'), (script || '').indexOf('async function refrescarEstado'));
for (const e of ESTADOS) {
    if (!mapa.includes(e)) fallas.push(`el estado "${e}" no está en el mapa de colores del asistente`);
}

// ── 5. La página se sirve ───────────────────────────────────────────────────────
const proxy = fs.readFileSync(path.join(__dirname, '..', 'src', 'proxy.js'), 'utf8');
if (!proxy.includes("'/__client/services'")) {
    fallas.push('proxy.js ya no sirve /__client/services: el botón de la página de Configuración no llevaría a ningún lado');
}
if (!proxy.includes("location.href = '/__client/services'")) {
    fallas.push('la página de Configuración ya no enlaza al asistente: quedaría inalcanzable');
}

if (fallas.length) {
    console.error('asistente de servicios: FALLAS');
    for (const f of fallas) console.error('  - ' + f);
    process.exit(1);
}
console.log(`asistente de servicios: ok (${CLAVES.length} ajustes con control, ids, puente y vocabulario)`);
