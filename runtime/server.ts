import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import routes from 'virtual:routes';
import { attachSession } from './session';

const publicDir = path.resolve('public');
const pages = new Set(['/', '/workbench', '/projects', '/guide', '/samples']);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
async function staticResponse(pathname: string, method: string) {
  if (!['GET', 'HEAD'].includes(method)) return new Response('Method not allowed', { status: 405 });
  const target = pages.has(pathname) ? path.join(publicDir, 'workbench.html') : path.resolve(publicDir, '.' + pathname);
  if (!target.startsWith(publicDir + path.sep)) return new Response('Not found', { status: 404 });
  try {
    const stat = await fs.stat(target); if (!stat.isFile()) return new Response('Not found', { status: 404 });
    return new Response(method === 'HEAD' ? null : await fs.readFile(target), { headers: { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Content-Length': String(stat.size), 'Cache-Control': pages.has(pathname) ? 'no-store' : 'public, max-age=3600' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  incoming.on('aborted', () => controller.abort());
  outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
  try {
    const configuredOrigin = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
    const protocol = process.env.TRUST_PROXY !== 'false' && incoming.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const origin = configuredOrigin || protocol + '://' + incoming.headers.host;
    const url = new URL(incoming.url || '/', origin);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path');
    const method = incoming.method || 'GET';
    const request = new Request(url, { method, headers: incoming.headers as any, signal: controller.signal,
      ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(incoming) as any, duplex: 'half' } : {}) });
    const cookie = attachSession(request, pathname === '/api/session' && method === 'GET');
    let response: Response | undefined;
    if (pathname === '/healthz') response = Response.json({ status: 'ok', service: 'qiushi-presentation-studio' });
    else if (pathname.startsWith('/api/')) {
      for (const route of routes) {
        const match = route.pattern.exec(pathname); if (!match) continue;
        const handler = route.handlers[method];
        if (!handler) { response = Response.json({ error: '不支持此请求方法。' }, { status: 405 }); break; }
        const params = Object.fromEntries(route.names.map((name: string, index: number) => [name, match[index + 1]]));
        response = await handler(request, { params: Promise.resolve(params) }); break;
      }
      response ||= Response.json({ error: '接口不存在。' }, { status: 404 });
    } else response = await staticResponse(pathname, method);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.setHeader('X-Content-Type-Options', 'nosniff');
    outgoing.setHeader('Referrer-Policy', 'same-origin');
    if (cookie) outgoing.setHeader('Set-Cookie', cookie);
    if (method === 'HEAD' || !response.body) outgoing.end();
    else await pipeline(Readable.fromWeb(response.body as any), outgoing);
  } catch (error) {
    if (outgoing.headersSent) { outgoing.destroy(); return; }
    outgoing.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    outgoing.end(JSON.stringify({ error: '服务暂时无法完成请求，请稍后重试。' }));
    if (!controller.signal.aborted) console.error('Request failed:', error instanceof Error ? error.message : 'unknown error');
  }
});
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30_000;
server.listen(Number(process.env.PORT || 7860), '0.0.0.0', () => console.log('求是·智汇 listening on port ' + (process.env.PORT || 7860)));
