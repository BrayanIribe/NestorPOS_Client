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
    body { font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; padding: 20px; background-color:white; }
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
  </style>
</head>
<body>
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
    </div>

    <div id="status" class="status"></div>

    <hr />
    <div class="danger-label">Zona de peligro</div>
    <button id="clear-data" class="danger">Eliminar datos y caché</button>
  </div>

<script>
(async function () {
  const elServer = document.getElementById('server');
  const elStatus = document.getElementById('status');

  function setStatus(msg) { elStatus.textContent = msg || ''; }

  const cfg = await window.NestorClient.getConfig();
  elServer.value = cfg.serverOrigin || 'http://127.0.0.1:8180';

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
        headers['x-forwarded-for'] = req.socket.remoteAddress || '';

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

module.exports = { startLocalFrontendServer };