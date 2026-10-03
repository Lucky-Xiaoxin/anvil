import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerStatic } from '../src/static.ts';

const distDir = join(import.meta.dirname, '.tmp-dist');

let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<html><body>anvil</body></html>');
  writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log(1)');
  app = Fastify();
  registerStatic(app, distDir);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(distDir, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('静态托管', () => {
  it('首页与资源正常出', async () => {
    expect((await get('/')).payload).toContain('anvil');
    const asset = await get('/assets/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('坏百分号编码不出 5xx', async () => {
    const res = await get('/%');
    expect(res.statusCode).toBeLessThan(500);
  });

  it('正常 percent 编码路径照样解码并回 SPA', async () => {
    const res = await get('/%41%41');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('anvil');
  });

  it('目录穿越拿不到 dist 外的文件', async () => {
    const outside = join(distDir, '..', '..', 'package.json');
    expect(existsSync(outside)).toBe(true);
    for (const url of ['/../../package.json', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.payload, url).not.toContain('@anvil/server');
    }
  });

  it('带扩展名的缺失资源不返回 HTML', async () => {
    const res = await get('/assets/nope.js');
    expect(res.statusCode).toBe(404);
    expect(res.payload).not.toContain('anvil');
  });

  it('未知路径回 SPA，/api 未知路径回 404 JSON', async () => {
    expect((await get('/whatever')).payload).toContain('anvil');
    const api = await get('/api/nope');
    expect(api.statusCode).toBe(404);
    expect(JSON.parse(api.payload)).toHaveProperty('error');
  });
});
