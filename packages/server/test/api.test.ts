import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { SyncStateDto } from '@anvil/shared';
import { STALE_AFTER_SECONDS, registerApi } from '../src/api.ts';
import { ArenaClient } from '../src/arena.ts';
import {
  handleMetaKey,
  initSchema,
  insertSubmissions,
  setMeta,
  setSyncState,
  syncKey,
  upsertRatingHistory,
} from '../src/db.ts';
import type { CheckResult, SyncSource } from '../src/sync/source.ts';
import { XcpcClient } from '../src/sync/xcpc.ts';
import { initSnapshot } from '../src/sync/runner.ts';

// 这几条断言走 /api/status（buildStatus 默认 now = 真实时钟）：种子数据的「上次同步」必须跟着
// 现在走 —— 钉成常量 = 日历炸弹，三天后 ok 断言整片自坏（2026-10-09 实测到期）
const NOW = Math.floor(Date.now() / 1000);
const subRow = (id: number, key: string) => ({
  id,
  contestId: null,
  problemKey: key,
  problemName: null,
  problemRating: null,
  problemTagsJson: null,
  verdict: 'OK',
  language: 'C++20',
  participantType: null,
  createdTs: NOW,
  relativeTs: null,
});

const DONE: SyncStateDto = { phase: 'done', fetched: 1, stored: 1, total: 1, problems: 1, ratingContests: 1 };

interface Stub {
  source: SyncSource;
  checks: string[];
  syncs: string[];
  /** 让 sync 挂住，用来演「该源正在跑，别换 handle」 */
  release: () => void;
}

function makeStub(id: 'cf' | 'at', check: CheckResult, hang: boolean): Stub {
  let release = (): void => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub: Stub = {
    checks: [],
    syncs: [],
    release,
    source: {
      id,
      checkHandle: async (handle: string) => {
        stub.checks.push(handle);
        return check;
      },
      sync: async (handle: string) => {
        stub.syncs.push(handle);
        if (hang) await pending;
        return { ...DONE };
      },
    },
  };
  return stub;
}

let db: DatabaseSync;
let app: FastifyInstance;
let handles: { cf: string; at: string };
let cf: Stub;
let at: Stub;
let xcpcKey: string;

/** 单测禁止打真实网络（技术锁）：API 测试不碰 XCPC 取数，客户端只当占位 */
const offlineFetch = (async () => {
  throw new Error('单测不该出网');
}) as unknown as typeof fetch;

async function boot(opts: {
  handles?: { cf: string; at: string };
  cfCheck?: CheckResult;
  atCheck?: CheckResult;
  hangAt?: boolean;
  xcpcKey?: string;
} = {}): Promise<void> {
  db = new DatabaseSync(':memory:');
  initSchema(db);
  handles = opts.handles ?? { cf: '', at: '' };
  xcpcKey = opts.xcpcKey ?? '';
  cf = makeStub('cf', opts.cfCheck ?? { ok: true }, false);
  at = makeStub('at', opts.atCheck ?? { ok: true }, opts.hangAt ?? false);
  app = Fastify();
  registerApi(app, {
    db,
    sources: { cf: cf.source, at: at.source },
    getHandles: () => ({ ...handles }),
    setHandles: (patch) => {
      if (patch.cfHandle !== undefined) handles.cf = patch.cfHandle;
      if (patch.atHandle !== undefined) handles.at = patch.atHandle;
    },
    xcpc: {
      db,
      getKey: () => xcpcKey,
      setKey: (key) => {
        xcpcKey = key;
      },
      client: new XcpcClient({ fetchImpl: offlineFetch }),
    },
    // arena 只在这几条路由测试里才真的取数；其余用例注入离网客户端，永不触网
    arena: new ArenaClient({ fetchImpl: offlineFetch, dir: join(tmpdir(), 'anvil-arena-api-test') }),
  });
  // 与 index.ts 一样：进程起来先把两源快照对齐到库里的读数
  initSnapshot(db);
  await app.ready();
}

const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string, body?: unknown) => app.inject({ method: 'POST', url, payload: body ?? {} });

/** 起跑中的同步放掉之后，等 runner 的 finally 真的把 running 清干净 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('GET /api/status', () => {
  it('顶层保持切片 1 兼容，另加 sources 两路', async () => {
    await boot();
    const body = (await get('/api/status')).json();
    expect(body).toMatchObject({ configured: false, handle: null, lastSyncAt: null });
    expect(Object.keys(body.sources).sort()).toEqual(['at', 'cf']);
    expect(body.sources.cf).toMatchObject({ configured: false, status: 'idle', rating: null });
    expect(body.sources.at).toMatchObject({ configured: false, status: 'idle', rating: null });
    expect(body.sources.cf.counts).toEqual({ submissions: 0, problems: 0 });
    db.close();
  });

  it('配好 handle 后带出本源计数、当前 rating 与 ok；没同步过的是 idle', async () => {
    await boot({ handles: { cf: 'jywlq', at: '' } });
    insertSubmissions(db, 'cf', [subRow(1, 'cf:2268:A'), subRow(2, 'cf:2268:B')]);
    upsertRatingHistory(db, 'cf', [
      { contestKey: '2268', contestName: 'Round', rank: 5, oldRating: 1400, newRating: 1683, isRated: true, performance: null, updatedTs: NOW },
    ]);
    setSyncState(db, syncKey('cf', 'last_sync_at'), String(NOW));
    const body = (await get('/api/status')).json();
    expect(body.sources.cf).toMatchObject({ configured: true, handle: 'jywlq', status: 'ok', rating: 1683 });
    expect(body.sources.cf.counts).toEqual({ submissions: 2, problems: 2 });
    // 顶层 = CF 镜像
    expect(body).toMatchObject({ configured: true, handle: 'jywlq', counts: { submissions: 2, problems: 2 } });
    expect(body.sources.at.status).toBe('idle');
    db.close();
  });

  it('缓存过期 = stale；最近一次失败 = down；两源各算各的', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    setSyncState(db, syncKey('cf', 'last_sync_at'), String(NOW - STALE_AFTER_SECONDS - 60));
    setSyncState(db, syncKey('at', 'last_sync_at'), String(NOW - 60));
    setSyncState(db, syncKey('at', 'last_error'), 'AtCoder Problems 暂不可达（503）');
    const body = (await get('/api/status')).json();
    expect(body.sources.cf.status).toBe('stale');
    expect(body.sources.at.status).toBe('down');
    expect(body.sources.at.error).toContain('503');
    expect(body.sources.cf.error).toBeNull();
    db.close();
  });

  it('成功后清掉旧的失败原因：last_error 空串不算 down', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    setSyncState(db, syncKey('cf', 'last_sync_at'), String(NOW));
    setSyncState(db, syncKey('cf', 'last_error'), '');
    const body = (await get('/api/status')).json();
    expect(body.sources.cf.status).toBe('ok');
    expect(body.sources.cf.error).toBeNull();
    db.close();
  });

  it('非 rated 场不充当 tab 上的当前 rating', async () => {
    await boot({ handles: { cf: '', at: 'chokudai' } });
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc300', contestName: 'ABC 300', rank: 1, oldRating: 1345, newRating: 1345, isRated: false, performance: null, updatedTs: NOW },
      { contestKey: 'abc299', contestName: 'ABC 299', rank: 1, oldRating: 1200, newRating: 1345, isRated: true, performance: 1400, updatedTs: NOW - 86400 },
    ]);
    setSyncState(db, syncKey('at', 'last_sync_at'), String(NOW));
    const body = (await get('/api/status')).json();
    expect(body.sources.at.rating).toBe(1345);
    expect(body.sources.cf.rating).toBeNull();
    db.close();
  });
});

describe('POST /api/config 分源校验', () => {
  it('只带 atHandle：只打 AT 的校验，不碰 CF', async () => {
    await boot({ handles: { cf: 'jywlq', at: '' } });
    const res = await post('/api/config', { atHandle: 'chokudai' });
    expect(res.statusCode).toBe(200);
    expect(at.checks).toEqual(['chokudai']);
    expect(cf.checks).toEqual([]);
    expect(handles).toEqual({ cf: 'jywlq', at: 'chokudai' });
    expect(res.json().sources.at.configured).toBe(true);
    db.close();
  });

  it('两个都带：各校验各的，各自落自己的键', async () => {
    await boot();
    const res = await post('/api/config', { cfHandle: 'jywlq', atHandle: 'chokudai' });
    expect(res.statusCode).toBe(200);
    expect(cf.checks).toEqual(['jywlq']);
    expect(at.checks).toEqual(['chokudai']);
    expect(handles).toEqual({ cf: 'jywlq', at: 'chokudai' });
    db.close();
  });

  it('handle 没变就不再打上游（省一次请求，也别把「没改」当成校验）', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    const res = await post('/api/config', { cfHandle: 'jywlq' });
    expect(res.statusCode).toBe(200);
    expect(cf.checks).toEqual([]);
    db.close();
  });

  it('AT 说没有这个人 → 404 + not-found；CF 不受影响', async () => {
    await boot({ handles: { cf: 'jywlq', at: '' }, atCheck: { ok: false, kind: 'not-found', message: 'AtCoder 上没有这个 handle（页面 404）' } });
    const res = await post('/api/config', { atHandle: 'ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ kind: 'not-found' });
    expect(handles.at).toBe('');
    expect(handles.cf).toBe('jywlq');
    db.close();
  });

  it('上游不在线 → 502 unavailable', async () => {
    await boot({ atCheck: { ok: false, kind: 'unavailable', message: '已退避重试 2 次' } });
    const res = await post('/api/config', { atHandle: 'chokudai' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe('unavailable');
    db.close();
  });

  it('空 body / 非法字符 → 400，且不打上游', async () => {
    await boot();
    expect((await post('/api/config', {})).statusCode).toBe(400);
    expect((await post('/api/config', { atHandle: 'a b' })).statusCode).toBe(400);
    expect((await post('/api/config', { atHandle: '' })).statusCode).toBe(400);
    expect(at.checks).toEqual([]);
    db.close();
  });

  it('AT 的宽松字符集：点与连字符放过（CF 那侧仍然只许字母数字下划线）', async () => {
    await boot();
    expect((await post('/api/config', { atHandle: 'a-b_c.1' })).statusCode).toBe(200);
    expect((await post('/api/config', { cfHandle: 'a-b' })).statusCode).toBe(400);
    db.close();
  });

  it('某源正在同步 → 只有换那个源的 handle 被挡（409），另一源照改', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' }, hangAt: true });
    await post('/api/sync', { source: 'at' });
    const blocked = await post('/api/config', { atHandle: 'someoneElse' });
    expect(blocked.statusCode).toBe(409);
    const allowed = await post('/api/config', { cfHandle: 'Benq' });
    expect(allowed.statusCode).toBe(200);
    at.release();
    await flush();
    db.close();
  });
});

describe('POST /api/sync 按源起跑', () => {
  it('缺省同步 CF；带 source 同步那个源；返回两源快照', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    const res = await post('/api/sync');
    expect(res.statusCode).toBe(202);
    expect(cf.syncs).toEqual(['jywlq']);
    expect(Object.keys(res.json()).sort()).toEqual(['at', 'cf']);

    const atRes = await post('/api/sync', { source: 'at' });
    expect(atRes.statusCode).toBe(202);
    expect(at.syncs).toEqual(['chokudai']);
    db.close();
  });

  it('那个源没配 handle → 400，说清楚是哪家', async () => {
    await boot({ handles: { cf: 'jywlq', at: '' } });
    const res = await post('/api/sync', { source: 'at' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('AtCoder');
    expect(at.syncs).toEqual([]);
    db.close();
  });

  it('source 乱给 → 400', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    expect((await post('/api/sync', { source: 'xcpc' })).statusCode).toBe(400);
    db.close();
  });

  it('起跑后 /api/sync/state 分源给进度，AT 那侧不带 pages / offsite', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' }, hangAt: true });
    await post('/api/sync', { source: 'at' });
    const state = (await get('/api/sync/state')).json();
    expect(state.at.phase).toBe('fetching');
    expect('pages' in state.at).toBe(false);
    expect('offsite' in state.at).toBe(false);
    expect(state.cf.phase).toBe('idle');
    at.release();
    await flush();
    db.close();
  });
});

describe('GET /api/dashboard 按源寻址', () => {
  it('缺省给 CF，?source=at 给 AT', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    insertSubmissions(db, 'cf', [subRow(1, 'cf:2268:A')]);
    insertSubmissions(db, 'at', [subRow(1, 'at:abc300_a')]);
    const cfBody = (await get('/api/dashboard')).json();
    const atBody = (await get('/api/dashboard?source=at')).json();
    expect(cfBody.stats.totalSolved).toBe(1);
    expect(atBody.stats.totalSolved).toBe(1);
    expect(cfBody.stats.entryCount).toBeUndefined();
    expect(atBody.rating).toBeNull();
    db.close();
  });

  it('XCPC 不做仪表盘聚合：档案走 /api/xcpc，这里给 501', async () => {
    await boot();
    const res = await get('/api/dashboard?source=xcpc');
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatchObject({ kind: 'not-implemented' });
    expect(res.json().error.message).toContain('/api/xcpc');
    db.close();
  });

  it('source 乱给 → 400', async () => {
    await boot();
    expect((await get('/api/dashboard?source=luogu')).statusCode).toBe(400);
    db.close();
  });
});

describe('换 handle 后的归属', () => {
  it('CF 的归属标记不写进 AT 那侧', async () => {
    await boot({ handles: { cf: 'jywlq', at: 'chokudai' } });
    setMeta(db, handleMetaKey('cf'), 'jywlq');
    const body = (await get('/api/status')).json();
    expect(body.sources.at.configured).toBe(true);
    expect(body.sources.at.handle).toBe('chokudai');
    db.close();
  });
});
