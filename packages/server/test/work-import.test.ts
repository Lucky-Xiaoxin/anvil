import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { WorkImportCommitItemInput, WorkImportPlanDto, WorkImportResultDto } from '@anvil/shared';
import { initSchema } from '../src/db.ts';
import { WorkService } from '../src/work/store.ts';

let base: string;
let root: string;
let source: string;
let configRoot: string;
let now: Date;
let db: DatabaseSync;
let service: WorkService;

function makeService(limits?: Partial<Record<'maxDepth' | 'maxFiles' | 'maxBytes' | 'maxFileBytes' | 'maxCandidates', number>>): WorkService {
  return new WorkService({
    db,
    getRoot: () => configRoot,
    setRoot: (p) => {
      configRoot = p;
    },
    now: () => now,
    repoRoot: join(base, 'repo'),
    vaultDir: join(base, 'vault'),
    ...(limits === undefined ? {} : { importLimits: limits }),
  });
}

function writeAt(dir: string, rel: string, content = 'x'): void {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function writeSource(rel: string, content = 'x'): void {
  writeAt(source, rel, content);
}

function mkdirAt(dir: string, rel: string): void {
  mkdirSync(join(dir, ...rel.split('/')), { recursive: true });
}

async function scan(src = source): Promise<WorkImportPlanDto> {
  return service.importScan({ sourceRoot: src });
}

function defaultInput(plan: WorkImportPlanDto): WorkImportCommitItemInput[] {
  return plan.items.map((item) => ({
    itemId: item.itemId,
    selected: item.selectedByDefault,
    title: item.suggestedTitle,
  }));
}

async function commitDefault(plan: WorkImportPlanDto): Promise<WorkImportResultDto> {
  return service.importCommit({ planId: plan.planId, items: defaultInput(plan) });
}

function manifestFiles(): string[] {
  const dir = join(root, '.anvil', 'imports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

function readOnlyManifest(): Record<string, unknown> {
  const files = manifestFiles();
  const file = files[files.length - 1];
  if (file === undefined) throw new Error('没有 manifest');
  return JSON.parse(readFileSync(join(root, '.anvil', 'imports', file), 'utf8')) as Record<string, unknown>;
}

function writeManifest(name: string, data: unknown): void {
  const dir = join(root, '.anvil', 'imports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      out.push(`${entry.isDirectory() ? 'd' : 'f'}:${childRel}`);
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
    }
  };
  walk(dir, '');
  return out;
}

/** 一个题组目录：源码 + 附件 + 子目录 + README，全部归入同一个 contest 文件夹 */
function seedGroup(dir = source): void {
  writeAt(dir, 'A.cpp', 'int a;');
  writeAt(dir, 'A.in', '1');
  writeAt(dir, 'B.cpp', 'int b;');
  writeAt(dir, 'data/test.in', '2');
  writeAt(dir, 'README.md', 'group readme');
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'anvil-work-import-'));
  root = join(base, 'root');
  source = join(base, 'old-code');
  mkdirSync(source);
  mkdirSync(join(base, 'repo'));
  mkdirSync(join(base, 'vault'));
  configRoot = '';
  now = new Date(2026, 9, 22, 12, 0, 0);
  db = new DatabaseSync(':memory:');
  initSchema(db);
  service = makeService();
  await service.init({ path: root });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('源目录安全边界', () => {
  it('相对路径 / 盘符根 / UNC / 系统目录 / 文件 / 与受管根互为祖先全部拒绝', async () => {
    await expect(service.importScan({ sourceRoot: 'relative/path' })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    await expect(service.importScan({ sourceRoot: parse(source).root })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    await expect(service.importScan({ sourceRoot: '\\\\server\\share' })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    const file = join(base, 'not-a-dir.txt');
    writeFileSync(file, 'x');
    await expect(service.importScan({ sourceRoot: file })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    mkdirAt(root, 'inside');
    await expect(service.importScan({ sourceRoot: join(root, 'inside') })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    await expect(service.importScan({ sourceRoot: base })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    if (process.platform === 'win32') {
      await expect(service.importScan({ sourceRoot: 'C:\\Windows' })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    }
  });

  it('源路径组件是符号链接 / junction 时拒绝；源树内部链接只进忽略统计', async () => {
    const outside = join(base, 'outside');
    mkdirAt(source, 'child');
    try {
      symlinkSync(source, join(base, 'source-link'), 'junction');
    } catch {
      return;
    }
    await expect(service.importScan({ sourceRoot: join(base, 'source-link') })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    try {
      symlinkSync(source, join(base, 'link-parent'), 'junction');
    } catch {
      return;
    }
    await expect(service.importScan({ sourceRoot: join(base, 'link-parent', 'child') })).rejects.toMatchObject({
      kind: 'import-source-invalid',
    });

    try {
      symlinkSync(outside, join(source, 'linked'), 'junction');
    } catch {
      return;
    }
    const plan = await scan();
    expect(plan.totals.ignored).toBeGreaterThanOrEqual(1);
  });
});

describe('扫描：一个目录 = 一个题组', () => {
  it('整目录归入一个 contest 候选；扫描阶段不写受管根', async () => {
    seedGroup();
    const before = snapshotTree(root);
    const plan = await scan();
    expect(snapshotTree(root)).toEqual(before);
    expect(plan.totals).toMatchObject({ files: 5, candidates: 1, ignored: 0 });
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0]!;
    expect(item.shape).toBe('contest-group');
    expect(item.role).toBe('contest');
    expect(item.sourceRelPath).toBe('');
    expect(item.suggestedTitle).toBe('old-code');
    expect(item.files).toBe(5);
    expect(item.filePreview).toEqual(['A.cpp', 'A.in', 'B.cpp', 'README.md', 'data/test.in']);
    expect(item.reasons.join(' ')).toContain('整目录导入：5 个文件');
    expect(item.reasons.join(' ')).toContain('主源码 2 个');
    expect(item.selectedByDefault).toBe(true);
  });

  it('忽略表 / 空目录', async () => {
    writeSource('.git/config', 'x');
    writeSource('node_modules/a.js', 'x');
    writeSource('build/a.o', 'x');
    writeSource('A.exe', 'x');
    writeSource('Thumbs.db', 'x');
    writeSource('alpha.cpp', 'code');
    writeSource('alpha.in', 'in');
    const plan = await scan();
    expect(plan.totals.files).toBe(2);
    expect(plan.totals.ignored).toBeGreaterThanOrEqual(5);
    expect(plan.items).toHaveLength(1);
    expect(plan.warnings.join(' ')).toContain('已忽略');

    const empty = join(base, 'empty');
    mkdirSync(empty);
    const emptyPlan = await scan(empty);
    expect(emptyPlan.items).toHaveLength(0);
    expect(emptyPlan.warnings.join(' ')).toContain('没有识别出');
  });

  it('服务端限制：深度 / 文件数 / 总字节 / 单文件 / 候选数', async () => {
    const withLimits = async (limits: Parameters<typeof makeService>[0], make: (dir: string) => void): Promise<void> => {
      configRoot = '';
      service = makeService(limits);
      const otherRoot = join(base, `root-${Math.random().toString(16).slice(2)}`);
      const otherSource = join(base, `src-${Math.random().toString(16).slice(2)}`);
      mkdirSync(otherSource);
      make(otherSource);
      await service.init({ path: otherRoot });
      await expect(service.importScan({ sourceRoot: otherSource })).rejects.toMatchObject({ kind: 'import-limit' });
    };

    await withLimits({ maxDepth: 2 }, (dir) => writeAt(dir, 'a/b/c/deep.cpp'));
    await withLimits({ maxFiles: 2 }, (dir) => {
      writeAt(dir, 'a.cpp');
      writeAt(dir, 'b.cpp');
      writeAt(dir, 'c.cpp');
    });
    await withLimits({ maxBytes: 5 }, (dir) => writeAt(dir, 'big.cpp', '1234567890'));
    await withLimits({ maxFileBytes: 3 }, (dir) => writeAt(dir, 'big.cpp', '1234567890'));
    await withLimits({ maxCandidates: 0 }, (dir) => writeAt(dir, 'a.cpp'));
  });
});

describe('提交：整目录发布成一个题组', () => {
  it('文件原样保留相对路径，题目不再生成独立对象', async () => {
    seedGroup();
    const sourceBefore = snapshotTree(source);
    const plan = await scan();
    const result = await commitDefault(plan);

    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.status).toBe('success');
    expect(result.units[0]!.objects).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    const tree = await service.tree();
    expect(tree.objects).toHaveLength(1);
    const contest = tree.objects[0]!;
    // 5a-4：批量导入生成 problemset，落在 practice/<YYYY-MM>/（契约 26 §4.3 / §2.1）
    expect(contest.kind).toBe('problemset');
    expect(contest.title).toBe('old-code');
    expect(contest.relPath).toBe('practice/2026-10/old-code');
    expect(contest.fileCount).toBe(5);
    expect(contest.sourceCount).toBe(2);
    expect(contest.parentId).toBeNull();

    const detail = service.object(contest.id);
    expect(detail.files.map((file) => file.path)).toEqual(['A.cpp', 'A.in', 'B.cpp', 'README.md', 'data/test.in']);
    expect(snapshotTree(source)).toEqual(sourceBefore);
    expect(tree.objects.some((obj) => obj.kind === 'problem')).toBe(false);

    const manifest = readOnlyManifest();
    expect(manifest.status).toBe('completed');
    expect(manifest.sourceRoot).toBe(realpathSync(source));
    const units = manifest.units as Array<Record<string, unknown>>;
    expect(units).toHaveLength(1);
    expect((units[0]!.objectIds as string[]).length).toBe(1);
    expect((units[0]!.targetRelPaths as string[]).length).toBe(1);
    const items = manifest.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: 'import', status: 'success', kind: 'problemset', targetRelPath: contest.relPath });
    expect((items[0]!.fingerprint as string)).toHaveLength(64);
  });

  it('Windows 同一真实源路径的大小写变体仍按同源自动跳过', async () => {
    if (process.platform !== 'win32') return;
    seedGroup();
    await commitDefault(await scan());
    const alt = source.replace(/^[A-Za-z]:/, (m) => (m === m.toLowerCase() ? m.toUpperCase() : m.toLowerCase()));
    const plan = await scan(alt);
    expect(plan.items[0]!.duplicate).toMatchObject({ kind: 'same-source', state: 'same' });
    expect(plan.items[0]!.selectedByDefault).toBe(true);
    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(0);
    expect(result.skipped[0]!.kind).toBe('duplicate');
    expect((await service.tree()).objects).toHaveLength(1);
  });

  it('两个 plan 都在提交前扫过：后提交的自动跳过，不重复搬运', async () => {
    seedGroup();
    const first = await scan();
    const second = await scan();
    expect(first.items[0]!.duplicate).toBeNull();
    expect(second.items[0]!.duplicate).toBeNull();

    await commitDefault(first);
    const result = await commitDefault(second);
    expect(result.units).toHaveLength(0);
    expect(result.skipped[0]!.kind).toBe('duplicate');
    expect((await service.tree()).objects).toHaveLength(1);
  });

  it('扫描后历史目标消失：提交时重新核对，允许重新导入', async () => {
    seedGroup();
    await commitDefault(await scan());
    const contest = (await service.tree()).objects[0]!;
    const targetAbs = join(root, ...contest.relPath.split('/'));

    const stalePlan = await scan();
    expect(stalePlan.items[0]!.duplicate).toMatchObject({ kind: 'same-source', state: 'same' });
    rmSync(targetAbs, { recursive: true, force: true });

    const result = await commitDefault(stalePlan);
    expect(result.units[0]!.status).toBe('success');
    expect((await service.tree()).objects).toHaveLength(1);
  });

  it('同源同指纹重跑自动跳过；同一 plan 重复 commit 返回同一结果', async () => {
    seedGroup();
    const first = await commitDefault(await scan());
    const rescan = await scan();
    expect(rescan.items[0]!.duplicate).toMatchObject({ kind: 'same-source', state: 'same' });
    expect(rescan.items[0]!.selectedByDefault).toBe(true);

    const second = await commitDefault(rescan);
    expect(second.units).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.kind).toBe('duplicate');
    expect((await service.tree()).objects).toHaveLength(1);

    const plan = await scan();
    const input = defaultInput(plan);
    const a = await service.importCommit({ planId: plan.planId, items: input });
    const b = await service.importCommit({ planId: plan.planId, items: input });
    expect(b).toEqual(a);
    expect(first.batchId).not.toBe(second.batchId);
  });

  it('删除历史目标后允许重新导入；目标路径重名追加后缀', async () => {
    seedGroup();
    await commitDefault(await scan());
    const contest = (await service.tree()).objects[0]!;
    const targetAbs = join(root, ...contest.relPath.split('/'));
    rmSync(targetAbs, { recursive: true, force: true });

    const rescan = await scan();
    expect(rescan.items[0]!.duplicate).toBeNull();
    expect(rescan.items[0]!.reasons.join(' ')).toContain('历史导入目标已不存在');
    const result = await commitDefault(rescan);
    expect(result.units[0]!.status).toBe('success');
    expect(result.units[0]!.objects[0]!.relPath).toBe(contest.relPath);

    rmSync(targetAbs, { recursive: true, force: true });
    mkdirSync(targetAbs, { recursive: true });
    writeFileSync(join(targetAbs, 'occupied.txt'), 'keep');
    const conflictPlan = await scan();
    const conflict = await commitDefault(conflictPlan);
    expect(conflict.units[0]!.objects[0]!.relPath).toBe(`${contest.relPath}-2`);
    expect(readFileSync(join(targetAbs, 'occupied.txt'), 'utf8')).toBe('keep');
  });

  it('源文件修改 / 新增 / 删除都拒绝当前题组单元', async () => {
    const cases: Array<{ name: string; mutate: (dir: string) => void }> = [
      { name: 'changed', mutate: (dir) => writeAt(dir, 'A.cpp', 'changed') },
      { name: 'added', mutate: (dir) => writeAt(dir, 'C.cpp', 'new') },
      { name: 'deleted', mutate: (dir) => unlinkSync(join(dir, 'B.cpp')) },
    ];
    for (const [i, entry] of cases.entries()) {
      const dir = join(base, `case-${i}`);
      mkdirSync(dir);
      seedGroup(dir);
      const plan = await scan(dir);
      entry.mutate(dir);
      const result = await commitDefault(plan);
      expect(result.units).toHaveLength(1);
      expect(result.units[0]!.status).toBe('failed');
      expect(result.units[0]!.error?.kind).toBe('import-source-changed');
    }
  });

  it('同源新版本默认不选；选中后导入新副本', async () => {
    seedGroup();
    await commitDefault(await scan());
    writeSource('A.cpp', 'int a2;');
    const plan = await scan();
    expect(plan.items[0]!.duplicate).toMatchObject({ kind: 'same-source', state: 'new-version' });
    expect(plan.items[0]!.selectedByDefault).toBe(false);
    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: plan.items[0]!.itemId, selected: true }],
    });
    expect(result.units[0]!.status).toBe('success');
    expect((await service.tree()).objects.map((obj) => obj.relPath).sort()).toEqual([
      'practice/2026-10/old-code',
      'practice/2026-10/old-code-2',
    ]);
  });

  it('不同源同内容标潜在重复；keepDuplicate 后才导入', async () => {
    seedGroup();
    await commitDefault(await scan());
    const source2 = join(base, 'old-code-copy');
    mkdirSync(source2);
    seedGroup(source2);
    const plan = await scan(source2);
    expect(plan.items[0]!.duplicate).toMatchObject({ kind: 'same-content' });
    expect(plan.items[0]!.selectedByDefault).toBe(false);

    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [{ itemId: plan.items[0]!.itemId, selected: true }],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });

    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: plan.items[0]!.itemId, selected: true, keepDuplicate: true }],
    });
    expect(result.units[0]!.status).toBe('success');
    expect((await service.tree()).objects).toHaveLength(2);
  });

  it('选择非法 / 标题超长 / 未选择都 400 且不写 manifest', async () => {
    seedGroup();
    const plan = await scan();
    const item = plan.items[0]!;
    await expect(
      service.importCommit({ planId: plan.planId, items: [{ itemId: 'item_999', selected: true }] }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [
          { itemId: item.itemId, selected: true },
          { itemId: item.itemId, selected: false },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(service.importCommit({ planId: plan.planId, items: [] })).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [{ itemId: item.itemId, selected: true, title: 'x'.repeat(121) }],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    expect(manifestFiles()).toHaveLength(0);
  });

  it('计划过期 / 切换受管根 / 超过保留数量', async () => {
    seedGroup();
    const plan = await scan();
    const input = defaultInput(plan);
    now = new Date(now.getTime() + 31 * 60 * 1000);
    await expect(service.importCommit({ planId: plan.planId, items: input })).rejects.toMatchObject({ kind: 'import-plan-expired' });

    now = new Date(2026, 9, 22, 12, 0, 0);
    const plan2 = await scan();
    const otherRoot = join(base, 'root-2');
    await service.init({ path: otherRoot });
    await expect(service.importCommit({ planId: plan2.planId, items: defaultInput(plan2) })).rejects.toMatchObject({
      kind: 'import-root-changed',
    });

    configRoot = root;
    await service.init({ path: root });
    await scan();
    await scan();
    await scan();
    await scan();
    await expect(service.importCommit({ planId: plan2.planId, items: defaultInput(plan2) })).rejects.toMatchObject({
      kind: 'import-plan-expired',
    });
  });

  it('导入前后源文件字节不变', async () => {
    seedGroup();
    const before = snapshotTree(source);
    const contents = new Map<string, string>();
    const collect = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) collect(abs);
        else if (entry.isFile()) contents.set(abs, readFileSync(abs, 'utf8'));
      }
    };
    collect(source);
    await commitDefault(await scan());
    for (const [abs, content] of contents) expect(readFileSync(abs, 'utf8')).toBe(content);
    expect(snapshotTree(source)).toEqual(before);
  });
});

/** 5a-3：一个旧根下多层目录，叶子 / 容器 / 散题同时存在 */
function seedBatch(dir = source): void {
  writeAt(dir, 'root.txt', 'root');
  writeAt(dir, '2026/10/10.ptc/A.cpp', 'int a;');
  writeAt(dir, '2026/10/10.ptc/data/1.in', '1');
  writeAt(dir, '2026/10/17.VP/a.cpp', 'int b;');
  writeAt(dir, '2026/10/TreeDP/sol.cpp', 'int c;');
  writeAt(dir, '2026/10/Moban.cpp', 'template');
  writeAt(dir, '2026/10/runner.cpp', 'runner');
  writeAt(dir, '2026/7/A.cpp', 'int d;');
  writeAt(dir, '2026_ICPC_1/sol.cpp', 'int e;');
}

function itemAt(plan: WorkImportPlanDto, sourceRelPath: string, scope: 'subtree' | 'direct' = 'subtree') {
  const item = plan.items.find((x) => x.sourceRelPath === sourceRelPath && x.scope === scope);
  if (item === undefined) throw new Error(`缺少候选：${sourceRelPath}:${scope}`);
  return item;
}

describe('批量题组导入（5a-3 契约 §4 / §5 / §7）', () => {
  it('扫描返回容器 / 叶子 / 散题，默认只选叶子且父子不冲突', async () => {
    seedBatch();
    const before = snapshotTree(root);
    const plan = await scan();
    expect(snapshotTree(root)).toEqual(before);

    expect(itemAt(plan, '').isContainer).toBe(true);
    expect(itemAt(plan, '').selectedByDefault).toBe(false);
    expect(itemAt(plan, '2026').isContainer).toBe(true);
    expect(itemAt(plan, '2026/10').isContainer).toBe(true);
    expect(itemAt(plan, '2026/10').selectedByDefault).toBe(false);
    expect(itemAt(plan, '2026/10', 'direct').selectedByDefault).toBe(false);
    expect(itemAt(plan, '2026/10', 'direct').files).toBe(2);

    const selected = plan.items.filter((item) => item.selectedByDefault).map((item) => `${item.sourceRelPath}:${item.scope}`).sort();
    expect(selected).toEqual([
      '2026/10/10.ptc:subtree',
      '2026/10/17.VP:subtree',
      '2026/10/TreeDP:subtree',
      '2026/7:subtree',
      '2026_ICPC_1:subtree',
    ]);
  });

  it('一次提交多个叶子题组：平铺在 practice/，kind=problemset，sourcePath 写进 meta 并在重扫后保留', async () => {
    seedBatch();
    const plan = await scan();
    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(5);
    expect(result.units.every((unit) => unit.status === 'success' && unit.objects.length === 1)).toBe(true);
    expect(result.skipped.every((item) => item.kind === 'user')).toBe(true);

    const tree = await service.tree({ rescan: true });
    const contests = tree.objects.filter((obj) => obj.kind === 'problemset');
    expect(contests).toHaveLength(5);
    expect(contests.every((obj) => obj.parentId === null)).toBe(true);
    expect(tree.objects.some((obj) => obj.kind === 'problem')).toBe(false);
    expect(contests.map((obj) => obj.sourcePath).sort()).toEqual([
      '2026/10/10.ptc',
      '2026/10/17.VP',
      '2026/10/TreeDP',
      '2026/7',
      '2026_ICPC_1',
    ]);
    // 扁平落盘：只在 practice/<YYYY-MM>/ 下，不复制来源目录结构（契约 25 §1.4 / 26 §2.1）
    expect(contests.every((obj) => obj.relPath.startsWith('practice/'))).toBe(true);
    expect(contests.every((obj) => !/\/2026\//.test(obj.relPath))).toBe(true);

    const contest = contests.find((obj) => obj.sourcePath === '2026/10/10.ptc')!;
    const meta = JSON.parse(readFileSync(join(root, ...contest.relPath.split('/'), '.anvil.json'), 'utf8'));
    expect(meta.sourcePath).toBe('2026/10/10.ptc');

    service = makeService();
    configRoot = root;
    const reopened = await service.tree({ rescan: true });
    expect(reopened.objects.find((obj) => obj.id === contest.id)?.sourcePath).toBe('2026/10/10.ptc');

    const manifest = readOnlyManifest();
    expect(manifest.status).toBe('completed');
    const items = manifest.items as Array<Record<string, unknown>>;
    const imported = items.filter((item) => item.action === 'import');
    expect(imported).toHaveLength(5);
    expect(imported.every((item) => item.scope === 'subtree')).toBe(true);
    expect(items.some((item) => item.scope === 'direct')).toBe(true);
  });

  it('明确选中容器整体：只生成一个题组，散题与后代不再重复', async () => {
    seedBatch();
    const plan = await scan();
    const container = itemAt(plan, '2026/10');
    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: container.itemId, selected: true, title: '十月训练' }],
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.status).toBe('success');
    const tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(1);
    const contest = tree.objects[0]!;
    expect(contest.title).toBe('十月训练');
    expect(contest.sourcePath).toBe('2026/10');
    const detail = service.object(contest.id);
    expect(detail.files.map((file) => file.path)).toEqual([
      '10.ptc/A.cpp',
      '10.ptc/data/1.in',
      '17.VP/a.cpp',
      'Moban.cpp',
      'TreeDP/sol.cpp',
      'runner.cpp',
    ]);
  });

  it('散题只复制直接文件；父子同选与散题/整目录同选被拒绝', async () => {
    seedBatch();
    const plan = await scan();
    const scatter = itemAt(plan, '2026/10', 'direct');
    const leaf = itemAt(plan, '2026/10/10.ptc');
    const container = itemAt(plan, '2026/10');

    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [
          { itemId: container.itemId, selected: true },
          { itemId: leaf.itemId, selected: true },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [
          { itemId: scatter.itemId, selected: true },
          { itemId: container.itemId, selected: true },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    expect(manifestFiles()).toHaveLength(0);

    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: scatter.itemId, selected: true }],
    });
    expect(result.units).toHaveLength(1);
    const tree = await service.tree({ rescan: true });
    const contest = tree.objects[0]!;
    expect(contest.title).toBe('10 散题');
    expect(contest.sourcePath).toBe('2026/10');
    expect(service.object(contest.id).files.map((file) => file.path)).toEqual(['Moban.cpp', 'runner.cpp']);
  });

  it('部分成功：一个叶子源变化只让该单元失败，其它单元照常发布', async () => {
    seedBatch();
    const plan = await scan();
    writeAt(source, '2026/10/17.VP/a.cpp', 'changed');
    const result = await commitDefault(plan);
    const failed = result.units.filter((unit) => unit.status === 'failed');
    const success = result.units.filter((unit) => unit.status === 'success');
    expect(failed).toHaveLength(1);
    expect(success).toHaveLength(4);
    const failedItem = plan.items.find((item) => item.itemId === failed[0]!.itemIds[0])!;
    expect(failedItem.sourceRelPath).toBe('2026/10/17.VP');
    expect(failed[0]!.error?.kind).toBe('import-source-changed');
    expect((await service.tree({ rescan: true })).objects).toHaveLength(4);
    expect(readOnlyManifest().status).toBe('partial');
  });

  it('去重键含 scope：同源同 scope 跳过，不同 scope 不误跳过', async () => {
    seedBatch();
    const first = await scan();
    await service.importCommit({
      planId: first.planId,
      items: [{ itemId: itemAt(first, '2026/10', 'direct').itemId, selected: true }],
    });

    const rescan = await scan();
    expect(itemAt(rescan, '2026/10', 'direct').duplicate).toMatchObject({ kind: 'same-source', state: 'same' });
    expect(itemAt(rescan, '2026/10', 'direct').selectedByDefault).toBe(true);
    expect(itemAt(rescan, '2026/10').duplicate).toBeNull();
    const skipped = await commitDefault(rescan);
    expect(skipped.units.some((unit) => unit.status === 'success')).toBe(true);
    expect(skipped.skipped.some((item) => item.kind === 'duplicate')).toBe(true);
  });

  it('混合目录可整体导入：父目录的散题只含直接文件，整体导入包含子目录', async () => {
    writeSource('parent/P.cpp', 'int p;');
    writeSource('parent/notes.txt', 'notes');
    writeSource('parent/kid/K.cpp', 'int k;');
    const plan = await scan();

    const parent = itemAt(plan, 'parent');
    expect(parent.isContainer).toBe(false);
    expect(parent.files).toBe(3);
    const scatter = itemAt(plan, 'parent', 'direct');
    expect(scatter.files).toBe(2);
    // 混合目录祖先优先：parent 保持默认选中，kid 让位
    expect(parent.selectedByDefault).toBe(true);
    expect(itemAt(plan, 'parent/kid').selectedByDefault).toBe(false);

    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: parent.itemId, selected: true }],
    });
    expect(result.units).toHaveLength(1);
    const tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(1);
    const contest = tree.objects[0]!;
    expect(contest.sourcePath).toBe('parent');
    expect(service.object(contest.id).files.map((file) => file.path)).toEqual(['P.cpp', 'kid/K.cpp', 'notes.txt']);
  });

  it('默认祖先优先：混合目录按默认选择提交只生成一个整目录题组，子目录不重复', async () => {
    writeSource('parent/P.cpp', 'int p;');
    writeSource('parent/notes.txt', 'notes');
    writeSource('parent/kid/K.cpp', 'int k;');
    // 同层再放一个叶子，避免源根自身成为唯一祖先，专门验证 parent / kid 的默认取舍
    writeSource('other/O.cpp', 'int o;');
    const plan = await scan();
    expect(plan.items.filter((item) => item.selectedByDefault).map((item) => `${item.sourceRelPath}:${item.scope}`).sort()).toEqual([
      'other:subtree',
      'parent:subtree',
    ]);

    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(2);
    expect(result.units.every((unit) => unit.status === 'success')).toBe(true);
    const tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(2);
    const parentContest = tree.objects.find((object) => object.sourcePath === 'parent')!;
    expect(service.object(parentContest.id).files.map((file) => file.path)).toEqual(['P.cpp', 'kid/K.cpp', 'notes.txt']);
    expect(tree.objects.some((object) => object.sourcePath === 'parent/kid')).toBe(false);
  });

  it('同批不同源同内容：全部候选默认不选，保留副本才可导入', async () => {
    writeAt(source, 'mirror/a/X.cpp', 'same-content');
    writeAt(source, 'mirror/b/X.cpp', 'same-content');
    writeSource('solo/S.cpp', 'int s;');
    const plan = await scan();
    const a = itemAt(plan, 'mirror/a');
    const b = itemAt(plan, 'mirror/b');

    expect(a.duplicate).toMatchObject({ kind: 'same-content' });
    expect(b.duplicate).toMatchObject({ kind: 'same-content' });
    expect(a.selectedByDefault).toBe(false);
    expect(b.selectedByDefault).toBe(false);
    expect(plan.items.filter((item) => item.selectedByDefault).map((item) => `${item.sourceRelPath}:${item.scope}`)).toEqual([
      'solo:subtree',
    ]);

    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [{ itemId: a.itemId, selected: true }],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });

    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: a.itemId, selected: true, keepDuplicate: true }],
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.status).toBe('success');
    expect((await service.tree({ rescan: true })).objects).toHaveLength(1);
  });

  it('多单元同标题：目标路径自动追加 -2，来源各自独立', async () => {
    writeAt(source, '2026/1/A/A.cpp', 'one');
    writeAt(source, '2026/2/A/A.cpp', 'two');
    const plan = await scan();
    expect(plan.items.filter((item) => item.selectedByDefault)).toHaveLength(2);

    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(2);
    expect(result.units.every((unit) => unit.status === 'success')).toBe(true);
    const tree = await service.tree({ rescan: true });
    expect(tree.objects.map((obj) => obj.sourcePath).sort()).toEqual(['2026/1/A', '2026/2/A']);
    expect(tree.objects.map((obj) => obj.relPath).sort()).toEqual([
      'practice/2026-10/a',
      'practice/2026-10/a-2',
    ]);
  });

  it('sourcePath 在改名 / 打标 / 回收站恢复后保留', async () => {
    writeSource('2026/10/10.ptc/A.cpp', 'int a;');
    await commitDefault(await scan());
    let tree = await service.tree({ rescan: true });
    const contest = tree.objects[0]!;
    expect(contest.sourcePath).toBe('2026/10/10.ptc');

    await service.update({ id: contest.id, title: '改名题组', labels: ['赛时'] });
    tree = await service.tree({ rescan: true });
    expect(tree.objects[0]).toMatchObject({ title: '改名题组', labels: ['赛时'], sourcePath: '2026/10/10.ptc' });

    await service.trash(contest.id);
    tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(0);
    await service.restore(contest.id);
    tree = await service.tree({ rescan: true });
    expect(tree.objects[0]).toMatchObject({ title: '改名题组', sourcePath: '2026/10/10.ptc' });
    const meta = JSON.parse(readFileSync(join(root, ...tree.objects[0]!.relPath.split('/'), '.anvil.json'), 'utf8'));
    expect(meta.sourcePath).toBe('2026/10/10.ptc');
  });

  it('源根自身作为题组时不写 sourcePath', async () => {
    writeSource('A.cpp', 'int a;');
    const plan = await scan();
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.sourceRelPath).toBe('');
    const result = await commitDefault(plan);
    expect(result.units[0]!.status).toBe('success');

    const tree = await service.tree({ rescan: true });
    expect(tree.objects[0]!.sourcePath).toBeUndefined();
    const meta = JSON.parse(readFileSync(join(root, ...tree.objects[0]!.relPath.split('/'), '.anvil.json'), 'utf8'));
    expect(meta).not.toHaveProperty('sourcePath');
  });

  it('中文 / 空格来源路径写入 sourcePath，重扫后仍保留', async () => {
    writeSource('2026年/十月 训练/10.ptc/A.cpp', 'int a;');
    const plan = await scan();
    const leaf = itemAt(plan, '2026年/十月 训练/10.ptc');
    expect(leaf.selectedByDefault).toBe(true);
    expect(leaf.suggestedTitle).toBe('10.ptc');

    await commitDefault(plan);
    const tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(1);
    expect(tree.objects[0]!.sourcePath).toBe('2026年/十月 训练/10.ptc');
    expect((await service.tree({ rescan: true })).objects[0]!.sourcePath).toBe('2026年/十月 训练/10.ptc');
  });
});

describe('目标路径安全边界（junction 不得写去受管根外）', () => {
  function linkOutside(name: string, linkAbs: string): string | null {
    const outside = join(base, name);
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, linkAbs, 'junction');
      return outside;
    } catch {
      return null;
    }
  }

  it('practice 桶（5a-4 起导入目标）是 junction：提交拒绝，根外零写入', async () => {
    seedGroup();
    const practiceAbs = join(root, 'practice');
    rmSync(practiceAbs, { recursive: true, force: true });
    const outside = linkOutside('outside-practice', practiceAbs);
    if (outside === null) return;

    const plan = await scan();
    await expect(service.importCommit({ planId: plan.planId, items: defaultInput(plan) })).rejects.toMatchObject({
      kind: 'unsafe-path',
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('import-staging 是 junction：单元失败，根外零写入', async () => {
    seedGroup();
    const outside = linkOutside('outside-staging', join(root, '.anvil', 'import-staging'));
    if (outside === null) return;

    const plan = await scan();
    const result = await commitDefault(plan);
    expect(result.units[0]!.status).toBe('failed');
    expect(result.units[0]!.error?.kind).toBe('unsafe-path');
    expect(readdirSync(outside)).toEqual([]);
    expect(manifestFiles()).toHaveLength(1);
  });

  it('.anvil/imports 是 junction：提交拒绝，根外零写入', async () => {
    seedGroup();
    const outside = linkOutside('outside-imports', join(root, '.anvil', 'imports'));
    if (outside === null) return;

    const plan = await scan();
    await expect(service.importCommit({ planId: plan.planId, items: defaultInput(plan) })).rejects.toMatchObject({
      kind: 'unsafe-path',
    });
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('journal / 恢复', () => {
  it('多单元批次恢复：逐单元按 objectId / targetRelPath 对账', async () => {
    writeAt(source, 'A/A.cpp', 'int a;');
    writeAt(source, 'B/B.cpp', 'int b;');
    const result = await commitDefault(await scan());
    expect(result.units).toHaveLength(2);

    const manifest = readOnlyManifest();
    manifest.status = 'running';
    manifest.finishedAt = null;
    for (const unit of manifest.units as Array<Record<string, unknown>>) unit.state = 'published';
    for (const item of manifest.items as Array<Record<string, unknown>>) if (item.action === 'import') item.status = 'pending';
    writeManifest(manifestFiles()[0]!, manifest);

    const recovered = await service.recoverImports();
    expect(recovered.warnings).toHaveLength(0);
    const after = readOnlyManifest();
    expect(after.status).toBe('completed');
    expect((after.units as Array<Record<string, unknown>>).map((unit) => unit.state)).toEqual(['success', 'success']);
  });

  it('staged 且最终路径存在：补写 success', async () => {
    seedGroup();
    await commitDefault(await scan());
    const manifest = readOnlyManifest();
    manifest.status = 'running';
    manifest.finishedAt = null;
    (manifest.units as Array<Record<string, unknown>>)[0]!.state = 'staged';
    for (const item of manifest.items as Array<Record<string, unknown>>) if (item.action === 'import') item.status = 'pending';
    writeManifest(manifestFiles()[0]!, manifest);

    const recovered = await service.recoverImports();
    expect(recovered.warnings).toHaveLength(0);
    const after = readOnlyManifest();
    expect(after.status).toBe('completed');
    expect((after.units as Array<Record<string, unknown>>)[0]!.state).toBe('success');
  });

  it('published 缺任一 objectId：标记失败并保留现场', async () => {
    seedGroup();
    const result = await commitDefault(await scan());
    const object = result.units[0]!.objects[0]!;
    unlinkSync(join(root, ...object.relPath.split('/'), '.anvil.json'));
    const manifest = readOnlyManifest();
    manifest.status = 'running';
    manifest.finishedAt = null;
    (manifest.units as Array<Record<string, unknown>>)[0]!.state = 'published';
    for (const item of manifest.items as Array<Record<string, unknown>>) if (item.action === 'import') item.status = 'pending';
    writeManifest(manifestFiles()[0]!, manifest);

    const recovered = await service.recoverImports();
    expect(recovered.warnings.join(' ')).toContain('失败单元');
    const after = readOnlyManifest();
    expect(after.status).toBe('failed');
    expect(existsSync(join(root, ...object.relPath.split('/')))).toBe(true);
  });

  it('多 objectId 单元：缺一个就整单元失败', async () => {
    seedGroup();
    const first = await commitDefault(await scan());
    const source2 = join(base, 'second-group');
    mkdirSync(source2);
    writeAt(source2, 'C.cpp', 'int c;');
    const second = await commitDefault(await scan(source2));
    const a = first.units[0]!.objects[0]!;
    const b = second.units[0]!.objects[0]!;
    unlinkSync(join(root, ...b.relPath.split('/'), '.anvil.json'));
    const batchId = 'imp_ffffffff09';
    writeManifest(`99999999-999999_${batchId}.json`, {
      schema: 1,
      batchId,
      sourceRoot: source,
      workspace: { realPath: root, rootCreatedAt: '2026-10-22T00:00:00.000Z' },
      createdAt: '2026-10-22T12:00:00.000Z',
      finishedAt: null,
      status: 'running',
      units: [
        {
          unitId: 'unit_1',
          state: 'published',
          objectIds: [a.objectId, b.objectId],
          targetRelPaths: [a.relPath, b.relPath],
          itemIds: ['item_1', 'item_2'],
        },
      ],
      items: [
        {
          itemId: 'item_1',
          unitId: 'unit_1',
          sourceRelPath: '',
          sourceMtime: 0,
          fingerprint: 'f'.repeat(64),
          action: 'import',
          kind: 'contest',
          title: 'a',
          parentItemId: null,
          objectId: a.objectId,
          targetRelPath: a.relPath,
          status: 'pending',
        },
        {
          itemId: 'item_2',
          unitId: 'unit_1',
          sourceRelPath: '',
          sourceMtime: 0,
          fingerprint: 'f'.repeat(64),
          action: 'import',
          kind: 'contest',
          title: 'b',
          parentItemId: null,
          objectId: b.objectId,
          targetRelPath: b.relPath,
          status: 'pending',
        },
      ],
    });
    const recovered = await service.recoverImports();
    expect(recovered.warnings.join(' ')).toContain('失败单元');
    const fake = JSON.parse(readFileSync(join(root, '.anvil', 'imports', `99999999-999999_${batchId}.json`), 'utf8'));
    expect(fake.status).toBe('failed');
    expect(existsSync(join(root, ...a.relPath.split('/')))).toBe(true);
    expect(existsSync(join(root, ...b.relPath.split('/')))).toBe(true);
  });

  it('planned / staged 且最终路径不存在：清理合法 staging 后标 failed', async () => {
    const batchId = 'imp_0123456789';
    const unitId = 'unit_1';
    const staging = join(root, '.anvil', 'import-staging', batchId);
    mkdirSync(join(staging, unitId), { recursive: true });
    writeFileSync(join(staging, `${unitId}.staging.json`), JSON.stringify({ schema: 1, batchId, unitId }), 'utf8');
    writeFileSync(join(staging, unitId, 'left.txt'), 'left', 'utf8');
    writeManifest(`20261022-120000_${batchId}.json`, {
      schema: 1,
      batchId,
      sourceRoot: source,
      workspace: { realPath: root, rootCreatedAt: '2026-10-22T00:00:00.000Z' },
      createdAt: '2026-10-22T12:00:00.000Z',
      finishedAt: null,
      status: 'running',
      units: [
        {
          unitId,
          state: 'staged',
          objectIds: ['obj_aaaaaaaaaa'],
          targetRelPaths: ['practice/2026-10/nope'],
          itemIds: ['item_1'],
        },
      ],
      items: [
        {
          itemId: 'item_1',
          unitId,
          sourceRelPath: '',
          sourceMtime: 0,
          fingerprint: 'f'.repeat(64),
          action: 'import',
          kind: 'contest',
          title: 'nope',
          parentItemId: null,
          status: 'pending',
        },
      ],
    });

    const recovered = await service.recoverImports();
    expect(recovered.warnings.join(' ')).toContain('失败单元');
    expect(existsSync(join(staging, unitId))).toBe(false);
    expect(readOnlyManifest().status).toBe('failed');
  });

  it('坏 manifest 只产生警告，不影响对象树与扫描', async () => {
    seedGroup();
    await commitDefault(await scan());
    writeManifest('broken_manifest.json', { nope: true });
    const tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(1);
    const plan = await scan();
    expect(plan.warnings.join(' ')).toContain('manifest 损坏');
  });
});
