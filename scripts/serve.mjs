// Serves the repo root the way Cloudflare Pages with functions/_middleware.js does, for the
// Playwright suite and `npm run serve`. Python's http.server, which did this before, knew nothing
// of the app's own addresses (2026-09-27): a reload on /bookings was a 404 there, and every spec
// that reloads the page failed on the address alone. So, as on Pages:
//   - a file is served as it is, with its type;
//   - /index.html answers 308 to /, and a directory answers with its index.html (/staff/);
//   - one of the app's own addresses (APP_ROUTE, the same list as the middleware, the service
//     worker and the router in app.src.html) is answered with the app: index.html, status 200;
//   - anything else is 404.html, status 404.
// Nothing here is deployed; production runs the middleware itself.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PORT = Number(process.argv[2] || process.env.PW_PORT || 4173);
const ROOT = process.cwd();
const APP_ROUTE = /^\/(?:reserve|my-bookings|account|bookings|dashboard|sales|inventory|workshop|community|ambassadors|website|messages|analytics|history|team)(?:\/[a-z0-9-]+){0,2}\/?$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.map': 'application/json',
};

async function file(rel) {
  const abs = normalize(join(ROOT, rel));
  if (!abs.startsWith(ROOT + sep) && abs !== ROOT) return null;
  try {
    const s = await stat(abs);
    if (s.isDirectory()) return { dir: true };
    return { body: await readFile(abs), type: TYPES[extname(abs).toLowerCase()] || 'application/octet-stream', size: s.size, mtime: s.mtimeMs };
  } catch { return null; }
}

const send = (res, status, body, type, extra = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache', ...extra });
  res.end(body);
};

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); } catch { send(res, 400, 'Bad request', 'text/plain'); return; }
  if (path === '/index.html') { res.writeHead(308, { location: '/' }); res.end(); return; }
  const wanted = path === '/' ? '/index.html' : path.endsWith('/') ? path + 'index.html' : path;
  let hit = await file(wanted);
  if (hit && hit.dir) { res.writeHead(301, { location: path + '/' }); res.end(); return; } // as Pages (and Python) do
  if (!hit && APP_ROUTE.test(path)) hit = await file('/index.html'); // the middleware's fallback
  if (!hit) { const nf = await file('/404.html'); send(res, 404, nf ? nf.body : 'Not found', nf ? nf.type : 'text/plain'); return; }
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': hit.type, 'content-length': hit.size }); res.end(); return; }
  send(res, 200, hit.body, hit.type, { etag: `"${hit.size}-${Math.floor(hit.mtime)}"` });
}).listen(PORT, '127.0.0.1', () => console.log(`serve: http://127.0.0.1:${PORT}/ (${ROOT})`));
