import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 坏百分号编码不该把请求打崩，原样交给下面的越界检查拦掉 */
function decode(urlPath: string): string {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return '';
  }
}

/** 只从 dist 里取文件；越界路径一律拒绝 */
function distFile(distDir: string, urlPath: string): string | null {
  const root = resolve(distDir);
  const rel = normalize(decode(urlPath)).replace(/^([/\\])+/, '');
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

export function registerStatic(app: FastifyInstance, distDir: string): void {
  app.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { kind: 'not-found', message: '接口不存在' } });
    }

    const path = request.url.split('?')[0]!;
    const direct = distFile(distDir, path);
    // 带扩展名的资源请求不做 SPA 兜底：拿 HTML 当 JS 只会把报错推到控制台里
    if (!direct && extname(path)) {
      return reply.code(404).send({ error: { kind: 'not-found', message: '文件不存在' } });
    }
    const file = direct ?? distFile(distDir, join('/', 'index.html'));
    if (!file) {
      return reply.code(503).type('text/plain; charset=utf-8').send('前端还没构建：先跑 npm run build');
    }

    const ext = extname(file);
    reply.type(MIME[ext] ?? 'application/octet-stream');
    reply.header(
      'Cache-Control',
      request.url.startsWith('/assets/') && direct ? 'public, max-age=31536000, immutable' : 'no-store',
    );
    return reply.send(createReadStream(file));
  });
}
