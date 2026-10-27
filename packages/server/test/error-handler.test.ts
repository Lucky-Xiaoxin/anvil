import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/error-handler.ts';

describe('全局错误体', () => {
  it('bodyLimit 413 归类为 payload-too-large，而不是服务端 internal', async () => {
    const app = Fastify({ logger: false, bodyLimit: 16 });
    registerErrorHandler(app);
    app.post('/echo', async () => ({ ok: true }));
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        payload: { text: 'x'.repeat(100) },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: { kind: 'payload-too-large', message: '请求体超过上限' } });
    } finally {
      await app.close();
    }
  });

  it('其它 4xx 保留状态码并回对象形状', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/bad', async () => {
      const err = new Error('bad request') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/bad' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: { kind: 'invalid', message: '请求格式不合法' } });
    } finally {
      await app.close();
    }
  });
});
