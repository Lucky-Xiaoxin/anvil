import { configBodySchema, type StatusDto } from '@anvil/shared';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { countDistinctOkProblems, countSubmissions, getSyncState } from './db.ts';
import { buildDashboard } from './dashboard.ts';
import { CfError, type CfClient } from './sync/cf.ts';
import { isRunning, startSync, syncSnapshot } from './sync/runner.ts';

export interface ApiContext {
  db: DatabaseSync;
  client: CfClient;
  getHandle: () => string;
  setHandle: (handle: string) => void;
}

export function buildStatus(db: DatabaseSync, handle: string): StatusDto {
  const lastSyncAt = getSyncState(db, 'last_sync_at');
  return {
    configured: handle !== '',
    handle: handle === '' ? null : handle,
    lastSyncAt: lastSyncAt === null ? null : Number(lastSyncAt),
    counts: { submissions: countSubmissions(db), problems: countDistinctOkProblems(db) },
  };
}

export function registerApi(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/status', async () => buildStatus(ctx.db, ctx.getHandle()));

  app.post('/api/config', async (request, reply) => {
    const parsed = configBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { kind: 'invalid', message: parsed.error.issues[0]?.message ?? 'handle 不合法' } });
    }
    const handle = parsed.data.handle;
    // 换 handle 会清空重建本地库，绝不能跟正在跑的同步交错
    if (handle !== ctx.getHandle() && isRunning()) {
      return reply.code(409).send({ error: { kind: 'busy', message: '同步进行中，等它跑完再换 handle' } });
    }
    try {
      await ctx.client.checkHandle(handle);
    } catch (err) {
      if (err instanceof CfError) {
        return reply.code(err.kind === 'not-found' ? 404 : 502).send({ error: { kind: err.kind, message: err.message } });
      }
      throw err;
    }
    ctx.setHandle(handle);
    return buildStatus(ctx.db, handle);
  });

  app.post('/api/sync', async (_request, reply) => {
    const handle = ctx.getHandle();
    if (handle === '') return reply.code(400).send({ error: { kind: 'invalid', message: '还没有配置 handle' } });
    return reply.code(202).send(startSync(ctx.db, handle, ctx.client));
  });

  app.get('/api/sync/state', async () => syncSnapshot());

  app.get('/api/dashboard', async () => buildDashboard(ctx.db));
}
