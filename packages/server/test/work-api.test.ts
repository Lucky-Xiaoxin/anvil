import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { registerApi } from '../src/api.ts';
import { ArenaClient } from '../src/arena.ts';
import { initSchema } from '../src/db.ts';
import { XcpcClient } from '../src/sync/xcpc.ts';
import type { SpawnFn, SpawnLike } from '../src/work/open.ts';
import { WorkService } from '../src/work/store.ts';

const offlineFetch = (async () => {
  throw new Error('单测不该出网');
}) as unknown as typeof fetch;

const DONE = { phase: 'done' as const, fetched: 0, stored: 0, total: 0, problems: 0, ratingContests: 0 };

let base: string;
let root: string;
let configRoot: string;
let db: DatabaseSync;
let app: FastifyInstance;
let spawnCalls: { cmd: string; args: string[]; shell: boolean }[];
let failingCmds: Set<string>;
let codePath: string | null;

function fakeSpawn(cmd: string, args: string[], opts: { shell: boolean }): SpawnLike {
  spawnCalls.push({ cmd, args, shell: opts.shell });
  let spawnCb: (() => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  queueMicrotask(() => {
    if (failingCmds.has(cmd)) errorCb?.(new Error('ENOENT'));
    else spawnCb?.();
  });
  return {
    on(event: 'error' | 'spawn', cb: ((err: Error) => void) | (() => void)): unknown {
      if (event === 'spawn') spawnCb = cb as () => void;
      else errorCb = cb as (err: Error) => void;
      return undefined;
    },
    unref: () => undefined,
  };
}

const spawnImpl: SpawnFn = (cmd, args, opts) => fakeSpawn(cmd, args, opts);

async function boot(): Promise<void> {
  db = new DatabaseSync(':memory:');
  initSchema(db);
  configRoot = '';
  spawnCalls = [];
  failingCmds = new Set();
  codePath = 'C:\\Code.exe';
  const work = new WorkService({
    db,
    getRoot: () => configRoot,
    setRoot: (p) => {
      configRoot = p;
    },
    now: () => new Date(2026, 9, 21, 12),
    repoRoot: join(base, 'repo'),
    vaultDir: join(base, 'vault'),
    findCode: () => codePath,
    spawn: spawnImpl,
  });
  app = Fastify();
  registerApi(app, {
    db,
    sources: {
      cf: { id: 'cf', checkHandle: async () => ({ ok: true }), sync: async () => DONE },
      at: { id: 'at', checkHandle: async () => ({ ok: true }), sync: async () => DONE },
    },
    getHandles: () => ({ cf: '', at: '' }),
    setHandles: () => undefined,
    xcpc: { db, getKey: () => '', setKey: () => undefined, client: new XcpcClient({ fetchImpl: offlineFetch }) },
    arena: new ArenaClient({ fetchImpl: offlineFetch, dir: join(tmpdir(), 'anvil-work-api-arena') }),
    work,
  });
  await app.ready();
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'anvil-work-api-'));
  root = join(base, 'root');
  mkdirSync(join(base, 'repo'));
  mkdirSync(join(base, 'vault'));
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json' } });

async function initApi(path = root, confirmExisting = false): Promise<void> {
  const res = await post('/api/work/init', { path, confirmExisting });
  expect(res.statusCode, res.body).toBe(200);
}

async function create(kind: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await post('/api/work/create', { kind, title, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe('工坊 API 状态机（契约 §9.2）', () => {
  it('未配置 / 未初始化 / 非法根 / 非空根确认', async () => {
    await boot();
    let res = await app.inject({ method: 'GET', url: '/api/work/tree' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('workspace-unconfigured');

    res = await post('/api/work/init', { path: 'relative/path' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('root-invalid');

    mkdirSync(root);
    configRoot = root;
    res = await app.inject({ method: 'GET', url: '/api/work/tree' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('workspace-uninitialized');

    const busy = join(base, 'busy');
    mkdirSync(busy);
    writeFileSync(join(busy, 'keep.txt'), 'keep');
    res = await post('/api/work/init', { path: busy });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('root-not-empty');
    expect(res.json().error.entries).toBe(1);
    res = await post('/api/work/init', { path: busy, confirmExisting: true });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('四类 create / tree / object / update / trash / restore / rescan', async () => {
    await boot();
    await initApi();
    const contest = await create('contest', 'Shanghai');
    const problem = await create('problem', 'Cherry Tree', { parentId: contest.id });
    await create('template', 'DSU', { topId: 'ds' });
    await create('note', 'Week 1');

    let tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    expect(tree.objects).toHaveLength(4);
    expect(tree.taxonomy.nodes).toHaveLength(13);

    let detail = (await app.inject({ method: 'GET', url: `/api/work/object?id=${problem.id}` })).json();
    expect(detail.files).toEqual([]);

    let res = await post('/api/work/update', { id: problem.id, tags: { primary: 'graph/tree', related: ['dp/tree-dp'] }, labels: ['赛时'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tags.primary).toBe('graph/tree');

    res = await post('/api/work/trash', { id: problem.id });
    expect(res.statusCode, res.body).toBe(200);
    tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    expect(tree.objects.some((o: { id: string }) => o.id === problem.id)).toBe(false);
    expect(tree.trash).toHaveLength(1);

    res = await post('/api/work/restore', { id: problem.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().id).toBe(problem.id);

    res = await post('/api/work/rescan', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ objects: 4, added: 0, removed: 0 }));
    detail = (await app.inject({ method: 'GET', url: `/api/work/object?id=${problem.id}` })).json();
    expect(detail.relPath).toBe('contests/2026-10-21_shanghai/cherry-tree');
  });

  it('adopt 与路径越界；未知对象 404；root-version', async () => {
    await boot();
    await initApi();
    mkdirSync(join(root, 'contests', 'manual'), { recursive: true });
    let res = await post('/api/work/adopt', { relPath: 'contests/manual', kind: 'contest', title: 'Manual' });
    expect(res.statusCode, res.body).toBe(200);
    res = await post('/api/work/adopt', { relPath: '../outside', kind: 'contest' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('unsafe-path');

    res = await app.inject({ method: 'GET', url: '/api/work/object?id=obj_0000000000' });
    expect(res.statusCode).toBe(404);

    writeFileSync(join(root, '.anvil', 'root.json'), JSON.stringify({ schema: 2, app: 'anvil' }));
    res = await app.inject({ method: 'GET', url: '/api/work/tree' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('root-version');
  });

  it('open：文件夹 explorer / 文件 code / 互相回退 / 都失败 502 / 越界 400', async () => {
    await boot();
    await initApi();
    const problem = await create('problem', 'Cherry Tree');
    writeFileSync(join(root, problem.relPath, 'solution.cpp'), 'x');
    const id = problem.id;

    let res = await post('/api/work/open', { id });
    expect(res.statusCode, res.body).toBe(204);
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');
    expect(spawnCalls.at(-1)?.args).toEqual([join(root, problem.relPath)]);
    expect(spawnCalls.at(-1)?.shell).toBe(false);

    res = await post('/api/work/open', { id, relPath: 'solution.cpp' });
    expect(res.statusCode, res.body).toBe(204);
    expect(spawnCalls.at(-1)?.cmd).toBe('C:\\Code.exe');

    failingCmds.add('C:\\Code.exe');
    res = await post('/api/work/open', { id, relPath: 'solution.cpp' });
    expect(res.statusCode, res.body).toBe(204);
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');
    expect(spawnCalls.at(-1)?.args[0]).toBe(`/select,${join(root, problem.relPath, 'solution.cpp')}`);

    failingCmds.add('explorer.exe');
    res = await post('/api/work/open', { id });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe('editor-unavailable');

    failingCmds.clear();
    res = await post('/api/work/open', { id, relPath: '../x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('unsafe-path');
  });

  it('arena-record：保存 / 读回 / 自动建 contest / 未知场次 404', async () => {
    await boot();
    await initApi();
    const arenaPath = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';
    let res = await post('/api/work/arena-record', {
      arenaPath,
      title: '上海站',
      ghost: { show: true, subs: [{ p: 0, t: 30, r: 'AC' }] },
      view: { mode: 'review', viewMs: 180000, paused: false, frozenView: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json();
    expect(saved.object.links.arenaPath).toBe(arenaPath);
    expect(saved.record.view.frozenView).toBe(true);

    res = await app.inject({ method: 'GET', url: `/api/work/arena-record?path=${encodeURIComponent(arenaPath)}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().ghost.subs).toHaveLength(1);

    res = await app.inject({ method: 'GET', url: `/api/work/arena-record?path=${encodeURIComponent('official/icpc/x/none.srk.json')}` });
    expect(res.statusCode).toBe(404);

    res = await post('/api/work/arena-record', {
      arenaPath: '../bad.srk.json',
      ghost: { show: true, subs: [] },
      view: { mode: 'review', viewMs: 0, paused: false, frozenView: false },
    });
    expect(res.statusCode).toBe(400);
  });
});
