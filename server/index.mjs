import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { Integrations } from './lib/integrations.mjs';
import { Application } from './lib/application.mjs';
import { AppError, assert, publicError } from './lib/errors.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.webm':'video/webm', '.ico':'image/x-icon', '.woff2':'font/woff2' };
function json(res, status, body) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  const type = req.headers['content-type']?.split(';')[0];
  assert(type === 'application/json', 415, 'JSON_REQUIRED', 'Send Content-Type: application/json.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 64 * 1024, 413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KiB.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'INVALID_JSON', 'Request body must be a JSON object.'); return value; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
}
function originAllowed(req, origins) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const same = origin === `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  return same || origins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}
function hostAllowed(req, origins) {
  // Origin alone is insufficient: a rebinding website can make its own hostname
  // resolve to loopback and send matching Host/Origin headers to this server.
  let requested;
  try {
    requested = new URL(`http://${req.headers.host}`);
    if (requested.username || requested.password || requested.pathname !== '/' || requested.search || requested.hash) return false;
  } catch { return false; }
  const trusted = new Set(['localhost', '127.0.0.1', '[::1]']);
  const listenerAddress = req.socket.localAddress?.replace(/^::ffff:/, '');
  if (listenerAddress) trusted.add(listenerAddress.includes(':') ? `[${listenerAddress}]` : listenerAddress);
  for (const origin of origins) {
    try { trusted.add(new URL(origin).hostname); } catch { /* Invalid entries grant no host access. */ }
  }
  return trusted.has(requested.hostname);
}
function responseRange(req, res, size) {
  let start = 0, end = size - 1;
  if (!req.headers.range) return { start, end, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  const invalid = () => {
    res.setHeader('Content-Range', `bytes */${size}`);
    throw new AppError(416, 'INVALID_RANGE', 'Byte range is invalid or outside the media.');
  };
  if (!match || !(match[1] || match[2])) return invalid();
  if (!match[1]) {
    const count = Number(match[2]);
    if (!(count > 0)) return invalid();
    start = Math.max(0, size - count);
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), end) : end;
  }
  if (!(start <= end && start < size)) return invalid();
  return { start, end, status: 206 };
}
async function serveFile(req, res, root, pathname) {
  assert(!pathname.split('/').some(p => p.startsWith('.')), 404, 'NOT_FOUND', 'Resource not found.');
  let file = path.resolve(root, `.${pathname}`);
  assert(file === root || file.startsWith(`${root}${path.sep}`), 404, 'NOT_FOUND', 'Resource not found.');
  let info;
  try { info = await stat(file); if (info.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file); } }
  catch {
    // SPA fallback only for extensionless page navigation, never for missing assets.
    if (path.extname(pathname)) throw new AppError(404, 'NOT_FOUND', 'Resource not found.');
    file = path.join(root, 'index.html');
    try { info = await stat(file); } catch { throw new AppError(404, 'NOT_FOUND', 'Frontend files are not available.'); }
  }
  assert(info.isFile(), 404, 'NOT_FOUND', 'Resource not found.');
  const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges':'bytes', 'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' };
  const { start, end, status } = responseRange(req, res, info.size);
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
export async function createServer({ dataFile = process.env.SHOWONCE_DATA_FILE || path.join(projectRoot, 'server/.data/state.json'),
  env = process.env, fetchImpl = globalThis.fetch, staticRoot, store: suppliedStore, integrations: suppliedIntegrations } = {}) {
  const store = suppliedStore || await new Store(dataFile).load();
  const integrations = suppliedIntegrations || new Integrations({ env, fetchImpl });
  const application = new Application({ store, integrations });
  if (!staticRoot) {
    try { await stat(path.join(projectRoot, 'dist/index.html')); staticRoot = path.join(projectRoot, 'dist'); }
    catch { staticRoot = path.join(projectRoot, 'public'); }
  }
  staticRoot = path.resolve(staticRoot);
  const origins = (env.SHOWONCE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const methods = { '/api/generate':'generate', '/api/evaluate':'evaluate', '/api/correct':'correct', '/api/publish':'publish', '/api/replay':'replay', '/api/reset':'reset',
    '/api/discover':'discover', '/api/label':'label', '/api/check':'check', '/api/reingest':'reingest', '/api/cancel':'cancel', '/api/reingest/reconcile':'reconcileReingest' };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
    try {
      assert(hostAllowed(req, origins), 403, 'HOST_NOT_ALLOWED', 'This host is not allowed to use the local server. Configure the exact authenticated preview origin if needed.');
      assert(originAllowed(req, origins), 403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed to use the local API.');
      if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, application.state());
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', service: 'showonce', source: 'local-server' });
      if (pathname.startsWith('/api/media/') && ['GET','HEAD'].includes(req.method)) {
        const bytes = await application.media(pathname.slice('/api/media/'.length));
        // Verify the full frozen content digest before serving any requested range.
        const { start, end, status } = responseRange(req, res, bytes.length);
        res.writeHead(status, { 'Content-Type':'video/mp4', 'Content-Length':Math.max(0, end - start + 1), 'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store',
          ...(status === 206 ? { 'Content-Range':`bytes ${start}-${end}/${bytes.length}` } : {}) });
        res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1)); return;
      }
      if (pathname.startsWith('/api/reingest/') && req.method === 'GET') return json(res, 200, await application.reingestStatus(pathname.slice('/api/reingest/'.length)));
      if (methods[pathname] && req.method === 'POST') {
        const result = await application[methods[pathname]](await body(req));
        return json(res, 200, result);
      }
      if (pathname.startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', 'API route was not found.');
      assert(['GET','HEAD'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      await serveFile(req, res, staticRoot, pathname);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const safe = publicError(error); json(res, safe.status, safe.body);
    }
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 15000;
  return { server, application, store, integrations };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  assert(Number.isInteger(port) && port >= 0 && port <= 65535, 500, 'INVALID_PORT', 'PORT must be a valid TCP port.');
  const { server } = await createServer();
  server.listen(port, host, () => console.log(`ShowOnce listening on http://${host}:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
