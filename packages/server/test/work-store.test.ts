import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db.ts';
import type { SpawnFn, SpawnLike } from '../src/work/open.ts';
import { WorkService } from '../src/work/store.ts';

let base: string;
let root: string;
let repo: string;
let vault: string;
let configRoot: string;
let now: Date;
let db: DatabaseSync;
let service: WorkService;
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

function resetNow(): void {
  now = new Date(2026, 9, 21, 12, 0, 0);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'anvil-work-store-'));
  root = join(base, 'root');
  repo = join(base, 'repo');
  vault = join(base, 'vault');
  mkdirSync(repo);
  mkdirSync(vault);
  configRoot = '';
  resetNow();
  db = new DatabaseSync(':memory:');
  initSchema(db);
  spawnCalls = [];
  failingCmds = new Set();
  codePath = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
  service = new WorkService({
    db,
    getRoot: () => configRoot,
    setRoot: (p) => {
      configRoot = p;
    },
    now: () => now,
    repoRoot: repo,
    vaultDir: vault,
    findCode: () => codePath,
    spawn: spawnImpl,
  });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const absOf = (relPath: string): string => join(root, relPath);
const objByTitle = async (title: string, archived = false) => {
  const tree = await service.tree({ archived });
  const found = tree.objects.find((o) => o.title === title);
  if (found === undefined) throw new Error(`找不到对象：${title}`);
  return found;
};

async function initRoot(): Promise<void> {
  await service.init({ path: root });
}

describe('init / 根状态（契约 §3.2）', () => {
  it('未配置 / 未初始化 / 初始化幂等', async () => {
    await expect(service.tree()).rejects.toMatchObject({ kind: 'workspace-unconfigured' });

    configRoot = root;
    await expect(service.tree()).rejects.toMatchObject({ kind: 'root-missing' });
    mkdirSync(root);
    await expect(service.tree()).rejects.toMatchObject({ kind: 'workspace-uninitialized' });

    const tree = await service.init({ path: root });
    expect(tree.root).toBe(root);
    expect(tree.taxonomy?.nodes).toHaveLength(13);
    expect(existsSync(join(root, '.anvil', 'root.json'))).toBe(true);
    for (const dir of ['contests', 'practice', 'templates', 'notes']) expect(existsSync(join(root, dir)), dir).toBe(true);

    writeFileSync(join(root, '.anvil', 'taxonomy.json'), JSON.stringify({ schema: 1, version: 9, nodes: [], aliases: {} }));
    await service.init({ path: root });
    expect(JSON.parse(readFileSync(join(root, '.anvil', 'taxonomy.json'), 'utf8')).version).toBe(9);
  });

  it('非空根必须 confirmExisting，且只建 .anvil 不搬已有文件', async () => {
    const busy = join(base, 'busy');
    mkdirSync(busy);
    writeFileSync(join(busy, 'keep.txt'), 'keep');
    await expect(service.init({ path: busy })).rejects.toMatchObject({ kind: 'root-not-empty', entries: 1 });
    const tree = await service.init({ path: busy, confirmExisting: true });
    expect(tree.root).toBe(busy);
    expect(readFileSync(join(busy, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('root.json schema > 1 → root-version，不降级', async () => {
    await initRoot();
    writeFileSync(join(root, '.anvil', 'root.json'), JSON.stringify({ schema: 2, app: 'anvil' }));
    await expect(service.tree()).rejects.toMatchObject({ kind: 'root-version' });
    await expect(service.init({ path: root })).rejects.toMatchObject({ kind: 'root-version' });
  });
});

describe('四类对象与路径（契约 §4 / §5 / §6.1）', () => {
  it('创建四类对象、父子关系与 note.md', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree', parentId: contest.id });
    const template = await service.create({ kind: 'template', title: 'DSU', topId: 'ds' });
    const note = await service.create({ kind: 'note', title: 'Week 1' });

    expect(contest.relPath).toBe('contests/2026-10-21_shanghai');
    expect(problem.relPath).toBe('contests/2026-10-21_shanghai/cherry-tree');
    expect(problem.parentId).toBe(contest.id);
    expect(template.relPath).toBe('templates/ds/dsu');
    expect(note.relPath).toBe('notes/2026/10/2026-10-21_week-1');
    expect(existsSync(join(absOf(note.relPath), 'note.md'))).toBe(true);
    expect((await service.tree()).objects).toHaveLength(4);
  });

  it('problem 缺 title 时用 submissions.problem_name 补；查不到用 problemKey', async () => {
    await initRoot();
    db.prepare(
      `INSERT INTO submissions (source,id,contest_id,problem_key,problem_name,problem_rating,problem_tags_json,verdict,language,participant_type,created_ts,relative_ts)
       VALUES ('cf',1,NULL,'cf:2184:F','Cherry Tree',2400,NULL,'OK','C++20',NULL,0,NULL)`,
    ).run();
    const withName = await service.create({ kind: 'problem', problemKey: 'cf:2184:F' });
    expect(withName.title).toBe('Cherry Tree');
    const withoutName = await service.create({ kind: 'problem', problemKey: 'cf:9999:Z' });
    expect(withoutName.title).toBe('cf:9999:Z');
  });

  it('templateId 只复制 template.cpp / 第一个 .cpp 与 test.cpp', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'DSU', topId: 'ds' });
    const templateUrl = absOf(template.relPath);
    writeFileSync(join(templateUrl, 'template.cpp'), '// template');
    writeFileSync(join(templateUrl, 'test.cpp'), '// test');
    writeFileSync(join(templateUrl, 'notes.txt'), 'keep?');

    const problem = await service.create({ kind: 'problem', title: 'Template Use', templateId: template.id });
    const detail = service.object(problem.id);
    const paths = detail.files.map((f) => f.path);
    expect(paths).toContain('solution.cpp');
    expect(paths).toContain('test.cpp');
    expect(paths).not.toContain('notes.txt');
    expect(readFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'utf8')).toBe('// template');
  });

  it('同名冲突按 -2/-3 分配；arenaPath 走白名单', async () => {
    await initRoot();
    const a = await service.create({ kind: 'contest', title: 'Shanghai', arenaPath: 'official/icpc/x/y.srk.json' });
    const b = await service.create({ kind: 'contest', title: 'Shanghai' });
    expect(a.relPath).toBe('contests/2026-10-21_shanghai');
    expect(b.relPath).toBe('contests/2026-10-21_shanghai-2');
    expect(a.links.arenaPath).toBe('official/icpc/x/y.srk.json');
    await expect(service.create({ kind: 'contest', title: 'X', arenaPath: '../bad.srk.json' })).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('标签、计数、改标题、归档（契约 §6.3 / §6.4 / §6.5 / §7）', () => {
  it('primary 进树与一级父计数，related / labels 不计数', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree' });
    await service.update({
      id: problem.id,
      tags: { primary: 'graph/tree', related: ['dp/tree-dp'] },
      labels: ['#赛时', '没调出来'],
    });
    const tree = await service.tree();
    const graph = tree.taxonomy?.nodes.find((n) => n.id === 'graph');
    const graphTree = graph?.children?.find((n) => n.id === 'graph/tree');
    const dp = tree.taxonomy?.nodes.find((n) => n.id === 'dp');
    expect(graphTree?.count).toBe(1);
    expect(graph?.count).toBe(1);
    expect(dp?.count).toBe(0);
    const updated = tree.objects.find((o) => o.id === problem.id);
    expect(updated?.labels).toEqual(['赛时', '没调出来']);
  });

  it('悬空标签保留对象但计数忽略', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree' });
    const metaPath = join(absOf(problem.relPath), '.anvil.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.tags = { primary: 'graph/nope', related: [] };
    writeFileSync(metaPath, JSON.stringify(meta));
    await service.rescan();
    const tree = await service.tree();
    expect(tree.objects.some((o) => o.id === problem.id)).toBe(true);
    expect(tree.errors.some((e) => e.kind === 'tag-missing')).toBe(true);
    expect(tree.taxonomy?.nodes.find((n) => n.id === 'graph')?.count).toBe(0);
  });

  it('改标题不动目录；归档父对象隐式归档子对象', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree', parentId: contest.id });
    const renamed = await service.update({ id: problem.id, title: 'Cherry Tree II' });
    expect(renamed.title).toBe('Cherry Tree II');
    expect(renamed.relPath).toBe(problem.relPath);

    await service.update({ id: contest.id, archived: true });
    const active = await service.tree();
    expect(active.objects.some((o) => o.id === contest.id)).toBe(false);
    expect(active.objects.some((o) => o.id === problem.id)).toBe(false);
    const archived = await service.tree({ archived: true });
    const child = archived.objects.find((o) => o.id === problem.id);
    expect(child?.archived).toBe(false);
    expect(child?.effectiveArchived).toBe(true);
  });
});

describe('扫描 / 未登记 / 外部改动（契约 §6.8 / §8）', () => {
  it('外部新文件 rescan 可见；外部改名按 id 认回；移出根则消失', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree' });
    writeFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'int main(){}');
    await service.rescan();
    expect(service.object(problem.id).files.map((f) => f.path)).toContain('solution.cpp');

    const moved = absOf(problem.relPath).replace(/cherry-tree$/, 'cherry-renamed');
    renameSync(absOf(problem.relPath), moved);
    await service.rescan();
    const after = await service.tree();
    expect(after.objects.find((o) => o.id === problem.id)?.relPath).toBe('practice/2026-10/cherry-renamed');

    renameSync(moved, join(base, 'moved-out'));
    await service.rescan();
    expect((await service.tree()).objects.some((o) => o.id === problem.id)).toBe(false);
  });

  it('删 meta 变未登记，adopt 回来；非候选位置不报未登记', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    rmSync(join(absOf(contest.relPath), '.anvil.json'));
    await service.rescan();
    const scanned = await service.tree();
    expect(scanned.unregistered.some((u) => u.relPath === contest.relPath && u.kindHint === 'contest')).toBe(true);
    const adopted = await service.adopt({ relPath: contest.relPath, kind: 'contest', title: 'Shanghai' });
    expect(adopted.relPath).toBe(contest.relPath);
    expect(adopted.kind).toBe('contest');
  });

  it('坏 meta 进 errors；重复 id 全部排除；链接进 errors', async () => {
    await initRoot();
    mkdirSync(join(root, 'practice', '2026-10', 'broken'), { recursive: true });
    writeFileSync(join(root, 'practice', '2026-10', 'broken', '.anvil.json'), '{');
    const one = await service.create({ kind: 'problem', title: 'One' });
    const copyDir = join(root, 'practice', '2026-10', 'copy');
    mkdirSync(copyDir);
    copyFileSync(join(absOf(one.relPath), '.anvil.json'), join(copyDir, '.anvil.json'));

    const outside = join(base, 'outside-link');
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(root, 'contests', 'link'), 'junction');
    } catch {
      /* 不支持 junction 时跳过链接断言 */
    }

    await service.rescan();
    const tree = await service.tree();
    expect(tree.errors.some((e) => e.kind === 'meta-invalid')).toBe(true);
    expect(tree.errors.some((e) => e.message.includes('id 重复'))).toBe(true);
    expect(tree.objects.some((o) => o.id === one.id)).toBe(false);
    expect(tree.errors.some((e) => e.kind === 'symlink')).toBe(true);
  });

  it('文件列表截断 500、忽略目录不进列表、子对象不进父文件列表', async () => {
    await initRoot();
    const note = await service.create({ kind: 'note', title: 'Many' });
    for (let i = 0; i < 501; i += 1) writeFileSync(join(absOf(note.relPath), `f${String(i).padStart(3, '0')}.txt`), 'x');
    mkdirSync(join(absOf(note.relPath), 'node_modules'));
    writeFileSync(join(absOf(note.relPath), 'node_modules', 'dep.js'), 'x');
    writeFileSync(join(absOf(note.relPath), 'a.exe'), 'x');
    await service.rescan();
    const detail = service.object(note.id);
    expect(detail.fileCount).toBe(502); // 501 txt + note.md
    expect(detail.files).toHaveLength(500);
    expect(detail.filesTruncated).toBe(true);

    const contest = await service.create({ kind: 'contest', title: 'C' });
    await service.create({ kind: 'problem', title: 'P', parentId: contest.id });
    const files = service.object(contest.id).files.map((f) => f.path);
    expect(files.some((p) => p.startsWith('practice') || p.includes('solution'))).toBe(false);
  });
});

describe('回收站（契约 §6.6）', () => {
  it('trash / restore 整场恢复；原路径被占 → 409', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree', parentId: contest.id });
    await service.trash(contest.id);
    const trashed = await service.tree();
    expect(trashed.objects.some((o) => o.id === contest.id || o.id === problem.id)).toBe(false);
    expect(trashed.trash.some((t) => t.id === contest.id)).toBe(true);

    await service.restore(contest.id);
    const back = await service.tree();
    expect(back.objects.some((o) => o.id === contest.id)).toBe(true);
    expect(back.objects.some((o) => o.id === problem.id)).toBe(true);

    await service.trash(problem.id);
    mkdirSync(absOf(problem.relPath));
    await expect(service.restore(problem.id)).rejects.toMatchObject({ kind: 'path-occupied' });
    rmSync(absOf(problem.relPath), { recursive: true, force: true });
    await service.restore(problem.id);
  });

  it('父路径缺失 → parent-missing', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree', parentId: contest.id });
    await service.trash(problem.id);
    renameSync(absOf(contest.relPath), join(base, 'contest-moved'));
    await expect(service.restore(problem.id)).rejects.toMatchObject({ kind: 'parent-missing' });
  });
});

describe('adopt（契约 §6.2）与打开（§6.7）', () => {
  it('adopt 只写 meta；child 保持独立；祖先组合不合法则拒绝', async () => {
    await initRoot();
    mkdirSync(join(root, 'contests', 'manual'), { recursive: true });
    await service.rescan();
    const tree = await service.tree();
    expect(tree.unregistered.find((u) => u.relPath === 'contests/manual')?.kindHint).toBe('contest');
    const contest = await service.adopt({ relPath: 'contests/manual', kind: 'contest', title: 'Manual' });
    mkdirSync(join(root, 'contests', 'manual', 'p1'));
    const problem = await service.adopt({ relPath: 'contests/manual/p1', kind: 'problem', title: 'P1' });
    expect(problem.parentId).toBe(contest.id);
    await expect(service.adopt({ relPath: 'contests/manual/p1', kind: 'problem' })).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('open：code 成功 / code 失败回退 explorer / 都失败 502 / 越界拒绝', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree' });
    writeFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'x');

    await service.open(problem.id);
    expect(spawnCalls.at(-1)?.cmd).toBe(codePath);
    expect(spawnCalls.at(-1)?.args).toEqual([absOf(problem.relPath)]);
    expect(spawnCalls.at(-1)?.shell).toBe(false);

    await service.open(problem.id, 'solution.cpp');
    expect(spawnCalls.at(-1)?.args).toEqual(['--goto', join(absOf(problem.relPath), 'solution.cpp')]);

    failingCmds.add(codePath!);
    await service.open(problem.id, 'solution.cpp');
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');
    expect(spawnCalls.at(-1)?.args).toEqual([`/select,${join(absOf(problem.relPath), 'solution.cpp')}`]);

    failingCmds.add('explorer.exe');
    await expect(service.open(problem.id)).rejects.toMatchObject({ kind: 'editor-unavailable' });

    await expect(service.open(problem.id, '../x')).rejects.toMatchObject({ kind: 'unsafe-path' });
  });
});

describe('切换根（契约 §3.2）', () => {
  it('切根只换索引目标，旧根原样保留', async () => {
    await initRoot();
    await service.create({ kind: 'note', title: 'Old' });
    const oldRel = 'notes/2026/10/2026-10-21_old';

    const second = join(base, 'root-2');
    await service.init({ path: second });
    expect((await service.tree()).objects).toHaveLength(0);
    await service.create({ kind: 'note', title: 'New' });

    await service.init({ path: root });
    expect((await service.tree()).objects.some((o) => o.relPath === oldRel)).toBe(true);
    expect(existsSync(join(second, oldRel))).toBe(false);
  });
});
