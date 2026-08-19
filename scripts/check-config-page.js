// Revisa la página de Configuración que emite proxy.js → configHtml().
//
// Por qué existe: esa página vive dentro de un template literal, así que el compilador
// nunca ve su JavaScript. Un escape simple (\n en vez de \\n) o un backtick en un
// comentario no rompen una línea — rompen el SCRIPT COMPLETO, y la ventana sale muda:
// sin botón de cerrar y con todo en "Consultando...". `node --check src/proxy.js` pasa
// tan tranquilo. Esto compila el script tal y como lo recibe el navegador y comprueba
// que cada id que busca el script exista de verdad en el HTML.
//
//   node scripts/check-config-page.js     (o: npm run check)

const vm = require('vm');
const { configHtml } = require('../src/proxy');

const fallas = [];
const html = configHtml();

const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!script) {
    fallas.push('no se encontró el bloque <script> en la página');
} else {
    try {
        new vm.Script(script, { filename: 'config-page.js' });
    } catch (e) {
        fallas.push(`el script emitido no compila: ${e.message}`);
    }

    // Todo getElementById('x') tiene que tener su id="x" en el HTML.
    const ids = [...script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    for (const id of [...new Set(ids)]) {
        if (!html.includes(`id="${id}"`)) fallas.push(`el script usa el id "${id}" y el HTML no lo tiene`);
    }

    // El cierre de la ventana no puede depender de nada: sin marco no hay otra salida.
    for (const necesario of ['id="topbar"', 'id="close-x"', 'id="close"']) {
        if (!html.includes(necesario)) fallas.push(`falta ${necesario}: la ventana quedaría sin forma de cerrarse`);
    }
}

if (fallas.length) {
    console.error('página de Configuración: FALLA');
    for (const f of fallas) console.error('  -', f);
    process.exit(1);
}

console.log(`página de Configuración: ok (${html.length} bytes, script de ${script.split('\n').length} líneas)`);
