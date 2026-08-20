const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const https = require('https');

const LOCAL_FRONT_PORT = parseInt(process.env.NESTOR_FRONT_PORT || '18180', 10);
const CACHE_MAX_BYTES = parseInt(process.env.NESTOR_API_CACHE_MAX_BYTES || String(5 * 1024 * 1024), 10);

function sha256Hex(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp_' + Date.now();
    await ensureDir(path.dirname(file));
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    await fsp.rename(tmp, file);
}

async function readJsonIfExists(file) {
    try {
        const b = await fsp.readFile(file);
        return JSON.parse(b.toString('utf-8'));
    } catch {
        return null;
    }
}

function isJsonContentType(ct) {
    ct = String(ct || '').toLowerCase();
    return ct.includes('application/json') || ct.includes('+json');
}

function configHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Nestor POS - Configuración</title>
  <style>
    body { font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0 20px 20px; background-color:white; }
    .topbar { position: sticky; top: 0; z-index: 10; margin: 0 -20px 16px; height: 44px; padding: 0 14px; display:flex; align-items:center; justify-content:space-between; gap: 10px; background: rgba(255,255,255,0.94); border-bottom: 1px solid rgba(0,0,0,0.08); user-select:none; -webkit-app-region: drag; }
    .topbar .title { font-size: 13px; font-weight: 600; color:#333; }
    .topbar[hidden] { display:none; }
    .close-x { -webkit-app-region: no-drag; width: 22px; height: 22px; padding: 0; border-radius: 999px; border: 1px solid rgba(0,0,0,0.18); background: #ff5f57; display:inline-flex; align-items:center; justify-content:center; }
    .close-x:hover { background: #ff4b42; }
    .close-x svg { pointer-events: none; }
    .card { max-width: 560px; margin: 0 auto; border: 1px solid #ddd; border-radius: 10px; padding: 18px; }
    label { display:block; font-weight: 600; margin-bottom: 6px; }
    input { width:100%; padding: 10px; border-radius: 8px; border: 1px solid #bbb; font-size: 14px; }
    .row { margin-top: 12px; display:flex; gap: 10px; }
    button { padding: 10px 12px; border-radius: 8px; border: 1px solid #222; background: #222; color:#fff; cursor:pointer; }
    button.secondary { background: #fff; color:#222; }
    button.danger { border-color: #c0392b; background: #c0392b; }
    button.danger:hover { background: #a93226; border-color: #a93226; }
    .hint { color:#555; font-size: 13px; margin-top: 10px; line-height: 1.4; }
    .status { margin-top: 12px; font-size: 13px; white-space: pre-wrap; }
    hr { border: none; border-top: 1px solid #eee; margin: 18px 0 14px; }
    .danger-label { font-size: 11px; font-weight: 700; color: #c0392b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
    .section-label { font-size: 11px; font-weight: 700; color: #444; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
    .kv { font-size: 13px; color:#333; line-height: 1.5; }
    .kv b { font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color:#555; word-break: break-all; }
  </style>
</head>
<body>
  <div class="topbar" id="topbar" hidden>
    <span class="title">Configuracion</span>
    <button id="close-x" class="close-x" title="Cerrar (Esc)" aria-label="Cerrar">
      <svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 3l6 6M9 3L3 9" stroke="rgba(0,0,0,0.65)" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
  </div>

  <div class="card">
    <h2>Servidor Nestor POS</h2>
    <div class="hint">
      Ejemplos:
      <div>127.0.0.1:8180</div>
      <div>http://192.168.1.10:8180</div>
    </div>

    <div style="margin-top:14px;">
      <label for="server">Dirección del servidor</label>
      <input id="server" placeholder="http://127.0.0.1:8180" />
    </div>

    <div class="row">
      <button id="save">Guardar y reiniciar</button>
      <button id="test" class="secondary">Probar</button>
      <button id="close" class="secondary" hidden>Cerrar</button>
    </div>

    <div id="status" class="status"></div>

    <hr />
    <div class="section-label">Captura de sesiones (XHR)</div>
    <div id="xhr-state" class="kv">Consultando...</div>
    <div id="xhr-path" class="mono"></div>
    <div class="row">
      <button id="xhr-save" class="secondary">Guardar sesión ahora</button>
      <button id="xhr-folder" class="secondary">Abrir carpeta</button>
    </div>

    <hr />
    <div class="danger-label">Zona de peligro</div>
    <button id="clear-data" class="danger">Eliminar datos y caché</button>
  </div>

<script>
(async function () {
  // OJO: esta pagina se emite desde un template literal en configHtml(), asi que toda
  // secuencia de escape va DOBLE (barra-barra-n) y aqui NO se usan backticks. Un escape
  // simple mete el salto de linea literal dentro de la cadena y el navegador tira
  // SyntaxError: eso no rompe una linea, rompe el script COMPLETO y deja la pagina
  // muerta y muda (sin boton de cerrar y con todo en "Consultando...").
  const elServer = document.getElementById('server');
  const elStatus = document.getElementById('status');

  function setStatus(msg) { elStatus.textContent = msg || ''; }

  // Cada bloque va aislado: si uno falla, los demás siguen. El botón de cerrar es lo
  // último que puede depender de que el resto de la página funcione.
  function block(nombre, fn) {
    try {
      return fn();
    } catch (e) {
      console.error('[config] bloque ' + nombre + ' falló:', e);
      setStatus('ERROR en ' + nombre + ': ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  const puente = !!(window.NestorClient && window.NestorClient.getConfig);

  // ── Cerrar ────────────────────────────────────────────────────────────────
  // La ventana no tiene marco (Windows) ni semáforos (macOS): si esto no se dibuja,
  // no hay forma de cerrarla. Se dibuja SIEMPRE.
  //
  // El parametro modal=1 solo distingue la ventana de Configuracion de la MISMA pagina
  // servida dentro de la ventana principal (primer arranque, cuando todavia no hay
  // frontend): ahi cerrar es salir de la aplicacion, asi que se pregunta antes y Esc
  // no cierra.
  const IS_MODAL = new URLSearchParams(location.search).get('modal') === '1';

  block('cerrar', () => {
    const elTopbar = document.getElementById('topbar');
    const elCloseX = document.getElementById('close-x');
    const elClose = document.getElementById('close');

    elTopbar.hidden = false;
    elClose.hidden = false;

    const cerrar = () => {
      if (!IS_MODAL && !confirm('¿Cerrar Nestor POS?')) return;
      try {
        window.NestorClient.close();
      } catch (e) {
        try { window.close(); } catch (e2) { }
      }
    };

    elCloseX.addEventListener('click', cerrar);
    elClose.addEventListener('click', cerrar);

    if (IS_MODAL) {
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); cerrar(); }
      });
    }
  });

  if (!puente) {
    // Página abierta fuera del cliente (un navegador contra el puerto local). Se dice,
    // en vez de morir en el primer await y dejar todo en "Consultando...".
    setStatus('Esta página necesita el cliente de Nestor POS: fuera de él no hay acceso a la configuración.');
    document.getElementById('xhr-state').textContent = 'No disponible: abre la ventana de Configuración desde el cliente.';
    ['save', 'test', 'clear-data', 'xhr-save', 'xhr-folder'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    return;
  }

  // ── Servidor ──────────────────────────────────────────────────────────────
  try {
    const cfg = await window.NestorClient.getConfig();
    elServer.value = (cfg && cfg.serverOrigin) || 'http://127.0.0.1:8180';
  } catch (e) {
    setStatus('ERROR al leer la configuración: ' + (e && e.message ? e.message : String(e)));
  }

  document.getElementById('test').addEventListener('click', async () => {
    setStatus('Probando...');
    try {
      const r = await window.NestorClient.testServerOrigin(elServer.value.trim());
      setStatus('OK\\n' + JSON.stringify(r, null, 2));
    } catch (e) {
      setStatus('ERROR\\n' + (e && e.message ? e.message : String(e)));
    }
  });

  document.getElementById('save').addEventListener('click', async () => {
    setStatus('Guardando...');
    try {
      await window.NestorClient.setServerOrigin(elServer.value.trim());
      setStatus('Guardado. Reiniciando...');
      await window.NestorClient.relaunch();
    } catch (e) {
      setStatus('ERROR\\n' + (e && e.message ? e.message : String(e)));
    }
  });

  // ── Captura de sesiones XHR ───────────────────────────────────────────────
  const elXhrState = document.getElementById('xhr-state');
  const elXhrPath = document.getElementById('xhr-path');

  function fmtBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function refreshXhr() {
    if (!window.NestorClient.xhr) {
      elXhrState.textContent = 'No disponible en esta versión del cliente.';
      return;
    }
    try {
      const st = await window.NestorClient.xhr.status();
      if (!st || !st.enabled) {
        elXhrState.textContent = 'Apagada (NESTOR_XHR_CAPTURE=0).';
        elXhrPath.textContent = '';
        return;
      }

      const dias = (st.topes && st.topes.dias_retencion) || 30;
      const retencion = 'Se conservan ' + dias + ' días y se borran solas en esta caja.'
        + (st.consola ? ' Se guarda también el volcado de consola.' : '')
        + (st.encabezados_de_sesion === 'incluidos' ? ' Encabezados de sesión INCLUIDOS.' : ' Encabezados de sesión tapados.')
        + (st.ultima_limpieza ? ' Última limpieza: ' + st.ultima_limpieza.borradas + ' borradas, quedan ' + st.ultima_limpieza.quedan + '.' : '');

      if (!st.sesion) {
        elXhrState.innerHTML = 'Encendida, sin sesión abierta.' + (st.error ? ' ' + st.error : '') + '<br />' + retencion;
        elXhrPath.textContent = st.dir || '';
        return;
      }

      const s = st.sesion;
      elXhrState.innerHTML = '<b>Grabando</b> — ' + s.peticiones + ' peticiones, ' + fmtBytes(s.bytes)
        + (s.usuario ? ' — usuario ' + s.usuario : ' — sin sesión iniciada')
        + (s.cuerpos_apagados ? ' — sólo metadatos (tope alcanzado)' : '')
        + '<br />' + retencion;
      elXhrPath.textContent = s.ruta || '';
    } catch (e) {
      elXhrState.textContent = 'ERROR ' + (e && e.message ? e.message : String(e));
    }
  }

  document.getElementById('xhr-save').addEventListener('click', async () => {
    setStatus('Guardando la sesión XHR...');
    try {
      const r = await window.NestorClient.xhr.saveNow('configuracion');
      if (r && r.ok) setStatus('Sesión guardada (' + (r.peticiones || 0) + ' peticiones):\\n' + (r.ruta || ''));
      else setStatus('ERROR\\n' + ((r && r.error) || 'no se pudo guardar'));
    } catch (e) {
      setStatus('ERROR\\n' + (e && e.message ? e.message : String(e)));
    }
    refreshXhr();
  });

  document.getElementById('xhr-folder').addEventListener('click', async () => {
    try {
      const r = await window.NestorClient.xhr.openFolder();
      if (r && !r.ok) setStatus('ERROR\\n' + (r.error || 'no se pudo abrir la carpeta'));
    } catch (e) {
      setStatus('ERROR\\n' + (e && e.message ? e.message : String(e)));
    }
  });

  refreshXhr();
  setInterval(refreshXhr, 3000);

  // ── Zona de peligro ───────────────────────────────────────────────────────
  document.getElementById('clear-data').addEventListener('click', async () => {
    const ok = confirm('¿Eliminar todos los datos y caché del cliente POS?\\n\\nSe borrarán los archivos del frontend, el caché de respuestas y el almacenamiento local. La aplicación se reiniciará.');
    if (!ok) return;
    setStatus('Eliminando datos...');
    try {
      const res = await window.NestorClient.clearData();
      if (res && res.busy) setStatus('Hay una actualización en curso. Intenta de nuevo en unos segundos.');
      else if (res && res.ok === false) setStatus('ERROR\\n' + (res.error || 'No se pudo borrar'));
      else setStatus('Datos eliminados. Reiniciando...');
    } catch (e) {
      setStatus('ERROR\\n' + (e && e.message ? e.message : String(e)));
    }
  });
})();
</script>
</body>
</html>`;
}

function startLocalFrontendServer(currentDir, getServerOriginFn) {
    const ex = express();

    const cacheDir = process.env.NESTOR_API_CACHE_DIR || path.join(currentDir, '..', 'api_cache');

    ex.get('/__client/config', (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(configHtml());
    });

    ex.use('/api/v1', async (req, res) => {
        const origin = getServerOriginFn();

        let upstreamBase;
        try {
            upstreamBase = new URL(origin);
        } catch {
            res.statusCode = 500;
            res.end('Invalid server origin');
            return;
        }

        const upstreamUrl = new URL(req.baseUrl + req.url, upstreamBase);
        const isHttps = upstreamUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const headers = { ...req.headers };
        headers.host = upstreamUrl.host;
        headers['x-forwarded-host'] = req.headers.host || '';
        headers['x-forwarded-proto'] = 'http';

        // Este proxy corre DENTRO de la caja: la conexión al servidor sale de este
        // mismo equipo, así que el RemoteAddr que ve el backend ya ES la IP de la
        // caja. Anexar un X-Forwarded-For con `req.socket.remoteAddress` —que es el
        // loopback de la ventana hablando con este express, o sea ::1— sólo servía
        // para mentirle: el backend confía en ese header para identificar el origen,
        // así que TODOS los accesos desde el cliente de escritorio quedaban
        // registrados en la bitácora como ::1, sin poder distinguir una caja de otra.
        // Se borran también los que pudieran venir de la ventana: la única fuente de
        // verdad aquí es la conexión TCP.
        delete headers['x-forwarded-for'];
        delete headers['x-real-ip'];
        delete headers['xz-nestor-real-xyz-ip'];

        const options = {
            protocol: upstreamUrl.protocol,
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            method: req.method,
            path: upstreamUrl.pathname + upstreamUrl.search,
            headers
        };

        // const auth = String(req.headers['X-Access-Token'] || '');
        const cacheKey = `${upstreamBase.toString()}|${req.method}|${req.baseUrl}${req.url}`;
        const cacheFile = path.join(cacheDir, sha256Hex(cacheKey) + '.json');

        const disallowCache = [
            '/pos/status'
        ];

        const canCacheRequest = (req.method === 'GET') && !disallowCache.includes(req.url)
        console.log(cacheKey)

        const serveCached = async () => {
            if (disallowCache.includes(req.url))
                return false;
            console.log('[SERVE FROM CACHE]', cacheKey)
            const cached = await readJsonIfExists(cacheFile);
            if (!cached || !cached.response) return false;

            res.statusCode = cached.response.status || 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('X-Nestor-Cache', 'HIT');

            const body = cached.response.body_json;
            res.end(JSON.stringify(body));
            return true;
        };

        const proxyReq = client.request(options, (proxyRes) => {
            res.statusCode = proxyRes.statusCode || 502;
            Object.entries(proxyRes.headers).forEach(([k, v]) => {
                if (typeof v !== 'undefined') res.setHeader(k, v);
            });

            const ct = proxyRes.headers['content-type'] || '';
            const canCacheResponse =
                canCacheRequest &&
                (proxyRes.statusCode >= 200 && proxyRes.statusCode < 202) &&
                isJsonContentType(ct);

            // console.log({ canCacheRequest, canCacheResponse, status: proxyRes.statusCode })



            // console.log('REQUEST', canCacheResponse, req.method, req.baseUrl, req.url)

            let chunks = [];
            let total = 0;
            let tooBig = false;

            if (canCacheResponse) {
                proxyRes.on('data', (chunk) => {
                    if (tooBig) return;
                    total += chunk.length;
                    if (total > CACHE_MAX_BYTES) {
                        tooBig = true;
                        chunks = [];
                        return;
                    }
                    chunks.push(chunk);
                });

                proxyRes.on('end', async () => {
                    if (tooBig) return;

                    const raw = Buffer.concat(chunks).toString('utf-8');
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        return;
                    }

                    const payload = {
                        saved_at: new Date().toISOString(),
                        request: {
                            method: req.method,
                            path: req.baseUrl + req.url,
                            upstream_url: upstreamUrl.toString()
                        },
                        response: {
                            status: proxyRes.statusCode || 200,
                            content_type: String(ct),
                            body_json: parsed
                        }
                    };

                    // console.log('RESPONSE', proxyRes.statusCode, typeof parsed === "object" ? JSON.stringify(parsed) : parsed);

                    try {
                        console.log('[CACHED]', cacheKey, cacheFile)
                        await writeJsonAtomic(cacheFile, payload);
                    } catch {
                    }
                });
            }

            proxyRes.pipe(res, { end: true });
        });

        proxyReq.on('error', async (err) => {
            if (canCacheRequest) {
                const ok = await serveCached();
                if (ok) return;
            }

            res.statusCode = 502;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(`Bad Gateway: ${err.message}`);
        });

        req.pipe(proxyReq, { end: true });
    });

    ex.use(express.static(currentDir, { fallthrough: true }));

    ex.get(/.*/, (req, res) => {
        const idx = path.join(currentDir, 'index.html');
        if (fs.existsSync(idx)) {
            res.sendFile(idx);
            return;
        }
        res.redirect('/__client/config');
    });

    return new Promise((resolve, reject) => {
        const server = ex.listen(LOCAL_FRONT_PORT, '127.0.0.1', () => resolve(server));
        server.on('error', reject);
    });
}

module.exports = { startLocalFrontendServer, configHtml };