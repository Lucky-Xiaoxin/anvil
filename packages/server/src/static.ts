import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, normalize, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

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

/** 只从 dist 里取文件；越界路径一律拒绝 */
function distFile(distDir: string, urlPath: string): string | null {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const abs = resolve(distDir, rel);
  if (!abs.startsWith(resolve(distDir))) return null;
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

export function registerStatic(app: FastifyInstance, distDir: string): void {
  app.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });

    const direct = distFile(distDir, request.url.split('?')[0]!);
    const file = direct ?? distFile(distDir, '/index.html');
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
