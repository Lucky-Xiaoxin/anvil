import {
  arenaContestQuerySchema,
  configBodySchema,
  dashboardQuerySchema,
  syncBodySchema,
  xcpcClaimBodySchema,
  xcpcQuerySchema,
  type SourceState,
  type SourceStatusDto,
  type StatusDto,
  type SyncSourceId,
} from '@anvil/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { ArenaError, type ArenaClient } from './arena.ts';
import { configWarningOf } from './config.ts';
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
import { XcpcError, claimXcpc, refreshXcpc, xcpcProfile, xcpcStatus, type XcpcClient, type XcpcStore } from './sync/xcpc.ts';
import { registerWorkRoutes } from './work/routes.ts';
import type { WorkService } from './work/store.ts';

export interface ApiContext {
  db: DatabaseSync;
  sources: Record<SyncSourceId, SyncSource>;
  /** 按源取 handle（vault/config.json 的 cfHandle / atHandle） */
  getHandles: () => Record<SyncSourceId, string>;
  setHandles: (patch: { cfHandle?: string; atHandle?: string }) => void;
  /** XCPC 不跑 /api/sync runner：认领态在 config、档案在 xcpc_players，取数客户端可注入便于测 */
  xcpc: XcpcStore & { client: XcpcClient };
  /** 模拟榜单只走文件缓存、不进 anvil.db（docs/contracts/16 §3），客户端同样可注入 */
  arena: ArenaClient;
  /** 工坊（docs/contracts/23）：受管工作区 / 对象 / 标签，索引在内存、元数据在磁盘 */
  work: WorkService;
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

export function buildStatus(
  db: DatabaseSync,
  handles: Record<SyncSourceId, string>,
  xcpc: XcpcStore,
  now = Date.now(),
  configWarning: string | null = null,
): StatusDto {
  const cf = sourceStatus(db, 'cf', handles.cf, now);
  const at = sourceStatus(db, 'at', handles.at, now);
  // 顶层四字段 = CF 源原样镜像，切片 1 的调用方不用改（docs/contracts/09 §4）
  return {
    configured: cf.configured,
    handle: cf.handle,
    lastSyncAt: cf.lastSyncAt,
    counts: cf.counts,
    sources: { cf, at },
    xcpc: xcpcStatus(xcpc, now),
    ...(configWarning === null ? {} : { configWarning }),
  };
}

/**
 * XCPC 的错误分派：查无此档 404、上游不在线 502、正在忙 409（docs/contracts/14 §4）。
 * `detail` 是路径 / key / 主机名这类开发信息，留在错误对象里供日志用，不进界面文案。
 */
function sendXcpcError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof XcpcError) {
    const code = err.kind === 'not-found' ? 404 : err.kind === 'busy' ? 409 : 502;
    return reply.code(code).send({ error: { kind: err.kind, message: err.message } });
  }
  return reply.code(502).send({ error: { kind: 'unavailable', message: `拉取失败：${String(err)}` } });
}

/** arena 的错误分派：路径非法 400，上游没有这份榜 404，取不到且无缓存 502（docs/contracts/16 §2.2） */
function sendArenaError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ArenaError) {
    const code = err.kind === 'invalid' ? 400 : err.kind === 'not-found' ? 404 : 502;
    return reply.code(code).send({ error: { kind: err.kind, message: err.message } });
  }
  return reply.code(502).send({ error: { kind: 'unavailable', message: `取不到：${String(err)}` } });
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** 写接口跨站防护（docs/contracts/23 §10）：只认 JSON 请求体 + 本机 Origin；不是身份认证 */
function registerWriteGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || !WRITE_METHODS.has(request.method)) return;
    const mediaType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return reply.code(415).send({ error: { kind: 'unsupported-media-type', message: '写接口只接受 application/json' } });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return reply.code(403).send({ error: { kind: 'forbidden', message: '跨站请求已拒绝' } });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: { kind: 'forbidden', message: '跨站请求已拒绝' } });
    }
  });
}

export function registerApi(app: FastifyInstance, ctx: ApiContext): void {
  registerWriteGuard(app);
  registerWorkRoutes(app, ctx.work);

  app.get('/api/status', async () => buildStatus(ctx.db, ctx.getHandles(), ctx.xcpc, Date.now(), configWarningOf()));

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
    return buildStatus(
      ctx.db,
      { cf: saved.cfHandle ?? handles.cf, at: saved.atHandle ?? handles.at },
      ctx.xcpc,
      Date.now(),
      configWarningOf(),
    );
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

  /* ---- XCPC（docs/contracts/14 §4）：认领制，不进 /api/sync runner ---- */

  app.get('/api/xcpc', async (_request, reply) => {
    const profile = xcpcProfile(ctx.xcpc);
    if (profile === null) {
      return reply.code(404).send({ error: { kind: 'unclaimed', message: '还没有认领 XCPC 选手档案' } });
    }
    return profile;
  });

  app.get('/api/xcpc/search', async (request, reply) => {
    const parsed = xcpcQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { kind: 'invalid', message: '搜索词太长了' } });
    }
    try {
      return { results: await ctx.xcpc.client.search(parsed.data.q) };
    } catch (err) {
      return sendXcpcError(reply, err);
    }
  });

  app.post('/api/xcpc/claim', async (request, reply) => {
    const parsed = xcpcClaimBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { kind: 'invalid', message: parsed.error.issues[0]?.message ?? 'key 不合法' } });
    }
    try {
      return await claimXcpc(ctx.xcpc, ctx.xcpc.client, parsed.data.key);
    } catch (err) {
      return sendXcpcError(reply, err);
    }
  });

  app.post('/api/xcpc/refresh', async (_request, reply) => {
    if (ctx.xcpc.getKey() === '') {
      return reply
        .code(400)
        .send({ error: { kind: 'invalid', message: '还没有认领 XCPC 档案，认领后才能拉快照' } });
    }
    try {
      return await refreshXcpc(ctx.xcpc, ctx.xcpc.client);
    } catch (err) {
      return sendXcpcError(reply, err);
    }
  });

  /* ---- 模拟榜单（docs/contracts/16 §2.2）：目录与单场都经服务端代理 + vault/arena/ 文件缓存 ---- */

  app.get('/api/arena/catalog', async (request, reply) => {
    const refresh = (request.query as { refresh?: string }).refresh === '1';
    try {
      return await ctx.arena.catalog(refresh);
    } catch (err) {
      return sendArenaError(reply, err);
    }
  });

  app.get('/api/arena/contest', async (request, reply) => {
    const parsed = arenaContestQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { kind: 'invalid', message: '缺少榜单路径' } });
    }
    try {
      return await ctx.arena.contest(parsed.data.path, parsed.data.refresh === '1');
    } catch (err) {
      return sendArenaError(reply, err);
    }
  });

  app.get('/api/dashboard', async (request, reply) => {
    const parsed = dashboardQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { kind: 'invalid', message: 'source 只能是 cf、at 或 xcpc' } });
    }
    if (parsed.data.source === 'xcpc') {
      return reply
        .code(501)
        .send({ error: { kind: 'not-implemented', message: 'XCPC 没有提交粒度 · 档案走 /api/xcpc（docs/contracts/14）' } });
    }
    return buildDashboard(ctx.db, parsed.data.source);
  });
}
