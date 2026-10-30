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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { ArenaRecordResult } from '@anvil/shared';
import { initSchema } from '../src/db.ts';
import { codeExeFromWherePath, codeLaunchFor, type SpawnFn, type SpawnLike } from '../src/work/open.ts';
import { WorkService } from '../src/work/store.ts';

let base: string;
let root: string;
let repo: string;
let vault: string;
let configRoot: string;
let now: Date;
let db: DatabaseSync;
let service: WorkService;
let spawnCalls: { cmd: string; args: string[]; shell: boolean; env?: NodeJS.ProcessEnv }[];
let failingCmds: Set<string>;
let exitFailCmds: Set<string>;
let codePath: string | null;

function fakeSpawn(cmd: string, args: string[], opts: { shell: boolean; env?: NodeJS.ProcessEnv }): SpawnLike {
  spawnCalls.push({ cmd, args, shell: opts.shell, ...(opts.env === undefined ? {} : { env: opts.env }) });
  let spawnCb: (() => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  queueMicrotask(() => {
    if (failingCmds.has(cmd)) {
      errorCb?.(new Error('ENOENT'));
      return;
    }
    spawnCb?.();
    // 真实 VS Code CLI 打开窗口后通常很快以 0 退出；模拟默认成功
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
  exitFailCmds = new Set();
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
    expect(tree.problemTags).toEqual([]);
    expect(existsSync(join(root, '.anvil', 'root.json'))).toBe(true);
    // 词表已退役（30 §3.6）：新工作区不再生成 taxonomy.json
    expect(existsSync(join(root, '.anvil', 'taxonomy.json'))).toBe(false);
    for (const dir of ['contests', 'practice', 'templates', 'notes']) expect(existsSync(join(root, dir)), dir).toBe(true);

    // 旧词表原样保留、不读取：坏内容也不影响扫描
    writeFileSync(join(root, '.anvil', 'taxonomy.json'), JSON.stringify({ schema: 1, version: 9, nodes: [], aliases: {} }));
    await service.tree({ rescan: true });
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

  it('root.json 是符号链接：拒绝跟随', async () => {
    await initRoot();
    const rootJson = join(root, '.anvil', 'root.json');
    const outsideRoot = join(base, 'outside-root.json');
    writeFileSync(outsideRoot, JSON.stringify({ schema: 1, app: 'anvil' }));
    unlinkSync(rootJson);
    symlinkSync(outsideRoot, rootJson, 'file');
    await expect(service.tree({ rescan: true })).rejects.toMatchObject({ kind: 'root-version' });
  });
});

describe('四类对象与路径（契约 §4 / §5 / §6.1）', () => {
  it('创建四类对象、父子关系与 note.md', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree', parentId: contest.id });
    const template = await service.create({ kind: 'template', title: 'DSU' });
    const note = await service.create({ kind: 'note', title: 'Week 1' });

    expect(contest.relPath).toBe('contests/2026-10-21_shanghai');
    expect(problem.relPath).toBe('contests/2026-10-21_shanghai/cherry-tree');
    expect(problem.parentId).toBe(contest.id);
    expect(template.relPath).toBe('templates/_unsorted/dsu');
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

  it('templateId 只复制模板主文件，test.cpp 与其它文件都不带', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'DSU' });
    const templateUrl = absOf(template.relPath);
    writeFileSync(join(templateUrl, 'template.cpp'), '// template');
    writeFileSync(join(templateUrl, 'test.cpp'), '// test');
    writeFileSync(join(templateUrl, 'notes.txt'), 'keep?');

    const problem = await service.create({ kind: 'problem', title: 'Template Use', templateId: template.id });
    const detail = service.object(problem.id);
    const paths = detail.files.map((f) => f.path);
    expect(paths).toContain('solution.cpp');
    expect(paths).not.toContain('test.cpp');
    expect(paths).not.toContain('notes.txt');
    expect(readFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'utf8')).toBe('// template');
  });

  it('模板主文件本身叫 solution.cpp 时也复制为 solution.cpp', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'DSU2' });
    writeFileSync(join(absOf(template.relPath), 'solution.cpp'), '// sol-only');
    const problem = await service.create({ kind: 'problem', title: 'Template Use 2', templateId: template.id });
    expect(readFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'utf8')).toBe('// sol-only');
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

describe('模板文件读写（切片 5a.1）', () => {
  it('读取主文件并带 SHA-256；revision 命中时原子保存并刷新文件列表', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'DSU' });
    const file = join(absOf(template.relPath), 'template.cpp');
    writeFileSync(file, 'int main() {}\n');

    const read = service.getTemplate(template.id);
    expect(read).toMatchObject({ path: 'template.cpp', exists: true, content: 'int main() {}\n' });
    expect(read.revision).toMatch(/^[0-9a-f]{64}$/);

    const metaBefore = JSON.parse(readFileSync(join(absOf(template.relPath), '.anvil.json'), 'utf8'));
    const saved = await service.saveTemplate({ id: template.id, content: 'int main() { return 0; }\n', baseRevision: read.revision });
    expect(saved.content).toBe('int main() { return 0; }\n');
    expect(saved.revision).not.toBe(read.revision);
    expect(readFileSync(file, 'utf8')).toBe('int main() { return 0; }\n');
    expect(service.object(template.id).files.some((f) => f.path === 'template.cpp')).toBe(true);
    // 只写模板文件：meta 不因编辑而改动
    expect(JSON.parse(readFileSync(join(absOf(template.relPath), '.anvil.json'), 'utf8'))).toEqual(metaBefore);
  });

  it('revision 过期 → conflict，文件不被覆盖', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'DSU' });
    const file = join(absOf(template.relPath), 'template.cpp');
    writeFileSync(file, 'one\n');
    const read = service.getTemplate(template.id);
    writeFileSync(file, 'external\n');

    await expect(service.saveTemplate({ id: template.id, content: 'editor\n', baseRevision: read.revision })).rejects.toMatchObject({
      kind: 'conflict',
    });
    expect(readFileSync(file, 'utf8')).toBe('external\n');
  });

  it('文件不存在时 revision 为 null；保存创建 template.cpp；之后再用 null 保存 → conflict', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'Empty' });
    const read = service.getTemplate(template.id);
    expect(read).toMatchObject({ path: 'template.cpp', exists: false, content: '', revision: null });

    const saved = await service.saveTemplate({ id: template.id, content: '// fresh\n', baseRevision: null });
    expect(saved).toMatchObject({ path: 'template.cpp', exists: true, content: '// fresh\n' });
    expect(readFileSync(join(absOf(template.relPath), 'template.cpp'), 'utf8')).toBe('// fresh\n');
    await expect(service.saveTemplate({ id: template.id, content: '// again\n', baseRevision: null })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('没有 template.cpp 时编辑首个 .cpp；非模板对象拒绝', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'Alt' });
    writeFileSync(join(absOf(template.relPath), 'a.cpp'), '// a\n');
    writeFileSync(join(absOf(template.relPath), 'b.cpp'), '// b\n');
    const read = service.getTemplate(template.id);
    expect(read.path).toBe('a.cpp');
    const saved = await service.saveTemplate({ id: template.id, content: '// a2\n', baseRevision: read.revision });
    expect(saved.path).toBe('a.cpp');
    expect(readFileSync(join(absOf(template.relPath), 'a.cpp'), 'utf8')).toBe('// a2\n');

    const problem = await service.create({ kind: 'problem', title: 'Nope' });
    expect(() => service.getTemplate(problem.id)).toThrowError(/模板/);
    await expect(service.saveTemplate({ id: problem.id, content: 'x', baseRevision: null })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('主文件是符号链接或内容超限 → 拒绝', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'Link' });
    const outside = join(base, 'outside.cpp');
    writeFileSync(outside, '// outside\n');
    try {
      symlinkSync(outside, join(absOf(template.relPath), 'template.cpp'), 'file');
    } catch {
      return; // Windows 未开启开发者模式时跳过
    }
    await expect(service.saveTemplate({ id: template.id, content: 'x', baseRevision: null })).rejects.toMatchObject({ kind: 'unsafe-path' });
    expect(readFileSync(outside, 'utf8')).toBe('// outside\n');
  });

  it('模板文件夹被外部移走 → not-found，不重建原目录', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'Moved' });
    renameSync(absOf(template.relPath), join(root, 'templates', '_unsorted', 'moved-away'));
    await expect(service.saveTemplate({ id: template.id, content: 'x', baseRevision: null })).rejects.toMatchObject({
      kind: 'not-found',
    });
    expect(existsSync(absOf(template.relPath))).toBe(false);
  });

  it('内容超过 64KB / 含 NUL → invalid', async () => {
    await initRoot();
    const template = await service.create({ kind: 'template', title: 'Big' });
    await expect(
      service.saveTemplate({ id: template.id, content: 'a'.repeat(64 * 1024 + 1), baseRevision: null }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(service.saveTemplate({ id: template.id, content: 'a\0b', baseRevision: null })).rejects.toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('默认模板（切片 5a.1；题组沿用，2026-10-26 补记）', () => {
  it('未指定模板时用 updatedAt 最新的非归档模板放入 solution.cpp', async () => {
    await initRoot();
    const older = await service.create({ kind: 'template', title: 'Older' });
    writeFileSync(join(absOf(older.relPath), 'template.cpp'), '// older\n');
    now = new Date(2026, 9, 21, 12, 5, 0);
    const newer = await service.create({ kind: 'template', title: 'Newer' });
    writeFileSync(join(absOf(newer.relPath), 'template.cpp'), '// newer\n');

    const auto = await service.create({ kind: 'problem', title: 'Auto Template' });
    expect(readFileSync(join(absOf(auto.relPath), 'solution.cpp'), 'utf8')).toBe('// newer\n');
  });

  it('显式模板优先；null / 空串表示不复制；归档模板不参与默认', async () => {
    await initRoot();
    const a = await service.create({ kind: 'template', title: 'Alpha' });
    writeFileSync(join(absOf(a.relPath), 'template.cpp'), '// alpha\n');
    now = new Date(2026, 9, 21, 12, 5, 0);
    const b = await service.create({ kind: 'template', title: 'Beta' });
    writeFileSync(join(absOf(b.relPath), 'template.cpp'), '// beta\n');

    const chosen = await service.create({ kind: 'problem', title: 'Chosen', templateId: a.id });
    expect(readFileSync(join(absOf(chosen.relPath), 'solution.cpp'), 'utf8')).toBe('// alpha\n');

    const none = await service.create({ kind: 'problem', title: 'No Template', templateId: null });
    expect(service.object(none.id).files.some((f) => f.path === 'solution.cpp')).toBe(false);
    const empty = await service.create({ kind: 'problem', title: 'Empty Choice', templateId: '' });
    expect(service.object(empty.id).files.some((f) => f.path === 'solution.cpp')).toBe(false);

    await service.update({ id: b.id, archived: true });
    const fallback = await service.create({ kind: 'problem', title: 'Fallback' });
    expect(readFileSync(join(absOf(fallback.relPath), 'solution.cpp'), 'utf8')).toBe('// alpha\n');
  });

  it('新建题组同样用默认模板（5a-2 起题组是唯一可建单元）：只放 solution.cpp', async () => {
    await initRoot();
    const bare = await service.create({ kind: 'problemset', title: 'Bare' });
    expect(service.object(bare.id).files.some((f) => f.path === 'solution.cpp')).toBe(false);

    const tpl = await service.create({ kind: 'template', title: 'Base' });
    writeFileSync(join(absOf(tpl.relPath), 'template.cpp'), '// base\n');
    writeFileSync(join(absOf(tpl.relPath), 'test.cpp'), 'int main() { return 0; }\n');

    const set = await service.create({ kind: 'problemset', title: 'TreeDP' });
    expect(readFileSync(join(absOf(set.relPath), 'solution.cpp'), 'utf8')).toBe('// base\n');
    expect(service.object(set.id).files.some((f) => f.path === 'test.cpp')).toBe(false);
  });

  it('题组也接受显式 templateId / null（不复制）；比赛仍拒绝 templateId', async () => {
    await initRoot();
    const alpha = await service.create({ kind: 'template', title: 'Alpha' });
    writeFileSync(join(absOf(alpha.relPath), 'template.cpp'), '// alpha\n');
    const beta = await service.create({ kind: 'template', title: 'Beta' });
    writeFileSync(join(absOf(beta.relPath), 'template.cpp'), '// beta\n');

    const chosen = await service.create({ kind: 'problemset', title: 'Chosen', templateId: alpha.id });
    expect(readFileSync(join(absOf(chosen.relPath), 'solution.cpp'), 'utf8')).toBe('// alpha\n');

    const none = await service.create({ kind: 'problemset', title: 'No Template', templateId: null });
    expect(service.object(none.id).files.some((f) => f.path === 'solution.cpp')).toBe(false);

    await expect(service.create({ kind: 'contest', title: 'Nope', templateId: alpha.id })).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('自由标签、改标题、归档（契约 §6.3 / §6.4 / §6.5）', () => {
  it('对象级自由标签仍可写；旧主题标签字段不读、原样保留', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree' });
    await service.update({ id: problem.id, labels: ['#赛时', '没调出来'] });
    const tree = await service.tree();
    const updated = tree.objects.find((o) => o.id === problem.id);
    expect(updated?.labels).toEqual(['赛时', '没调出来']);
    expect((updated as unknown as { tags?: unknown }).tags).toBeUndefined();

    const metaPath = join(absOf(problem.relPath), '.anvil.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.tags = { primary: 'graph/nope', related: [] };
    writeFileSync(metaPath, JSON.stringify(meta));
    await service.rescan();
    await service.update({ id: problem.id, labels: ['赛后'] });
    const after = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(after.tags).toEqual({ primary: 'graph/nope', related: [] });
    expect(after.labels).toEqual(['赛后']);
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
  it('where code 的无扩展首行 / code.cmd 都能解析到 Code.exe', () => {
    const vs = join(base, 'vscode');
    mkdirSync(join(vs, 'bin'), { recursive: true });
    const exe = join(vs, 'Code.exe');
    writeFileSync(exe, '');
    writeFileSync(join(vs, 'bin', 'code'), '');
    writeFileSync(join(vs, 'bin', 'code.cmd'), '');
    expect(codeExeFromWherePath(join(vs, 'bin', 'code'))).toBe(exe);
    expect(codeExeFromWherePath(join(vs, 'bin', 'code.cmd'))).toBe(exe);
    expect(codeExeFromWherePath(exe)).toBe(exe);
  });

  it('codeLaunchFor：官方布局直接 spawn；版本目录布局走 cli.js + ELECTRON_RUN_AS_NODE', () => {
    const target = join(base, 'target-folder');
    const official = join(base, 'vscode-official');
    mkdirSync(official, { recursive: true });
    writeFileSync(join(official, 'Code.exe'), '');
    expect(codeLaunchFor(join(official, 'Code.exe'), target, true, true)).toEqual({ args: ['--new-window', target] });

    const versioned = join(base, 'vscode-versioned');
    mkdirSync(join(versioned, 'bin'), { recursive: true });
    writeFileSync(join(versioned, 'Code.exe'), '');
    const cli = join(versioned, '2d0b7506a3', 'resources', 'app', 'out', 'cli.js');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '');
    writeFileSync(
      join(versioned, 'bin', 'code.cmd'),
      '@echo off\n"%~dp0..\\2d0b7506a3\\resources\\app\\out\\cli.js" %*\n',
    );
    const launch = codeLaunchFor(join(versioned, 'Code.exe'), target, true, true);
    expect(launch.args).toEqual([cli, '--new-window', target]);
    expect(launch.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(codeLaunchFor(join(versioned, 'Code.exe'), join(target, 'a.cpp'), false, false).args).toEqual([cli, '--goto', join(target, 'a.cpp')]);
  });

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

  it('open：文件夹走 explorer / 文件走 code / 互相回退 / 都失败 502 / 越界拒绝', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Cherry Tree' });
    writeFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'x');

    await service.open(problem.id);
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');
    expect(spawnCalls.at(-1)?.args).toEqual([absOf(problem.relPath)]);
    expect(spawnCalls.at(-1)?.shell).toBe(false);

    await service.open(problem.id, 'solution.cpp');
    expect(spawnCalls.at(-1)?.cmd).toBe(codePath);
    expect(spawnCalls.at(-1)?.args).toEqual(['--goto', join(absOf(problem.relPath), 'solution.cpp')]);

    failingCmds.add('explorer.exe');
    await service.open(problem.id);
    expect(spawnCalls.at(-1)?.cmd).toBe(codePath);
    expect(spawnCalls.at(-1)?.args).toEqual([absOf(problem.relPath)]);

    failingCmds.clear();
    failingCmds.add(codePath!);
    await service.open(problem.id, 'solution.cpp');
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');
    expect(spawnCalls.at(-1)?.args).toEqual([`/select,${join(absOf(problem.relPath), 'solution.cpp')}`]);

    failingCmds.add('explorer.exe');
    await expect(service.open(problem.id)).rejects.toMatchObject({ kind: 'editor-unavailable' });

    failingCmds.clear();
    await expect(service.open(problem.id, '../x')).rejects.toMatchObject({ kind: 'unsafe-path' });
  });

  it('open 显式 app：vscode 只走新窗口且不回退，explorer 只开资源管理器', async () => {
    await initRoot();
    const problem = await service.create({ kind: 'problem', title: 'Explicit Open' });
    writeFileSync(join(absOf(problem.relPath), 'solution.cpp'), 'x');

    await service.open(problem.id, undefined, 'vscode');
    expect(spawnCalls.at(-1)?.cmd).toBe(codePath);
    expect(spawnCalls.at(-1)?.args).toEqual(['--new-window', absOf(problem.relPath)]);
    expect(spawnCalls.at(-1)?.shell).toBe(false);

    await service.open(problem.id, 'solution.cpp', 'vscode');
    expect(spawnCalls.at(-1)?.args).toEqual(['--goto', join(absOf(problem.relPath), 'solution.cpp')]);

    failingCmds.add(codePath!);
    const before = spawnCalls.length;
    await expect(service.open(problem.id, undefined, 'vscode')).rejects.toMatchObject({ kind: 'editor-unavailable' });
    expect(spawnCalls.length).toBe(before + 1);
    expect(spawnCalls.at(-1)?.cmd).toBe(codePath);

    failingCmds.clear();
    exitFailCmds.add(codePath!);
    await expect(service.open(problem.id, undefined, 'vscode')).rejects.toMatchObject({ kind: 'editor-unavailable' });
    exitFailCmds.clear();
    await service.open(problem.id, undefined, 'explorer');
    expect(spawnCalls.at(-1)?.cmd).toBe('explorer.exe');
    expect(spawnCalls.at(-1)?.args).toEqual([absOf(problem.relPath)]);

    failingCmds.add('explorer.exe');
    await expect(service.open(problem.id, undefined, 'explorer')).rejects.toMatchObject({ kind: 'editor-unavailable' });

    codePath = null;
    await expect(service.open(problem.id, undefined, 'vscode')).rejects.toMatchObject({ kind: 'editor-unavailable' });
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

describe('榜单多存档（docs/contracts/29）', () => {
  const arenaPath = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';
  const otherArena = 'official/icpc/icpc2025/icpc2025beijing.srk.json';
  const durationMs = 5 * 3_600_000;
  const rid = (ch: string): string => `rec_${ch.repeat(32)}`;
  const A = rid('a');
  const B = rid('b');
  const C = rid('c');
  const D = rid('d');

  const timed = (stoppedAtMs = durationMs): ArenaRecordResult => ({
    origin: 'timed',
    finish: stoppedAtMs === durationMs ? 'time-limit' : 'stopped',
    durationMs,
    stoppedAtMs,
  });
  const ghost = { show: true, subs: [{ p: 1, t: 45, r: 'AC' as const }, { p: 0, t: 20, r: 'WA' as const }] };
  const saveInput = (recordId: string, name: string, patch: Record<string, unknown> = {}) => ({
    arenaPath,
    recordId,
    name,
    result: timed(),
    ghost,
    ...patch,
  });
  function cacheBoard(path = arenaPath, problems = 4): void {
    const file = join(vault, 'arena', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        contest: { duration: [durationMs, 'ms'] },
        problems: Array.from({ length: problems }, (_, i) => ({ alias: String.fromCharCode(65 + i) })),
      }),
    );
  }
  async function seedContest(path = arenaPath, title = '上海站') {
    return service.create({ kind: 'contest', title, arenaPath: path });
  }
  function rootRecord(contestRel: string, record: Record<string, unknown>): void {
    writeFileSync(join(absOf(contestRel), 'record.json'), JSON.stringify(record, null, 2));
  }
  const legacyReview = (savedAt: string) => ({
    schema: 1,
    arenaPath,
    title: '上海站',
    savedAt,
    ghost,
    view: { mode: 'review', viewMs: 0, paused: false, frozenView: false },
  });
  const legacyLive = (savedAt: string) => ({
    schema: 1,
    arenaPath,
    title: '上海站',
    savedAt,
    ghost,
    view: { mode: 'live', viewMs: 72000, paused: true, frozenView: false },
  });

  it('同场三档、同名不同 ID；只有一个 contest；改名不换 ID、不动对象 updatedAt', async () => {
    await initRoot();
    cacheBoard();
    const first = await service.createArenaRecord(saveInput(A, '第一次 VP'));
    expect(first.created).toBe(true);
    expect(first.object.kind).toBe('contest');
    expect(first.record.ghost.subs.map((s) => s.p)).toEqual([0, 1]);
    expect(existsSync(join(absOf(first.object.relPath), '.anvil-records', `${A}.json`))).toBe(true);
    expect(service.object(first.object.id).files.map((f) => f.path).some((p) => p.includes('.anvil-records'))).toBe(false);
    const objectUpdatedAt = service.object(first.object.id).updatedAt;

    await service.createArenaRecord(saveInput(B, '第一次 VP'));
    await service.createArenaRecord(saveInput(C, '第一次 VP'));
    const list = service.listArenaRecords(arenaPath);
    expect(list.contestId).toBe(first.object.id);
    expect(list.records).toHaveLength(3);
    expect(list.records.map((r) => r.name)).toEqual(['第一次 VP', '第一次 VP', '第一次 VP']);
    expect((await service.tree()).objects.filter((o) => o.kind === 'contest')).toHaveLength(1);
    expect(service.object(first.object.id).updatedAt).toBe(objectUpdatedAt);

    now = new Date(2026, 9, 21, 12, 5, 0);
    const renamed = await service.renameArenaRecord({
      arenaPath,
      recordId: B,
      expectedRevision: list.records.find((r) => r.recordId === B)!.revision,
      name: '第二次 VP',
    });
    expect(renamed.record.recordId).toBe(B);
    expect(renamed.record.name).toBe('第二次 VP');
    expect(service.listArenaRecords(arenaPath).records.find((r) => r.recordId === B)?.name).toBe('第二次 VP');
    expect((await service.tree()).objects.filter((o) => o.kind === 'contest')).toHaveLength(1);
  });

  it('更新只写指定档；列表按 updatedAt 倒序；revision 过期与外部改文件都拒绝', async () => {
    await initRoot();
    cacheBoard();
    const a = await service.createArenaRecord(saveInput(A, 'A'));
    await service.createArenaRecord(saveInput(B, 'B'));
    const beforeB = service.listArenaRecords(arenaPath).records.find((r) => r.recordId === B)!;

    now = new Date(2026, 9, 21, 12, 10, 0);
    const updated = await service.updateArenaRecord({
      arenaPath,
      recordId: A,
      expectedRevision: a.revision,
      result: { ...timed(90 * 60_000) },
      ghost: { show: false, subs: [{ p: 2, t: 61, r: 'AC' }] },
    });
    expect(updated.record.recordId).toBe(A);
    expect(updated.record.ghost.show).toBe(false);
    const afterB = service.listArenaRecords(arenaPath).records.find((r) => r.recordId === B)!;
    expect(afterB.revision).toBe(beforeB.revision);
    expect(service.listArenaRecords(arenaPath).records[0]?.recordId).toBe(A);

    await expect(
      service.updateArenaRecord({ arenaPath, recordId: A, expectedRevision: a.revision, result: timed(), ghost }),
    ).rejects.toMatchObject({ kind: 'conflict' });

    const file = join(absOf(a.object.relPath), '.anvil-records', `${A}.json`);
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.replace('"show": false', '"show": true'));
    await expect(
      service.updateArenaRecord({ arenaPath, recordId: A, expectedRevision: updated.revision, result: timed(), ghost }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('新建幂等：同 ID 同内容只一份；内容不符 / 已回收拒绝；无缓存与非法逐发拒绝', async () => {
    await initRoot();
    await expect(service.createArenaRecord(saveInput(A, 'X'))).rejects.toMatchObject({ kind: 'conflict' });

    cacheBoard();
    const first = await service.createArenaRecord(saveInput(A, 'X'));
    const retry = await service.createArenaRecord(saveInput(A, 'X', { contestTitle: '另一个标题' }));
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.record.createdAt).toBe(first.record.createdAt);
    expect(service.listArenaRecords(arenaPath).records).toHaveLength(1);

    await expect(service.createArenaRecord(saveInput(A, '改过名'))).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.createArenaRecord(saveInput('legacy', 'X'))).rejects.toMatchObject({ kind: 'invalid' });
    await expect(service.createArenaRecord(saveInput(D, 'X', { result: timed(durationMs + 1) }))).rejects.toMatchObject({
      kind: 'invalid',
    });
    await expect(
      service.createArenaRecord(saveInput(D, 'X', { ghost: { show: true, subs: [{ p: 4, t: 10, r: 'AC' }] } })),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(service.createArenaRecord(saveInput(D, 'X', { ghost: { show: true, subs: [{ p: 0, t: 301, r: 'AC' }] } }))).rejects.toMatchObject({
      kind: 'invalid',
    });

    const a = service.listArenaRecords(arenaPath).records.find((r) => r.recordId === A)!;
    const trashed = await service.trashArenaRecord({ arenaPath, recordId: A, expectedRevision: a.revision, confirm: true });
    await expect(service.createArenaRecord(saveInput(A, 'X'))).rejects.toMatchObject({ kind: 'conflict' });
    expect(trashed.entryType).toBe('arena-record');
  });

  it('零成绩可保存；进行中不是服务端状态，缺结束信息 / 时长不符 / 缺缓存都拒绝', async () => {
    await initRoot();
    cacheBoard();
    const zero = await service.createArenaRecord(saveInput(A, '零成绩', { ghost: { show: true, subs: [] } }));
    expect(zero.record.ghost.subs).toEqual([]);
    expect(zero.record.result).toMatchObject({ origin: 'timed', finish: 'time-limit', stoppedAtMs: durationMs });

    await expect(
      service.createArenaRecord(
        saveInput(B, '补录', { result: { origin: 'manual', finish: 'declared', durationMs, stoppedAtMs: null } }),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      service.createArenaRecord(
        saveInput(C, '谎称到时', {
          result: { origin: 'timed', finish: 'time-limit', durationMs, stoppedAtMs: 60_000 },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      service.createArenaRecord(saveInput(C, '补录伪造停止', { result: { origin: 'manual', finish: 'declared', durationMs, stoppedAtMs: 0 } })),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      service.createArenaRecord(saveInput(C, '未知结束', { result: { origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null } })),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      service.createArenaRecord(
        saveInput(C, '时长不符', {
          result: { origin: 'timed', finish: 'stopped', durationMs: durationMs - 1, stoppedAtMs: durationMs - 1 },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'conflict' });

    const noCache = 'official/icpc/icpc2025/nocache.srk.json';
    await expect(service.createArenaRecord({ ...saveInput(C, '无缓存'), arenaPath: noCache })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('单档回收 / 恢复保 ID 与版本；整场回收带着存档走；父缺失 / 父回收 / 父归档 / 占位逐项拒绝', async () => {
    await initRoot();
    cacheBoard();
    const made = await service.createArenaRecord(saveInput(A, '第一次 VP'));
    const contestId = made.object.id;
    const a = service.listArenaRecords(arenaPath).records[0]!;

    const trashed = await service.trashArenaRecord({ arenaPath, recordId: A, expectedRevision: a.revision, confirm: true });
    expect(trashed.trashId).toMatch(/^tr_[0-9a-f]{32}$/);
    const tree = await service.tree();
    expect(tree.trash).toHaveLength(1);
    expect(tree.trash[0]).toMatchObject({ entryType: 'arena-record', recordId: A, contestId });
    expect(service.listArenaRecords(arenaPath).records).toHaveLength(0);

    const restored = await service.restoreArenaRecord(trashed.trashId);
    expect(restored.restored).toBe('record');
    if (restored.restored === 'record') expect(restored.record.recordId).toBe(A);
    expect(service.listArenaRecords(arenaPath).records).toHaveLength(1);

    // 整场回收：比赛目录连同 .anvil-records 一起移动；恢复整场后存档还在
    await service.trash(contestId);
    expect((await service.tree()).trash).toHaveLength(1);
    await service.restore(contestId);
    expect(service.listArenaRecords(arenaPath).records).toHaveLength(1);

    // 父比赛在回收站：先恢复比赛
    const again = service.listArenaRecords(arenaPath).records[0]!;
    const t2 = await service.trashArenaRecord({ arenaPath, recordId: A, expectedRevision: again.revision, confirm: true });
    await service.trash(contestId);
    await expect(service.restoreArenaRecord(t2.trashId)).rejects.toMatchObject({ kind: 'conflict' });
    await service.restore(contestId);
    await service.restoreArenaRecord(t2.trashId);

    // 父归档：管理动作冻结，成绩写入例外
    const archivedBefore = service.listArenaRecords(arenaPath).records[0]!;
    await service.update({ id: contestId, archived: true });
    await expect(
      service.renameArenaRecord({ arenaPath, recordId: A, expectedRevision: archivedBefore.revision, name: '改名' }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      service.trashArenaRecord({ arenaPath, recordId: A, expectedRevision: archivedBefore.revision, confirm: true }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    const archivedEdit = await service.updateArenaRecord({
      arenaPath,
      recordId: A,
      expectedRevision: archivedBefore.revision,
      result: timed(),
      ghost,
    });
    await service.update({ id: contestId, archived: false });

    // 目标占位：先塞一个同 ID 文件，恢复必须拒绝而不覆盖
    const target = join(absOf(made.object.relPath), '.anvil-records', `${A}.json`);
    const t3 = await service.trashArenaRecord({
      arenaPath,
      recordId: A,
      expectedRevision: archivedEdit.revision,
      confirm: true,
    });
    writeFileSync(target, '{"someone":"else"}');
    await expect(service.restoreArenaRecord(t3.trashId)).rejects.toMatchObject({ kind: 'path-occupied' });
    expect(readFileSync(target, 'utf8')).toBe('{"someone":"else"}');
  });

  it('回收站清空只删两类合法条目；杂项、坏清单、符号链接不动', async () => {
    await initRoot();
    cacheBoard();
    const made = await service.createArenaRecord(saveInput(A, 'A'));
    const a = service.listArenaRecords(arenaPath).records[0]!;
    await service.trashArenaRecord({ arenaPath, recordId: A, expectedRevision: a.revision, confirm: true });
    const contest = await service.create({ kind: 'contest', title: '另一场', arenaPath: otherArena });
    await service.trash(contest.id);

    const trashRoot = join(root, '.anvil', 'trash');
    mkdirSync(join(trashRoot, 'junk-dir'), { recursive: true });
    mkdirSync(join(trashRoot, 'bad-manifest'), { recursive: true });
    writeFileSync(join(trashRoot, 'bad-manifest', 'trash.json'), '{"schema":99}');
    writeFileSync(join(trashRoot, 'loose.json'), '{}');
    let linked = false;
    try {
      symlinkSync(join(root, '.anvil', 'root.json'), join(trashRoot, 'link-entry'));
      linked = true;
    } catch {
      /* Windows 无符号链接权限时跳过这一小项 */
    }

    const purged = await service.purgeTrash();
    expect(purged.removed).toBe(2);
    expect(existsSync(join(trashRoot, 'junk-dir'))).toBe(true);
    expect(existsSync(join(trashRoot, 'bad-manifest'))).toBe(true);
    expect(existsSync(join(trashRoot, 'loose.json'))).toBe(true);
    if (linked) expect(existsSync(join(trashRoot, 'link-entry'))).toBe(true);
    expect(made.object.id).toBeTruthy();
  });

  it('旧 review 进 records 并投影；仅改名保留 unknown；确认编辑后转 manual 并原地升级', async () => {
    await initRoot();
    const contest = await seedContest();
    rootRecord(contest.relPath, legacyReview('2026-10-20T06:32:00.000Z'));

    let list = service.listArenaRecords(arenaPath);
    expect(list.records).toHaveLength(1);
    expect(list.legacy).toBeNull();
    const legacyItem = service.getArenaRecordItem(arenaPath, 'legacy');
    expect(legacyItem.record).toMatchObject({
      recordId: 'legacy',
      name: '旧存档 2026-10-20 14:32',
      result: { origin: 'legacy-review', finish: 'unknown' },
    });
    expect(legacyItem.record.createdAt).toBe('2026-10-20T06:32:00.000Z');

    now = new Date(2026, 9, 21, 12, 30, 0);
    const renamed = await service.renameArenaRecord({
      arenaPath,
      recordId: 'legacy',
      expectedRevision: legacyItem.revision,
      name: '老回顾',
    });
    expect(renamed.record).toMatchObject({
      recordId: 'legacy',
      name: '老回顾',
      createdAt: '2026-10-20T06:32:00.000Z',
    });
    expect(renamed.record.result).toEqual({ origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null });
    expect(JSON.parse(readFileSync(join(absOf(contest.relPath), 'record.json'), 'utf8')).schema).toBe(2);

    // 修改成绩不能把 unknown 结束状态写回去
    await expect(
      service.updateArenaRecord({
        arenaPath,
        recordId: 'legacy',
        expectedRevision: renamed.revision,
        result: { origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null },
        ghost,
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });

    cacheBoard();
    const edited = await service.updateArenaRecord({
      arenaPath,
      recordId: 'legacy',
      expectedRevision: renamed.revision,
      result: { origin: 'manual', finish: 'declared', durationMs, stoppedAtMs: null },
      ghost,
    });
    expect(edited.record.result.origin).toBe('manual');
    expect(edited.record.createdAt).toBe('2026-10-20T06:32:00.000Z');
    list = service.listArenaRecords(arenaPath);
    expect(list.records[0]?.recordId).toBe('legacy');
  });

  it('旧 live 只进 legacy；rename / update 拒绝；回收后恢复仍是原 schema 1 live', async () => {
    await initRoot();
    const contest = await seedContest();
    rootRecord(contest.relPath, legacyLive('2026-10-20T06:32:00.000Z'));

    const list = service.listArenaRecords(arenaPath);
    expect(list.records).toHaveLength(0);
    expect(list.legacy).toMatchObject({ mode: 'live', submissionCount: 2 });
    const legacy = service.getArenaLegacy(arenaPath);
    expect(legacy.mode).toBe('live');
    expect(legacy.record.view.mode).toBe('live');

    await expect(
      service.renameArenaRecord({ arenaPath, recordId: 'legacy', expectedRevision: legacy.revision, name: 'X' }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      service.updateArenaRecord({ arenaPath, recordId: 'legacy', expectedRevision: legacy.revision, result: timed(), ghost }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(() => service.getArenaRecordItem(arenaPath, 'legacy')).toThrowError(/旧进度/);

    const trashed = await service.trashArenaRecord({ arenaPath, recordId: 'legacy', expectedRevision: legacy.revision, confirm: true });
    const back = await service.restoreArenaRecord(trashed.trashId);
    expect(back.restored).toBe('legacy-progress');
    if (back.restored === 'legacy-progress') expect(back.legacy.record.schema).toBe(1);
    expect(existsSync(join(absOf(contest.relPath), 'record.json'))).toBe(true);
    expect(existsSync(join(absOf(contest.relPath), '.anvil-records', 'legacy.json'))).toBe(false);
  });

  it('两场各自的 legacy 分别回收 / 恢复，回各自根文件，不串场不重复计数', async () => {
    await initRoot();
    const sh = await seedContest(arenaPath, '上海站');
    const bj = await seedContest(otherArena, '北京站');
    rootRecord(sh.relPath, legacyReview('2026-10-20T06:32:00.000Z'));
    writeFileSync(
      join(absOf(bj.relPath), 'record.json'),
      JSON.stringify({ ...legacyReview('2026-10-21T06:32:00.000Z'), arenaPath: otherArena }),
    );

    expect(service.listArenaRecords(arenaPath).records).toHaveLength(1);
    expect(service.listArenaRecords(otherArena).records).toHaveLength(1);

    const shItem = service.getArenaRecordItem(arenaPath, 'legacy');
    const bjItem = service.getArenaRecordItem(otherArena, 'legacy');
    const shTrash = await service.trashArenaRecord({ arenaPath, recordId: 'legacy', expectedRevision: shItem.revision, confirm: true });
    const bjTrash = await service.trashArenaRecord({ arenaPath: otherArena, recordId: 'legacy', expectedRevision: bjItem.revision, confirm: true });
    expect((await service.tree()).trash.filter((t) => t.entryType === 'arena-record')).toHaveLength(2);

    await service.restoreArenaRecord(bjTrash.trashId);
    await service.restoreArenaRecord(shTrash.trashId);
    expect(service.listArenaRecords(arenaPath).records).toHaveLength(1);
    expect(service.listArenaRecords(otherArena).records).toHaveLength(1);
    expect(existsSync(join(absOf(sh.relPath), 'record.json'))).toBe(true);
    expect(existsSync(join(absOf(bj.relPath), 'record.json'))).toBe(true);
    expect(existsSync(join(absOf(sh.relPath), '.anvil-records', 'legacy.json'))).toBe(false);
  });

  it('损坏 / 未知文件只进 errors，合法档照常可读；路径穿越与场次不一致拒绝', async () => {
    await initRoot();
    cacheBoard();
    const made = await service.createArenaRecord(saveInput(A, '好档'));
    const dir = join(absOf(made.object.relPath), '.anvil-records');
    writeFileSync(join(dir, `${B}.json`), '{ 半截');
    writeFileSync(join(dir, 'unknown.json'), '{}');
    const list = service.listArenaRecords(arenaPath);
    expect(list.records.map((r) => r.recordId)).toEqual([A]);
    expect(list.errors.map((e) => e.file).sort()).toEqual([`.anvil-records/${B}.json`, '.anvil-records/unknown.json']);

    expect(() => service.getArenaRecordItem(arenaPath, B)).toThrowError(/不是合法 JSON/);
    expect(() => service.getArenaRecordItem(arenaPath, '../record')).toThrowError(/recordId/);
    expect(() => service.listArenaRecords('../x.srk.json')).toThrowError(/arenaPath/);

    const other = await seedContest(otherArena, '北京站');
    mkdirSync(join(absOf(other.relPath), '.anvil-records'), { recursive: true });
    writeFileSync(
      join(absOf(other.relPath), '.anvil-records', `${D}.json`),
      JSON.stringify({
        schema: 2,
        recordId: D,
        contestId: made.object.id,
        arenaPath: otherArena,
        name: '串场',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        result: timed(),
        ghost,
      }),
    );
    const otherList = service.listArenaRecords(otherArena);
    expect(otherList.records).toHaveLength(0);
    expect(otherList.errors[0]?.message).toContain('不一致');
  });

  it('回收站里躺着同场 → 列表与新建都拒绝，不顺手另建一场', async () => {
    await initRoot();
    cacheBoard();
    const made = await service.createArenaRecord(saveInput(A, '上海站'));
    await service.trash(made.object.id);

    await expect(service.createArenaRecord(saveInput(B, '上海站'))).rejects.toMatchObject({ kind: 'conflict' });
    expect(() => service.listArenaRecords(arenaPath)).toThrowError(/回收站/);
    expect((await service.tree()).objects.filter((o) => o.links.arenaPath === arenaPath)).toHaveLength(0);

    await service.restore(made.object.id);
    expect(service.listArenaRecords(arenaPath).records).toHaveLength(1);
  });

  it('5000 发可保存；超过 5000 发整份拒绝', async () => {
    await initRoot();
    cacheBoard(arenaPath, 4);
    const subs = Array.from({ length: 5000 }, (_, i) => ({ p: i % 4, t: i % 300, r: 'WA' as const }));
    const out = await service.createArenaRecord(saveInput(A, '满额', { ghost: { show: true, subs } }));
    expect(out.record.ghost.subs).toHaveLength(5000);
    await expect(
      service.createArenaRecord(saveInput(B, '超限', { ghost: { show: true, subs: [...subs, { p: 0, t: 1, r: 'AC' }] } })),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('工坊旧对象 restore 不接成绩条目；成绩 restore 不接对象条目', async () => {
    await initRoot();
    cacheBoard();
    await service.createArenaRecord(saveInput(A, 'A'));
    const a = service.listArenaRecords(arenaPath).records[0]!;
    const trashed = await service.trashArenaRecord({ arenaPath, recordId: A, expectedRevision: a.revision, confirm: true });
    await expect(service.restore(trashed.trashId)).rejects.toMatchObject({ kind: 'invalid' });

    const contest = await service.create({ kind: 'contest', title: '待删', arenaPath: otherArena });
    await service.trash(contest.id);
    await expect(service.restoreArenaRecord(contest.id)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('题组对象与关联（契约 26 §2 / §4 / §5；0..n 见契约 27）', () => {
  it('problemset 落 practice/<YYYY-MM>/，可带关联比赛；arenaPath 拒绝，templateId 受支持（2026-10-26 起）', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai', arenaPath: 'official/icpc/x/y.srk.json' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    expect(set.kind).toBe('problemset');
    expect(set.relPath).toBe('practice/2026-10/treedp');
    expect(set.parentId).toBe(contest.id);
    await expect(service.create({ kind: 'problemset', title: 'Bad', arenaPath: 'official/icpc/x/y.srk.json' })).rejects.toMatchObject({ kind: 'invalid' });
    const tpl = await service.create({ kind: 'template', title: 'T' });
    const withTpl = await service.create({ kind: 'problemset', title: 'WithTpl', templateId: tpl.id });
    expect(withTpl.kind).toBe('problemset');
    await expect(service.create({ kind: 'problemset', title: 'Bad', parentId: 'obj_0000000099' })).rejects.toMatchObject({ kind: 'parent-missing' });
    // 比赛不能带 parentId
    await expect(service.create({ kind: 'contest', title: 'Bad', parentId: contest.id })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('0..n：同一比赛可以被多个题组关联；adopt 也一样（27 §2.1）', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const a = await service.create({ kind: 'problemset', title: 'A', parentId: contest.id });
    const b = await service.create({ kind: 'problemset', title: 'B', parentId: contest.id });
    const c = await service.create({ kind: 'problemset', title: 'C', parentId: contest.id });
    for (const set of [a, b, c]) expect(set.parentId).toBe(contest.id);

    // adopt 同一个比赛也不再被占用拦截
    mkdirSync(join(absOf('practice/2026-10/adopted')), { recursive: true });
    const adopted = await service.adopt({ relPath: 'practice/2026-10/adopted', kind: 'problemset', title: 'Adopted', parentId: contest.id });
    expect(adopted.parentId).toBe(contest.id);

    // 题组侧仍只能一个比赛：换关联可以，但不能挂两个
    const moved = await service.update({ id: a.id, parentId: null });
    expect(moved.parentId).toBeNull();
    const relinked = await service.update({ id: a.id, parentId: contest.id });
    expect(relinked.parentId).toBe(contest.id);
    // 非题组不能改关联；关联对象必须是 contest
    await expect(service.update({ id: contest.id, parentId: null })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(service.update({ id: a.id, parentId: b.id })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('扫描不再把多个题组关联同一比赛报为冲突；父缺失仍警告', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const a = await service.create({ kind: 'problemset', title: 'A', parentId: contest.id });
    const b = await service.create({ kind: 'problemset', title: 'B', parentId: contest.id });
    const tree = await service.tree({ rescan: true });
    expect(tree.errors.some((e) => e.message.includes('同一个比赛'))).toBe(false);
    expect(tree.objects.filter((o) => o.kind === 'problemset')).toHaveLength(2);
    expect(tree.objects.find((o) => o.id === a.id)!.parentId).toBe(contest.id);
    expect(tree.objects.find((o) => o.id === b.id)!.parentId).toBe(contest.id);

    // 外部把一个题组的 parentId 改成不存在的对象 → 仍只警告，不报冲突
    const metaPath = join(absOf(b.relPath), '.anvil.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.parentId = 'obj_0000000099';
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const rescanned = await service.tree({ rescan: true });
    expect(rescanned.errors.some((e) => e.relPath === b.relPath && e.kind === 'parent-missing')).toBe(true);
    expect(rescanned.errors.some((e) => e.message.includes('同一个比赛'))).toBe(false);
    expect(rescanned.objects.some((o) => o.id === b.id)).toBe(true);
  });

  it('update 关联 / 换关联 / 清除关联；非题组拒绝', async () => {
    await initRoot();
    const c1 = await service.create({ kind: 'contest', title: 'Shanghai' });
    const c2 = await service.create({ kind: 'contest', title: 'Nanjing' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP' });
    expect(set.parentId).toBeNull();

    const linked = await service.update({ id: set.id, parentId: c1.id });
    expect(linked.parentId).toBe(c1.id);
    const moved = await service.update({ id: set.id, parentId: c2.id });
    expect(moved.parentId).toBe(c2.id);
    // c1 空出来后可以再被别的题组关联（0..n 本来就允许并存）
    const other = await service.create({ kind: 'problemset', title: 'Other', parentId: c1.id });
    expect(other.parentId).toBe(c1.id);
    // 清除后是普通题组，可再关联
    const cleared = await service.update({ id: other.id, parentId: null });
    expect(cleared.parentId).toBeNull();
    const again = await service.update({ id: other.id, parentId: c2.id });
    expect(again.parentId).toBe(c2.id);
  });

  it('生命周期独立：归档 / 回收比赛不影响题组；旧 problem 归档继承不变', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    const problem = await service.create({ kind: 'problem', title: 'Cherry', parentId: contest.id });

    await service.update({ id: contest.id, archived: true });
    let tree = await service.tree();
    const setRow = tree.objects.find((o) => o.id === set.id)!;
    expect(setRow.archived).toBe(false);
    expect(setRow.effectiveArchived).toBe(false);
    // 旧 problem 继承归档 → 活动视图里隐藏，归档视图可见
    expect(tree.objects.some((o) => o.id === problem.id)).toBe(false);
    const archivedTree = await service.tree({ archived: true });
    expect(archivedTree.objects.find((o) => o.id === problem.id)!.effectiveArchived).toBe(true);

    await service.update({ id: contest.id, archived: false });
    await service.trash(contest.id);
    tree = await service.tree();
    expect(tree.objects.some((o) => o.id === set.id)).toBe(true);
    expect(tree.errors.some((e) => e.relPath === set.relPath && e.kind === 'parent-missing')).toBe(true);
    // 关联仍在 meta 里，不自动清空
    expect(tree.objects.find((o) => o.id === set.id)!.parentId).toBe(contest.id);
  });
});

describe('归档冻结与跨归档关联（契约 27 §1 / §3 / §4）', () => {
  it('归档对象只出现在归档列表；活动列表 / 计数不包含它', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    await service.update({ id: set.id, archived: true });

    const active = await service.tree();
    expect(active.objects.some((o) => o.id === set.id)).toBe(false);
    expect(active.objects.some((o) => o.id === contest.id)).toBe(true);
    const archived = await service.tree({ archived: true });
    expect(archived.objects.some((o) => o.id === set.id)).toBe(true);
  });

  it('归档冻结：retitle / labels / parentId 被拒绝；取消归档后可编辑', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    await service.update({ id: set.id, archived: true });

    await expect(service.update({ id: set.id, title: 'Renamed' })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.update({ id: set.id, labels: ['x'] })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.update({ id: set.id, parentId: null })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.update({ id: set.id, parentId: contest.id })).rejects.toMatchObject({ kind: 'conflict' });
    // 取消归档是唯一允许的写操作；其余字段即便一起带上也拒绝
    await expect(service.update({ id: set.id, archived: false, title: 'Renamed' })).rejects.toMatchObject({ kind: 'conflict' });
    const unarchived = await service.update({ id: set.id, archived: false });
    expect(unarchived.archived).toBe(false);
    expect(unarchived.parentId).toBe(contest.id);

    const renamed = await service.update({ id: set.id, title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
    const cleared = await service.update({ id: set.id, parentId: null });
    expect(cleared.parentId).toBeNull();
  });

  it('归档对象不能直接移入回收站；取消归档后可以', async () => {
    await initRoot();
    const set = await service.create({ kind: 'problemset', title: 'TreeDP' });
    await service.update({ id: set.id, archived: true });
    await expect(service.trash(set.id)).rejects.toMatchObject({ kind: 'conflict' });
    await service.update({ id: set.id, archived: false });
    const trashed = await service.trash(set.id);
    expect(trashed.id).toBe(set.id);
  });

  it('跨归档关联：活动题组关联归档比赛被拒；清除也拒；取消归档后恢复可编辑（27 §1.7 / §2.4）', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const free = await service.create({ kind: 'contest', title: 'Nanjing' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    await service.update({ id: contest.id, archived: true });

    // 新建关联到归档比赛：create / adopt / update 一律拒绝（归档类拒绝统一 conflict，27 §4）
    await expect(service.create({ kind: 'problemset', title: 'New', parentId: contest.id })).rejects.toMatchObject({ kind: 'conflict' });
    mkdirSync(join(absOf('practice/2026-10/adopted-2')), { recursive: true });
    await expect(
      service.adopt({ relPath: 'practice/2026-10/adopted-2', kind: 'problemset', title: 'Adopted2', parentId: contest.id }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.update({ id: set.id, parentId: free.id })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.update({ id: set.id, parentId: null })).rejects.toMatchObject({ kind: 'conflict' });

    // 关联不自动清空；取消归档后恢复可编辑，可改挂到活动比赛
    const stillLinked = await service.object(set.id);
    expect(stillLinked.parentId).toBe(contest.id);
    await service.update({ id: contest.id, archived: false });
    const moved = await service.update({ id: set.id, parentId: free.id });
    expect(moved.parentId).toBe(free.id);
  });

  it('跨归档关联：归档题组关联活动比赛 → 对方保留、可只读查看；互不传播（27 §2.4）', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const set = await service.create({ kind: 'problemset', title: 'TreeDP', parentId: contest.id });
    await service.update({ id: set.id, archived: true });

    // 归档题组不在活动视图；比赛仍在且未受影响
    const active = await service.tree();
    expect(active.objects.some((o) => o.id === set.id)).toBe(false);
    expect(active.objects.find((o) => o.id === contest.id)!.archived).toBe(false);
    // 归档视图里题组的关联保留
    const archived = await service.tree({ archived: true });
    expect(archived.objects.find((o) => o.id === set.id)!.parentId).toBe(contest.id);
    // 比赛归档 / 回收互不影响题组的 meta
    await service.update({ id: set.id, archived: false });
    await service.update({ id: contest.id, archived: true });
    await service.update({ id: contest.id, archived: false });
    expect((await service.object(set.id)).parentId).toBe(contest.id);
  });

  it('旧 problem 兼容不回归：归档父比赛拒绝往里建题（26 §4.2 沿用）', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    await service.update({ id: contest.id, archived: true });
    await expect(service.create({ kind: 'problem', title: 'Cherry', parentId: contest.id })).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('继承归档同样冻结：父比赛归档时旧 problem 的 retitle / labels / trash 一律拒绝（判据 = effectiveArchived）', async () => {
    await initRoot();
    const contest = await service.create({ kind: 'contest', title: 'Shanghai' });
    const problem = await service.create({ kind: 'problem', title: 'Cherry', parentId: contest.id, templateId: null });
    await service.update({ id: contest.id, archived: true });

    // 它自己的 archived 仍是 false，但列表按继承把它当归档显示：服务端必须同一口径
    const before = await service.object(problem.id);
    expect(before.archived).toBe(false);
    expect((await service.tree({ archived: true })).objects.some((o) => o.id === problem.id)).toBe(true);

    await expect(service.update({ id: problem.id, title: 'Renamed' })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.update({ id: problem.id, labels: ['x'] })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.trash(problem.id)).rejects.toMatchObject({ kind: 'conflict' });

    // 解冻入口在父对象上：取消归档比赛后，旧 problem 才回到可编辑
    await service.update({ id: contest.id, archived: false });
    const renamed = await service.update({ id: problem.id, title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
  });
});
