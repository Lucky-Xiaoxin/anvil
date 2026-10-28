import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
let exitFailCmds: Set<string>;
let codePath: string | null;

function fakeSpawn(cmd: string, args: string[], opts: { shell: boolean }): SpawnLike {
  spawnCalls.push({ cmd, args, shell: opts.shell });
  let spawnCb: (() => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  queueMicrotask(() => {
    if (failingCmds.has(cmd)) {
      errorCb?.(new Error('ENOENT'));
      return;
    }
    spawnCb?.();
    queueMicrotask(() => exitCb?.(exitFailCmds.has(cmd) ? 1 : 0, null));
  });
  return {
    on(
      event: 'error' | 'spawn' | 'exit',
      cb: ((err: Error) => void) | (() => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
    ): unknown {
      if (event === 'spawn') spawnCb = cb as () => void;
      else if (event === 'error') errorCb = cb as (err: Error) => void;
      else exitCb = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
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
  exitFailCmds = new Set();
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
    importLimits: { maxFiles: 3 },
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

  it('回收站清空：只删应用条目、不可恢复、不误伤杂项、空站幂等', async () => {
    await boot();
    await initApi();
    const note = await create('note', 'Temp');
    let res = await post('/api/work/trash', { id: note.id });
    expect(res.statusCode, res.body).toBe(200);
    writeFileSync(join(root, '.anvil', 'trash', 'keep.txt'), 'not mine');
    mkdirSync(join(root, '.anvil', 'trash', 'keep-dir'), { recursive: true });
    writeFileSync(join(root, '.anvil', 'trash', 'keep-dir', 'note.txt'), 'not mine either');
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'trash.json'), '{"schema":1}');
    let linked = true;
    try {
      symlinkSync(outside, join(root, '.anvil', 'trash', 'linked'), 'junction');
    } catch {
      linked = false;
    }

    res = await post('/api/work/trash/purge', { confirm: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ removed: 1 });

    const tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    expect(tree.trash).toEqual([]);
    const kept = ['keep-dir', 'keep.txt', ...(linked ? ['linked'] : [])];
    expect(readdirSync(join(root, '.anvil', 'trash')).sort()).toEqual(kept.sort());
    expect(readFileSync(join(root, '.anvil', 'trash', 'keep-dir', 'note.txt'), 'utf8')).toBe('not mine either');
    if (linked) {
      expect(existsSync(join(outside, 'trash.json'))).toBe(true);
    }

    res = await post('/api/work/restore', { id: note.id });
    expect(res.statusCode).toBe(404);

    res = await post('/api/work/trash/purge', { confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 0 });
  });

  it('回收站清空：缺 confirm 不执行，条目仍在', async () => {
    await boot();
    await initApi();
    const note = await create('note', 'Temp');
    expect((await post('/api/work/trash', { id: note.id })).statusCode).toBe(200);

    for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
      const res = await post('/api/work/trash/purge', body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.kind).toBe('invalid');
    }

    const tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    expect(tree.trash).toHaveLength(1);
  });

  it('写接口跨站防护：非本机 Origin / cross-site 拒绝，错 content-type 拒绝，GET 与本机 Origin 放行', async () => {
    await boot();
    await initApi();
    const note = await create('note', 'Temp');
    expect((await post('/api/work/trash', { id: note.id })).statusCode).toBe(200);

    const json = { 'content-type': 'application/json' };
    let res = await app.inject({
      method: 'POST',
      url: '/api/work/trash/purge',
      payload: { confirm: true },
      headers: { ...json, origin: 'https://evil.example' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.kind).toBe('forbidden');

    res = await app.inject({
      method: 'POST',
      url: '/api/work/trash/purge',
      payload: { confirm: true },
      headers: { ...json, 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode, res.body).toBe(403);

    res = await app.inject({
      method: 'POST',
      url: '/api/work/trash/purge',
      payload: 'confirm=true',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode, res.body).toBe(415);
    expect(res.json().error.kind).toBe('unsupported-media-type');

    // 写接口是全局防护，不是只护清空
    res = await app.inject({
      method: 'POST',
      url: '/api/work/rescan',
      payload: {},
      headers: { ...json, origin: 'https://evil.example' },
    });
    expect(res.statusCode, res.body).toBe(403);

    res = await app.inject({
      method: 'POST',
      url: '/api/work/rescan',
      payload: {},
      headers: { ...json, origin: 'http://127.0.0.1:5173' },
    });
    expect(res.statusCode, res.body).toBe(200);

    res = await app.inject({ method: 'GET', url: '/api/work/tree', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode, res.body).toBe(200);

    const tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    expect(tree.trash).toHaveLength(1);
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

    res = await post('/api/work/open', { id, app: 'vscode' });
    expect(res.statusCode, res.body).toBe(204);
    expect(spawnCalls.at(-1)?.cmd).toBe('C:\\Code.exe');
    expect(spawnCalls.at(-1)?.args).toEqual(['--new-window', join(root, problem.relPath)]);

    failingCmds.add('C:\\Code.exe');
    const before = spawnCalls.length;
    res = await post('/api/work/open', { id, app: 'vscode' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe('editor-unavailable');
    expect(spawnCalls.length).toBe(before + 1);
    expect(spawnCalls.at(-1)?.cmd).toBe('C:\\Code.exe');

    failingCmds.clear();
    exitFailCmds.add('C:\\Code.exe');
    res = await post('/api/work/open', { id, app: 'vscode' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe('editor-unavailable');
    exitFailCmds.clear();
    res = await post('/api/work/open', { id, app: 'explorer' });
    expect(res.statusCode, res.body).toBe(204);
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');

    failingCmds.add('explorer.exe');
    res = await post('/api/work/open', { id, app: 'explorer' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe('editor-unavailable');

    failingCmds.clear();
    res = await post('/api/work/open', { id, app: 'bogus' });
    expect(res.statusCode).toBe(400);
    res = await post('/api/work/open', { id, relPath: '../x', app: 'vscode' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('unsafe-path');
  });

  it('import：scan / commit / 非法源 / 超限 / 过期 plan / 源变化 / 选择非法', async () => {
    await boot();
    await initApi();
    const src = join(base, 'old-code');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'alpha.cpp'), 'int main() {}');
    writeFileSync(join(src, 'alpha.in'), '1');

    let res = await post('/api/work/import/scan', { sourceRoot: src });
    expect(res.statusCode, res.body).toBe(200);
    const plan = res.json();
    expect(plan.items).toHaveLength(1);
    expect(plan.totals.files).toBe(2);
    expect(plan.items[0].shape).toBe('contest-group');
    expect(plan.items[0].files).toBe(2);
    expect(plan.items[0].selectedByDefault).toBe(true);

    res = await post('/api/work/import/commit', {
      planId: plan.planId,
      items: [{ itemId: plan.items[0].itemId, selected: true }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json();
    expect(result.units).toHaveLength(1);
    expect(result.units[0].status).toBe('success');
    expect(result.manifestRelPath).toMatch(/^\.anvil\/imports\//);
    expect(result.units[0].objects).toHaveLength(1);
    const tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    expect(tree.objects).toHaveLength(1);
    // 5a-4：导入生成 problemset（契约 26 §4.3）
    expect(tree.objects[0].kind).toBe('problemset');

    res = await post('/api/work/import/commit', {
      planId: plan.planId,
      items: [{ itemId: plan.items[0].itemId, selected: true }],
    });
    expect(res.json()).toEqual(result);

    res = await post('/api/work/import/scan', { sourceRoot: 'relative/path' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('import-source-invalid');

    const tooMany = join(base, 'too-many');
    mkdirSync(tooMany, { recursive: true });
    for (let i = 0; i < 4; i += 1) writeFileSync(join(tooMany, `p${i}.cpp`), 'x');
    res = await post('/api/work/import/scan', { sourceRoot: tooMany });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('import-limit');

    res = await post('/api/work/import/commit', { planId: 'missing-plan', items: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('import-plan-expired');

    const changing = join(base, 'changing');
    mkdirSync(changing, { recursive: true });
    writeFileSync(join(changing, 'beta.cpp'), 'v1');
    res = await post('/api/work/import/scan', { sourceRoot: changing });
    const changingPlan = res.json();
    writeFileSync(join(changing, 'beta.cpp'), 'v2');
    res = await post('/api/work/import/commit', {
      planId: changingPlan.planId,
      items: [{ itemId: changingPlan.items[0].itemId, selected: true }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().units[0].status).toBe('failed');
    expect(res.json().units[0].error.kind).toBe('import-source-changed');

    res = await post('/api/work/import/scan', { sourceRoot: changing });
    const invalidPlan = res.json();
    res = await post('/api/work/import/commit', {
      planId: invalidPlan.planId,
      items: [{ itemId: 'item_999', selected: true }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('import-conflict');
  });

  it('import 5a-3：多候选 / 多单元 / sourcePath DTO / 父子选择冲突', async () => {
    await boot();
    await initApi();
    const src = join(base, 'batch-code');
    mkdirSync(join(src, '2026', 'jan'), { recursive: true });
    mkdirSync(join(src, '2026', 'feb'), { recursive: true });
    writeFileSync(join(src, '2026', 'jan', 'A.cpp'), 'int a;');
    writeFileSync(join(src, '2026', 'feb', 'B.cpp'), 'int b;');

    let res = await post('/api/work/import/scan', { sourceRoot: src });
    expect(res.statusCode, res.body).toBe(200);
    const plan = res.json();
    const leaves = plan.items.filter(
      (item: { scope: string; isContainer: boolean; selectedByDefault: boolean }) =>
        item.scope === 'subtree' && !item.isContainer && item.selectedByDefault,
    );
    expect(leaves.map((item: { sourceRelPath: string }) => item.sourceRelPath).sort()).toEqual(['2026/feb', '2026/jan']);
    expect(leaves.every((item: { sourceCount: number }) => item.sourceCount === 1)).toBe(true);
    expect(plan.items.some((item: { isContainer: boolean }) => item.isContainer)).toBe(true);

    res = await post('/api/work/import/commit', {
      planId: plan.planId,
      items: plan.items.map((item: { itemId: string; selectedByDefault: boolean }) => ({
        itemId: item.itemId,
        selected: item.selectedByDefault,
      })),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().units.filter((unit: { status: string }) => unit.status === 'success')).toHaveLength(2);

    const tree = (await app.inject({ method: 'GET', url: '/api/work/tree' })).json();
    const contests = tree.objects.filter((obj: { kind: string }) => obj.kind === 'problemset');
    expect(contests.map((obj: { sourcePath: string }) => obj.sourcePath).sort()).toEqual(['2026/feb', '2026/jan']);

    const conflictPlan = (await post('/api/work/import/scan', { sourceRoot: src })).json();
    const container = conflictPlan.items.find(
      (item: { sourceRelPath: string; scope: string }) => item.sourceRelPath === '2026' && item.scope === 'subtree',
    );
    const leaf = conflictPlan.items.find(
      (item: { sourceRelPath: string; scope: string }) => item.sourceRelPath === '2026/jan' && item.scope === 'subtree',
    );
    expect(container).toBeDefined();
    expect(leaf).toBeDefined();
    res = await post('/api/work/import/commit', {
      planId: conflictPlan.planId,
      items: [
        { itemId: container!.itemId, selected: true },
        { itemId: leaf!.itemId, selected: true },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('import-conflict');
  });

  it('template：读空文件 / 保存 / 冲突 / 非模板拒绝 / 新建题目自动复制默认模板', async () => {
    await boot();
    await initApi();
    const template = await create('template', 'DSU', { topId: 'ds' });

    let res = await app.inject({ method: 'GET', url: `/api/work/template?id=${template.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ path: 'template.cpp', exists: false, content: '', revision: null });

    res = await post('/api/work/template', { id: template.id, content: 'int main() {}\n', baseRevision: null });
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json();
    expect(saved).toMatchObject({ path: 'template.cpp', exists: true, content: 'int main() {}\n' });
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);

    res = await post('/api/work/template', { id: template.id, content: 'stale\n', baseRevision: null });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('conflict');

    const problem = await create('problem', 'Auto Template');
    res = await app.inject({ method: 'GET', url: `/api/work/object?id=${problem.id}` });
    expect(res.json().files.some((f: { path: string }) => f.path === 'solution.cpp')).toBe(true);

    res = await app.inject({ method: 'GET', url: `/api/work/template?id=${problem.id}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('invalid');
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

  it('题组 API：create / adopt / update 的 kind 与 parentId 校验；关联 / 清除（契约 26 §9.3；0..n 见契约 27）', async () => {
    await boot();
    await initApi();
    const contest = await create('contest', 'Shanghai');

    // create 带关联；arenaPath 拒绝
    let res = await post('/api/work/create', { kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    expect(res.statusCode, res.body).toBe(200);
    const set = res.json();
    expect(set.kind).toBe('problemset');
    expect(set.parentId).toBe(contest.id);
    res = await post('/api/work/create', { kind: 'problemset', title: 'Bad', arenaPath: 'official/icpc/x/y.srk.json' });
    expect(res.statusCode).toBe(400);

    // adopt：明确登记为题组；同一比赛可以被第二个题组关联（0..n）
    const dir = join(root, 'practice', '2026-10', 'adopted');
    mkdirSync(dir, { recursive: true });
    res = await post('/api/work/adopt', { relPath: 'practice/2026-10/adopted', kind: 'problemset', title: 'Adopted', parentId: contest.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().kind).toBe('problemset');
    expect(res.json().parentId).toBe(contest.id);

    // update 清除 / 再关联；非题组拒绝
    res = await post('/api/work/update', { id: contest.id, parentId: null });
    expect(res.statusCode).toBe(400);
    res = await post('/api/work/update', { id: set.id, parentId: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().parentId).toBeNull();
    res = await post('/api/work/update', { id: set.id, parentId: contest.id });
    expect(res.statusCode, res.body).toBe(200); // 0..n：不再看占用
    expect(res.json().parentId).toBe(contest.id);
  });

  it('归档冻结 API：归档对象 retitle / tags / labels / parentId / trash 全拒绝，取消归档是唯一写操作（契约 27 §4）', async () => {
    await boot();
    await initApi();
    const contest = await create('contest', 'Shanghai');
    const set = await create('problemset', 'TreeDP', { parentId: contest.id });
    let res = await post('/api/work/update', { id: set.id, archived: true });
    expect(res.statusCode, res.body).toBe(200);

    res = await post('/api/work/update', { id: set.id, title: 'Renamed' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('conflict');
    res = await post('/api/work/update', { id: set.id, tags: { primary: null, related: [] } });
    expect(res.statusCode).toBe(409);
    res = await post('/api/work/update', { id: set.id, labels: ['x'] });
    expect(res.statusCode).toBe(409);
    res = await post('/api/work/update', { id: set.id, parentId: null });
    expect(res.statusCode).toBe(409);
    res = await post('/api/work/trash', { id: set.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('conflict');

    // 活动比赛被归档后，不能再被关联（跨归档不可编辑）：与冻结 / 回收同一口径，409 conflict
    res = await post('/api/work/update', { id: contest.id, archived: true });
    expect(res.statusCode).toBe(200);
    res = await post('/api/work/create', { kind: 'problemset', title: 'Blocked', parentId: contest.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('conflict');

    // 取消归档后可编辑
    res = await post('/api/work/update', { id: set.id, archived: false });
    expect(res.statusCode, res.body).toBe(200);
    res = await post('/api/work/update', { id: set.id, title: 'Renamed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().title).toBe('Renamed');
  });
});
