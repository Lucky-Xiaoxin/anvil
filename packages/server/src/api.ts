import {
  configBodySchema,
  dashboardQuerySchema,
  syncBodySchema,
  type SourceState,
  type SourceStatusDto,
  type StatusDto,
  type SyncSourceId,
} from '@anvil/shared';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  countDistinctOkProblems,
  countSubmissions,
  getSyncState,
  latestRating,
  syncKey,
} from './db.ts';
import { buildDashboard } from './dashboard.ts';
import { isRunning, startSync, syncSnapshot } from './sync/runner.ts';
import type { SyncSource } from './sync/source.ts';

export interface ApiContext {
  db: DatabaseSync;
  sources: Record<SyncSourceId, SyncSource>;
  /** 按源取 handle（vault/config.json 的 cfHandle / atHandle） */
  getHandles: () => Record<SyncSourceId, string>;
  setHandles: (patch: { cfHandle?: string; atHandle?: string }) => void;
}

const LABEL: Record<SyncSourceId, string> = { cf: 'Codeforces', at: 'AtCoder' };

/** 超过这个天数没同步就算「数据过期」（mock-02 屏 4：缓存已 3 天未更新） */
export const STALE_AFTER_SECONDS = 3 * 86_400;

export function sourceStatus(db: DatabaseSync, id: SyncSourceId, handle: string, now = Date.now()): SourceStatusDto {
  const configured = handle !== '';
  const raw = getSyncState(db, syncKey(id, 'last_sync_at'));
  const lastSyncAt = raw === null || raw === '' ? null : Number(raw);
  const errRaw = getSyncState(db, syncKey(id, 'last_error'));
  const error = errRaw === null || errRaw === '' ? null : errRaw;

  // 还没配置 / 配置了但一次都没同步过 → idle：还没发生的事不该用琥珀或红去预警
  let status: SourceState = 'idle';
  if (configured && error !== null) status = 'down';
  else if (configured && lastSyncAt !== null) {
    status = now / 1000 - lastSyncAt > STALE_AFTER_SECONDS ? 'stale' : 'ok';
  }

  return {
    configured,
    handle: configured ? handle : null,
    lastSyncAt,
    counts: { submissions: countSubmissions(db, id), problems: countDistinctOkProblems(db, id) },
    status,
    error,
    rating: configured ? latestRating(db, id) : null,
  };
}

export function buildStatus(db: DatabaseSync, handles: Record<SyncSourceId, string>, now = Date.now()): StatusDto {
  const cf = sourceStatus(db, 'cf', handles.cf, now);
  const at = sourceStatus(db, 'at', handles.at, now);
  // 顶层四字段 = CF 源原样镜像，切片 1 的调用方不用改（docs/09 §4）
  return {
    configured: cf.configured,
    handle: cf.handle,
    lastSyncAt: cf.lastSyncAt,
    counts: cf.counts,
    sources: { cf, at },
  };
}

export function registerApi(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/status', async () => buildStatus(ctx.db, ctx.getHandles()));

  app.post('/api/config', async (request, reply) => {
    const parsed = configBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { kind: 'invalid', message: parsed.error.issues[0]?.message ?? 'handle 不合法' } });
    }

    const handles = ctx.getHandles();
    const saved: { cfHandle?: string; atHandle?: string } = {};
    for (const source of ['cf', 'at'] as const) {
      const next = source === 'cf' ? parsed.data.cfHandle : parsed.data.atHandle;
      if (next === undefined || next === handles[source]) continue;
      // 换 handle 会按源域清空重建，绝不能跟该源正在跑的同步交错
      if (isRunning(source)) {
        return reply.code(409).send({ error: { kind: 'busy', message: `${LABEL[source]} 同步进行中，等它跑完再换 handle` } });
      }
      const checked = await ctx.sources[source].checkHandle(next);
      if (!checked.ok) {
        return reply
          .code(checked.kind === 'not-found' ? 404 : 502)
          .send({ error: { kind: checked.kind ?? 'unavailable', message: checked.message } });
      }
      if (source === 'cf') saved.cfHandle = next;
      else saved.atHandle = next;
    }
    if (Object.keys(saved).length > 0) ctx.setHandles(saved);
    return buildStatus(ctx.db, { cf: saved.cfHandle ?? handles.cf, at: saved.atHandle ?? handles.at });
  });

  app.post('/api/sync', async (request, reply) => {
    const parsed = syncBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { kind: 'invalid', message: 'source 只能是 cf 或 at' } });
    }
    const source = parsed.data.source;
    const handle = ctx.getHandles()[source];
    if (handle === '') {
      return reply.code(400).send({ error: { kind: 'invalid', message: `还没有配置 ${LABEL[source]} handle` } });
    }
    return reply.code(202).send(startSync(ctx.sources[source], handle));
  });

  app.get('/api/sync/state', async () => syncSnapshot());

  app.get('/api/dashboard', async (request, reply) => {
    const parsed = dashboardQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { kind: 'invalid', message: 'source 只能是 cf、at 或 xcpc' } });
    }
    if (parsed.data.source === 'xcpc') {
      return reply
        .code(501)
        .send({ error: { kind: 'not-implemented', message: 'XCPC 还没接进来 · 契约已冻结（docs/09 §9）' } });
    }
    return buildDashboard(ctx.db, parsed.data.source);
  });
}
