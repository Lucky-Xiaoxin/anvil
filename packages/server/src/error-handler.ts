import type { FastifyInstance } from 'fastify';
import { ConfigWriteBlocked } from './config.ts';
import { life } from './life.ts';

/** 全局兜底：路由自己没接住的错误统一成 `{ error: { kind, message } }` 一种形状 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const e = err as { message?: unknown; statusCode?: number };
    if (err instanceof ConfigWriteBlocked) {
      life('request-error', `${request.method} ${request.url} 配置读不懂，已拒绝写入`);
      return reply.code(409).send({ error: { kind: 'config-invalid', message: err.message } });
    }

    const status = e.statusCode ?? 500;
    // Fastify 自己的 4xx（如 bodyLimit 的 413）不是服务端故障：保留状态码，别报成 internal
    if (status >= 400 && status < 500) {
      life('request-error', `${request.method} ${request.url} ${status} ${String(e.message ?? err)}`);
      const tooLarge = status === 413;
      return reply.code(status).send({
        error: {
          kind: tooLarge ? 'payload-too-large' : 'invalid',
          message: tooLarge ? '请求体超过上限' : '请求格式不合法',
        },
      });
    }

    life('request-error', `${request.method} ${request.url} ${String(e.message ?? err)}`);
    console.error('[anvil] request-error:', err);
    return reply.code(status).send({
      error: { kind: 'internal', message: '服务端内部错误，详情见 vault/anvil-server.log' },
    });
  });
}
