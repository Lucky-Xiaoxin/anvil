import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

function writeSource(rel: string, content = 'x'): void {
  const abs = join(source, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function mkdirSource(rel: string): void {
  mkdirSync(join(source, ...rel.split('/')), { recursive: true });
}

async function scan(src = source): Promise<WorkImportPlanDto> {
  return service.importScan({ sourceRoot: src });
}

function itemOf(plan: WorkImportPlanDto, sourceRelPath: string) {
  const item = plan.items.find((x) => x.sourceRelPath === sourceRelPath);
  if (item === undefined) throw new Error(`plan 缺少 ${sourceRelPath}: ${plan.items.map((x) => x.sourceRelPath).join(', ')}`);
  return item;
}

function defaultInput(plan: WorkImportPlanDto): WorkImportCommitItemInput[] {
  return plan.items.map((item) => ({
    itemId: item.itemId,
    selected: item.selectedByDefault,
    title: item.suggestedTitle,
    ...(item.role === 'undecided' && item.selectedByDefault ? { confirmUndecidedAsProblem: true } : {}),
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

function readOnlyManifest(pred: (name: string) => boolean = () => true): Record<string, unknown> {
  const files = manifestFiles().filter(pred);
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

describe('源目录安全边界（契约 §4.1）', () => {
  it('相对路径 / 盘符根 / UNC / 系统目录 / 文件 / 与受管根互为祖先全部拒绝', async () => {
    await expect(service.importScan({ sourceRoot: 'relative/path' })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    await expect(service.importScan({ sourceRoot: parse(source).root })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    await expect(service.importScan({ sourceRoot: '\\\\server\\share' })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    const file = join(base, 'not-a-dir.txt');
    writeFileSync(file, 'x');
    await expect(service.importScan({ sourceRoot: file })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    mkdirSync(join(root, 'inside'));
    await expect(service.importScan({ sourceRoot: join(root, 'inside') })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    await expect(service.importScan({ sourceRoot: base })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    if (process.platform === 'win32') {
      await expect(service.importScan({ sourceRoot: 'C:\\Windows' })).rejects.toMatchObject({ kind: 'import-source-invalid' });
    }
  });

  it('源目录 / 子目录是符号链接或 junction 时拒绝整次扫描', async () => {
    const outside = join(base, 'outside');
    mkdirSource('nested');
    try {
      symlinkSync(source, join(base, 'source-link'), 'junction');
    } catch {
      return; // Windows 未开开发者模式时跳过
    }
    await expect(service.importScan({ sourceRoot: join(base, 'source-link') })).rejects.toMatchObject({ kind: 'import-source-invalid' });

    const linkParent = join(base, 'link-parent');
    try {
      symlinkSync(source, linkParent, 'junction');
    } catch {
      return;
    }
    mkdirSource('child');
    await expect(service.importScan({ sourceRoot: join(linkParent, 'child') })).rejects.toMatchObject({
      kind: 'import-source-invalid',
    });

    // 源树内部的链接按契约 §4.3 进入忽略统计，不复制、也不拒绝整次扫描
    const innerLink = join(source, 'linked');
    try {
      symlinkSync(outside, innerLink, 'junction');
    } catch {
      return;
    }
    const plan = await scan();
    expect(plan.totals.ignored).toBeGreaterThanOrEqual(1);
  });
});

describe('扫描 / 预览（契约 §4.3 / §5）', () => {
  it('识别比赛题组 + 未分组题目；只读扫描不写受管根', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'int a;');
    writeSource('contestA/A.in', '1');
    writeSource('contestA/B/solution.cpp', 'int b;');
    writeSource('contestA/B/test.in', '2');
    writeSource('alpha/solution.cpp', 'alpha');
    writeSource('beta/solution.cpp', 'beta');
    const before = snapshotTree(root);

    const plan = await scan();
    expect(snapshotTree(root)).toEqual(before);
    expect(plan.totals).toMatchObject({ files: 7, candidates: 5, ignored: 0 });

    const contest = itemOf(plan, 'contestA');
    expect(contest.shape).toBe('contest-group');
    expect(contest.role).toBe('contest');
    expect(contest.suggestedTitle).toBe('contestA');
    expect(contest.files).toBe(1);
    expect(contest.selectedByDefault).toBe(true);
    expect(contest.reasons.join(' ')).toContain('比赛共享文件 1 个');

    const a = itemOf(plan, 'contestA/A.cpp');
    expect(a.role).toBe('problem');
    expect(a.parentItemId).toBe(contest.itemId);
    expect(a.unitId).toBe(contest.unitId);
    expect(a.files).toBe(2);
    expect(a.suggestedTitle).toBe('A');
    expect(a.selectedByDefault).toBe(true);

    const b = itemOf(plan, 'contestA/B');
    expect(b.shape).toBe('problem-dir');
    expect(b.parentItemId).toBe(contest.itemId);
    expect(b.suggestedTitle).toBe('B');

    const alpha = itemOf(plan, 'alpha');
    expect(alpha.shape).toBe('problem-dir');
    expect(alpha.parentItemId).toBeNull();
    expect(alpha.unitId).toBe(alpha.itemId);
    expect(alpha.selectedByDefault).toBe(true);
  });

  it('忽略表覆盖依赖目录 / 编译产物 / 点文件，并统计忽略项', async () => {
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
  });

  it('空目录 / 无候选时不报错，给出警告', async () => {
    const plan = await scan();
    expect(plan.items).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain('没有识别出');
  });

  it('单文件题带同 stem 附件；未判定项默认不选', async () => {
    writeSource('solo.cpp', 'code');
    writeSource('solo.out', 'out');
    writeSource('misc/note.txt', 'note');
    const plan = await scan();
    const solo = itemOf(plan, 'solo.cpp');
    expect(solo.files).toBe(2);
    expect(solo.selectedByDefault).toBe(true);
    const misc = itemOf(plan, 'misc');
    expect(misc.shape).toBe('undecided');
    expect(misc.role).toBe('undecided');
    expect(misc.selectedByDefault).toBe(false);
  });

  it('服务端限制：深度 / 文件数 / 总字节 / 单文件 / 候选数', async () => {
    const withLimits = async (limits: Parameters<typeof makeService>[0], make: () => void): Promise<void> => {
      mkdirSync(join(base, 'repo'), { recursive: true });
      configRoot = '';
      service = makeService(limits);
      const otherRoot = join(base, `root-${Math.random().toString(16).slice(2)}`);
      const otherSource = join(base, `src-${Math.random().toString(16).slice(2)}`);
      mkdirSync(otherSource);
      const oldSource = source;
      source = otherSource;
      make();
      await service.init({ path: otherRoot });
      await expect(service.importScan({ sourceRoot: otherSource })).rejects.toMatchObject({ kind: 'import-limit' });
      source = oldSource;
    };

    await withLimits({ maxDepth: 2 }, () => writeSource('a/b/c/deep.cpp', 'x'));
    await withLimits({ maxFiles: 2 }, () => {
      writeSource('a.cpp', 'x');
      writeSource('b.cpp', 'x');
      writeSource('c.cpp', 'x');
    });
    await withLimits({ maxBytes: 5 }, () => writeSource('big.cpp', '1234567890'));
    await withLimits({ maxFileBytes: 3 }, () => writeSource('big.cpp', '1234567890'));
    await withLimits({ maxCandidates: 1 }, () => {
      writeSource('alpha/solution.cpp', 'a');
      writeSource('beta/solution.cpp', 'b');
    });
  });
});

describe('提交 / 原子发布（契约 §6 / §8）', () => {
  async function seedContestAndLoose(): Promise<void> {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'int a;');
    writeSource('contestA/A.in', '1');
    writeSource('contestA/B/solution.cpp', 'int b;');
    writeSource('contestA/B/test.in', '2');
    writeSource('alpha/solution.cpp', 'alpha');
    writeSource('beta/solution.cpp', 'beta');
  }

  it('比赛 + 子题整组发布；共享文件只计比赛；题目各自独立', async () => {
    await seedContestAndLoose();
    const sourceBefore = snapshotTree(source);
    const plan = await scan();
    const result = await commitDefault(plan);

    expect(result.units).toHaveLength(3);
    expect(result.units.every((unit) => unit.status === 'success')).toBe(true);
    const contestUnit = result.units.find((unit) => unit.objects.length === 3);
    expect(contestUnit).toBeDefined();
    expect(result.skipped).toHaveLength(0);

    const tree = await service.tree();
    const contest = tree.objects.find((obj) => obj.kind === 'contest');
    const a = tree.objects.find((obj) => obj.title === 'A');
    const b = tree.objects.find((obj) => obj.title === 'B');
    const alpha = tree.objects.find((obj) => obj.title === 'alpha');
    const beta = tree.objects.find((obj) => obj.title === 'beta');
    expect(contest).toBeDefined();
    expect(a?.parentId).toBe(contest?.id);
    expect(b?.parentId).toBe(contest?.id);
    expect(alpha?.parentId).toBeNull();
    expect(beta?.parentId).toBeNull();
    expect(contest?.fileCount).toBe(1);
    expect(a?.fileCount).toBe(2);
    expect(b?.fileCount).toBe(2);

    const contestDetail = service.object(contest!.id);
    expect(contestDetail.files.map((file) => file.path)).toEqual(['README.md']);
    const aDetail = service.object(a!.id);
    expect(aDetail.files.map((file) => file.path)).toEqual(['A.cpp', 'A.in']);
    const bDetail = service.object(b!.id);
    expect(bDetail.files.map((file) => file.path)).toEqual(['solution.cpp', 'test.in']);
    expect(snapshotTree(source)).toEqual(sourceBefore);

    for (const object of [contest, a, b, alpha, beta]) {
      expect(existsSync(join(root, ...object!.relPath.split('/'), '.anvil.json'))).toBe(true);
    }
    const manifest = readOnlyManifest();
    expect(manifest.status).toBe('completed');
    expect(manifest.sourceRoot).toBe(realpathSync(source));
    expect(Array.isArray(manifest.units) && (manifest.units as unknown[]).length).toBe(3);
    const items = manifest.items as Array<Record<string, unknown>>;
    expect(items.filter((item) => item.action === 'import').every((item) => item.status === 'success')).toBe(true);
    expect(existsSync(join(root, '.anvil', 'import-staging')) ? readdirSync(join(root, '.anvil', 'import-staging')) : []).toEqual([]);
  });

  it('同源同指纹重跑自动跳过并链接已有对象；不重复复制', async () => {
    await seedContestAndLoose();
    const first = await commitDefault(await scan());
    const objectsBefore = (await service.tree()).objects.length;

    const rescan = await scan();
    const contest = itemOf(rescan, 'contestA');
    expect(contest.duplicate).toMatchObject({ kind: 'same-source', state: 'same' });
    expect(contest.selectedByDefault).toBe(true);
    expect(itemOf(rescan, 'alpha').duplicate).toMatchObject({ kind: 'same-source', state: 'same' });

    const second = await commitDefault(rescan);
    expect(second.units).toHaveLength(0);
    expect(second.skipped.some((x) => x.kind === 'duplicate' && x.objectId !== undefined)).toBe(true);
    expect((await service.tree()).objects).toHaveLength(objectsBefore);
    expect(first.batchId).not.toBe(second.batchId);
  });

  it('删除历史目标后允许重新导入；路径重新可用', async () => {
    await seedContestAndLoose();
    await commitDefault(await scan());
    const contest = (await service.tree()).objects.find((obj) => obj.kind === 'contest');
    rmSync(join(root, ...contest!.relPath.split('/')), { recursive: true, force: true });

    const rescan = await scan();
    expect(itemOf(rescan, 'contestA').duplicate).toBeNull();
    expect(itemOf(rescan, 'contestA').selectedByDefault).toBe(true);
    const result = await commitDefault(rescan);
    expect(result.units.every((unit) => unit.status === 'success')).toBe(true);
    expect((await service.tree()).objects.find((obj) => obj.kind === 'contest')?.relPath).toBe(contest!.relPath);
  });

  it('同一 plan 重复 commit / 并发 commit 返回同一结果', async () => {
    await seedContestAndLoose();
    const plan = await scan();
    const input = defaultInput(plan);
    const first = await service.importCommit({ planId: plan.planId, items: input });
    const second = await service.importCommit({ planId: plan.planId, items: input });
    expect(second).toEqual(first);

    const plan2 = await scan();
    const input2 = defaultInput(plan2);
    const [a, b] = await Promise.all([
      service.importCommit({ planId: plan2.planId, items: input2 }),
      service.importCommit({ planId: plan2.planId, items: input2 }),
    ]);
    expect(b).toEqual(a);
  });

  it('部分成功：一个独立单元失败不影响其它单元', async () => {
    await seedContestAndLoose();
    const plan = await scan();
    writeSource('alpha/solution.cpp', 'alpha changed');
    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(3);
    const failed = result.units.filter((unit) => unit.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error?.kind).toBe('import-source-changed');
    expect(result.units.filter((unit) => unit.status === 'success')).toHaveLength(2);
    const manifest = readOnlyManifest();
    expect(manifest.status).toBe('partial');
    const rescan = await scan();
    expect(rescan.warnings.join(' ')).toContain('失败单元');
  });

  it('比赛组内一个子题变化 → 整组拒绝；拆出的子题只影响自身', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'int a;');
    writeSource('contestA/B/solution.cpp', 'int b;');
    const plan = await scan();
    const contest = itemOf(plan, 'contestA');
    const a = itemOf(plan, 'contestA/A.cpp');
    const b = itemOf(plan, 'contestA/B');
    writeSource('contestA/B/solution.cpp', 'changed');

    const whole = await service.importCommit({
      planId: plan.planId,
      items: [
        { itemId: contest.itemId, selected: true },
        { itemId: a.itemId, selected: true },
        { itemId: b.itemId, selected: true },
      ],
    });
    expect(whole.units).toHaveLength(1);
    expect(whole.units[0]!.status).toBe('failed');
    expect(whole.units[0]!.error?.kind).toBe('import-source-changed');
    expect((await service.tree()).objects).toHaveLength(0);
  });

  it('拆出的子题只影响自身单元', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'int a;');
    writeSource('contestA/B/solution.cpp', 'int b;');
    const plan = await scan();
    const contest = itemOf(plan, 'contestA');
    const a = itemOf(plan, 'contestA/A.cpp');
    const b = itemOf(plan, 'contestA/B');
    writeSource('contestA/B/solution.cpp', 'changed');

    const result = await service.importCommit({
      planId: plan.planId,
      items: [
        { itemId: contest.itemId, selected: true },
        { itemId: a.itemId, selected: true },
        { itemId: b.itemId, selected: true, parentItemId: null },
      ],
    });
    expect(result.units).toHaveLength(2);
    const contestUnit = result.units.find((unit) => unit.objects.length > 1);
    expect(contestUnit?.status).toBe('success');
    const split = result.units.find((unit) => unit.status === 'failed');
    expect(split?.error?.kind).toBe('import-source-changed');
  });

  it('目标路径重名时追加后缀，不覆盖已有目录', async () => {
    writeSource('alpha/solution.cpp', 'alpha');
    mkdirSync(join(root, 'practice', '2026-10', 'alpha'), { recursive: true });
    const plan = await scan();
    const result = await commitDefault(plan);
    expect(result.units[0]!.status).toBe('success');
    const alpha = (await service.tree()).objects.find((obj) => obj.title === 'alpha');
    expect(alpha?.relPath).toBe('practice/2026-10/alpha-2');
  });
});

describe('更多提交语义（契约 §2.4 / §5.1 / §8.3 / §9）', () => {
  it('源根自身是比赛：A.cpp + B/ + README → contest 与独立子题', async () => {
    writeSource('README.md', 'readme');
    writeSource('A.cpp', 'int a;');
    writeSource('B/solution.cpp', 'int b;');
    const plan = await scan();
    const contest = itemOf(plan, '');
    expect(contest.shape).toBe('contest-group');
    expect(contest.suggestedTitle).toBe('old-code');
    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.objects).toHaveLength(3);
    const tree = await service.tree();
    const contestObject = tree.objects.find((obj) => obj.kind === 'contest');
    expect(contestObject?.relPath.startsWith('contests/')).toBe(true);
    expect(tree.objects.filter((obj) => obj.parentId === contestObject?.id)).toHaveLength(2);
  });

  it('undecided 确认成题目后按目录题导入', async () => {
    writeSource('misc/a.txt', 'a');
    writeSource('misc/sub/b.pdf', 'b');
    const plan = await scan();
    const misc = itemOf(plan, 'misc');
    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: misc.itemId, selected: true, confirmUndecidedAsProblem: true, title: 'Misc Notes' }],
    });
    expect(result.units[0]!.status).toBe('success');
    const detail = service.object(result.units[0]!.objects[0]!.objectId);
    expect(detail.kind).toBe('problem');
    expect(detail.title).toBe('Misc Notes');
    expect(detail.files.map((file) => file.path)).toEqual(['a.txt', 'sub/b.pdf']);
  });

  it('空题组：有共享文件可单独导入；无共享文件且子题全不选则 400', async () => {
    writeSource('withShared/README.md', 'readme');
    writeSource('withShared/A.cpp', 'a');
    writeSource('withShared/B/solution.cpp', 'b');
    writeSource('noShared/A.cpp', 'a');
    writeSource('noShared/B/solution.cpp', 'b');
    const plan = await scan();
    const withShared = itemOf(plan, 'withShared');
    const noShared = itemOf(plan, 'noShared');

    await expect(
      service.importCommit({ planId: plan.planId, items: [{ itemId: noShared.itemId, selected: true }] }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });

    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: withShared.itemId, selected: true }],
    });
    expect(result.units[0]!.status).toBe('success');
    expect(result.units[0]!.objects).toHaveLength(1);
    const contest = service.object(result.units[0]!.objects[0]!.objectId);
    expect(contest.files.map((file) => file.path)).toEqual(['README.md']);
  });

  it('manifest 记录比赛组的全部 objectId / targetRelPath 与 item 指纹', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'a');
    writeSource('contestA/B/solution.cpp', 'b');
    const plan = await scan();
    const result = await commitDefault(plan);
    expect(result.units[0]!.objects).toHaveLength(3);
    const manifest = readOnlyManifest();
    const units = manifest.units as Array<Record<string, unknown>>;
    expect(units).toHaveLength(1);
    expect((units[0]!.objectIds as string[]).length).toBe(3);
    expect((units[0]!.targetRelPaths as string[]).length).toBe(3);
    expect((units[0]!.itemIds as string[]).length).toBe(3);
    const items = manifest.items as Array<Record<string, unknown>>;
    const imported = items.filter((item) => item.action === 'import');
    expect(imported).toHaveLength(3);
    for (const item of imported) {
      expect(typeof item.sourceMtime).toBe('number');
      expect(typeof item.fingerprint).toBe('string');
      expect((item.fingerprint as string).length).toBe(64);
      expect(item.status).toBe('success');
      expect(item.objectId).toBeDefined();
    }
  });

  it('导入前后源文件字节与 hash 不变', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'int a;');
    writeSource('contestA/B/solution.cpp', 'int b;');
    writeSource('alpha/solution.cpp', 'alpha');
    const before = new Map<string, string>();
    const collect = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) collect(abs);
        else if (entry.isFile()) before.set(abs, readFileSync(abs, 'utf8'));
      }
    };
    collect(source);
    await commitDefault(await scan());
    for (const [abs, content] of before) expect(readFileSync(abs, 'utf8')).toBe(content);
    expect(snapshotTree(source).filter((x) => x.startsWith('f:'))).toHaveLength(before.size);
  });

  it('比赛目标路径重名追加后缀', async () => {
    writeSource('contestA/A.cpp', 'a');
    writeSource('contestA/B/solution.cpp', 'b');
    mkdirSync(join(root, 'contests', '2026-10-22_contesta'), { recursive: true });
    const plan = await scan();
    const result = await commitDefault(plan);
    expect(result.units[0]!.status).toBe('success');
    expect(result.units[0]!.objects[0]!.relPath).toBe('contests/2026-10-22_contesta-2');
  });
});

describe('去重矩阵 / 选择校验（契约 §7.3 / §10.2）', () => {
  it('不同源同内容标潜在重复，默认不选；keepDuplicate 后才导入', async () => {
    writeSource('alpha/solution.cpp', 'same');
    writeSource('beta/solution.cpp', 'same');
    const plan = await scan();
    const alpha = itemOf(plan, 'alpha');
    const beta = itemOf(plan, 'beta');
    expect(alpha.duplicate).toBeNull();
    expect(beta.duplicate).toMatchObject({ kind: 'same-content' });
    expect(alpha.selectedByDefault).toBe(true);
    expect(beta.selectedByDefault).toBe(false);

    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [
          { itemId: alpha.itemId, selected: true },
          { itemId: beta.itemId, selected: true },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });

    const result = await service.importCommit({
      planId: plan.planId,
      items: [
        { itemId: alpha.itemId, selected: true, keepDuplicate: true },
        { itemId: beta.itemId, selected: true, keepDuplicate: true },
      ],
    });
    expect(result.units.every((unit) => unit.status === 'success')).toBe(true);
  });

  it('同内容的两个比赛目录指纹一致：只把后来的副本标潜在重复', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'a');
    writeSource('contestA/B/solution.cpp', 'b');
    cpSync(join(source, 'contestA'), join(source, 'contestA-copy'), { recursive: true });
    const plan = await scan();
    const original = itemOf(plan, 'contestA');
    const copy = itemOf(plan, 'contestA-copy');
    expect(original.fingerprint).toBe(copy.fingerprint);
    expect(original.duplicate).toBeNull();
    expect(original.selectedByDefault).toBe(true);
    expect(copy.duplicate).toMatchObject({ kind: 'same-content' });
    expect(copy.selectedByDefault).toBe(false);
  });

  it('同源新版本默认不选；选中后导入新副本', async () => {
    writeSource('alpha/solution.cpp', 'v1');
    await commitDefault(await scan());
    writeSource('alpha/solution.cpp', 'v2');
    const plan = await scan();
    const alpha = itemOf(plan, 'alpha');
    expect(alpha.duplicate).toMatchObject({ kind: 'same-source', state: 'new-version' });
    expect(alpha.selectedByDefault).toBe(false);
    const result = await service.importCommit({
      planId: plan.planId,
      items: [{ itemId: alpha.itemId, selected: true }],
    });
    expect(result.units[0]!.status).toBe('success');
    const objects = (await service.tree()).objects.filter((obj) => obj.kind === 'problem');
    expect(objects).toHaveLength(2);
  });

  it('伪造 itemId / 重复 itemId / 未确认 undecided / 取消题组未拆子题 / 空题组全部 400 且不写 manifest', async () => {
    writeSource('contestA/A.cpp', 'a');
    writeSource('contestA/B/solution.cpp', 'b');
    writeSource('misc/note.txt', 'note');
    const plan = await scan();
    const contest = itemOf(plan, 'contestA');
    const a = itemOf(plan, 'contestA/A.cpp');
    const misc = itemOf(plan, 'misc');

    await expect(
      service.importCommit({ planId: plan.planId, items: [{ itemId: 'item_999', selected: true }] }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({
        planId: plan.planId,
        items: [
          { itemId: a.itemId, selected: true },
          { itemId: a.itemId, selected: false },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({ planId: plan.planId, items: [{ itemId: misc.itemId, selected: true }] }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({ planId: plan.planId, items: [{ itemId: a.itemId, selected: true }] }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    await expect(
      service.importCommit({ planId: plan.planId, items: [{ itemId: contest.itemId, selected: true }] }),
    ).rejects.toMatchObject({ kind: 'import-conflict' });
    expect(manifestFiles()).toHaveLength(0);
  });

  it('计划过期 / 切换受管根 / 超过保留数量', async () => {
    writeSource('alpha/solution.cpp', 'alpha');
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
    const last = await scan();
    const oldest = await scan();
    expect(last.planId).not.toBe(oldest.planId);
    await expect(service.importCommit({ planId: plan2.planId, items: defaultInput(plan2) })).rejects.toMatchObject({
      kind: 'import-plan-expired',
    });
  });
});

describe('源快照复核（契约 §7.4）', () => {
  it('扫描后删除 / 新增文件都只拒绝对应单元', async () => {
    writeSource('alpha/solution.cpp', 'alpha');
    writeSource('beta/solution.cpp', 'beta');
    const plan = await scan();
    unlinkSync(join(source, 'alpha', 'solution.cpp'));
    writeSource('beta/extra.cpp', 'extra');
    const result = await commitDefault(plan);
    expect(result.units).toHaveLength(2);
    expect(result.units.every((unit) => unit.status === 'failed')).toBe(true);
    expect(result.units.every((unit) => unit.error?.kind === 'import-source-changed')).toBe(true);
  });

  it('历史目标目录还在但 objectId 找不到：允许重新导入并分配后缀', async () => {
    writeSource('alpha/solution.cpp', 'alpha');
    const first = await commitDefault(await scan());
    const object = first.units[0]!.objects[0]!;
    unlinkSync(join(root, ...object.relPath.split('/'), '.anvil.json'));
    const plan = await scan();
    const alpha = itemOf(plan, 'alpha');
    expect(alpha.duplicate).toBeNull();
    expect(alpha.reasons.join(' ')).toContain('历史导入目标已不存在');
    const result = await commitDefault(plan);
    expect(result.units[0]!.status).toBe('success');
    expect(result.units[0]!.objects[0]!.relPath).toBe('practice/2026-10/alpha-2');
  });
});

describe('journal / 恢复（契约 §8.5 / §9）', () => {
  it('staged 且最终路径存在：按全部 objectId 对账补写 success', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'a');
    writeSource('contestA/B/solution.cpp', 'b');
    await commitDefault(await scan());
    const manifest = readOnlyManifest();
    const units = manifest.units as Array<Record<string, unknown>>;
    expect(units).toHaveLength(1);
    manifest.status = 'running';
    manifest.finishedAt = null;
    units[0]!.state = 'staged';
    for (const item of manifest.items as Array<Record<string, unknown>>) if (item.action === 'import') item.status = 'pending';
    const name = manifestFiles()[0]!;
    writeManifest(name, manifest);

    const recovered = await service.recoverImports();
    expect(recovered.warnings).toHaveLength(0);
    const after = readOnlyManifest();
    expect(after.status).toBe('completed');
    expect((after.units as Array<Record<string, unknown>>)[0]!.state).toBe('success');
  });

  it('staged 但缺任一 objectId：标记失败并保留现场；不删比赛文件夹', async () => {
    writeSource('contestA/README.md', 'readme');
    writeSource('contestA/A.cpp', 'a');
    writeSource('contestA/B/solution.cpp', 'b');
    const result = await commitDefault(await scan());
    const contestRel = result.units[0]!.objects.find((obj) => obj.relPath.includes('contests'))!.relPath;
    const childRel = result.units[0]!.objects.find((obj) => obj.relPath !== contestRel)!.relPath;
    rmSync(join(root, ...childRel.split('/'), '.anvil.json'));

    const manifest = readOnlyManifest();
    manifest.status = 'running';
    manifest.finishedAt = null;
    (manifest.units as Array<Record<string, unknown>>)[0]!.state = 'published';
    for (const item of manifest.items as Array<Record<string, unknown>>) if (item.action === 'import') item.status = 'pending';
    const name = manifestFiles()[0]!;
    writeManifest(name, manifest);

    const recovered = await service.recoverImports();
    expect(recovered.warnings.join(' ')).toContain('失败单元');
    const after = readOnlyManifest();
    expect(after.status).toBe('failed');
    expect((after.units as Array<Record<string, unknown>>)[0]!.state).toBe('failed');
    expect(existsSync(join(root, ...contestRel.split('/')))).toBe(true);
  });

  it('planned / staged 且最终路径不存在：清理合法 staging 后标 failed', async () => {
    const batchId = 'imp_0123456789';
    const unitId = 'unit_1';
    const stamp = '20261022-120000';
    const staging = join(root, '.anvil', 'import-staging', batchId);
    mkdirSync(join(staging, unitId), { recursive: true });
    writeFileSync(join(staging, `${unitId}.staging.json`), JSON.stringify({ schema: 1, batchId, unitId }), 'utf8');
    writeFileSync(join(staging, unitId, 'left.txt'), 'left', 'utf8');
    writeManifest(`${stamp}_${batchId}.json`, {
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
          sourceRelPath: 'nope',
          sourceMtime: 0,
          fingerprint: 'f',
          action: 'import',
          kind: 'problem',
          title: 'nope',
          parentItemId: null,
          status: 'pending',
        },
      ],
    });

    const recovered = await service.recoverImports();
    expect(recovered.warnings.join(' ')).toContain('失败单元');
    expect(existsSync(join(staging, unitId))).toBe(false);
    const after = readOnlyManifest();
    expect(after.status).toBe('failed');
  });

  it('planned 且最终路径不存在：同样清理合法 staging 后标 failed', async () => {
    const batchId = 'imp_abcdef0123';
    const unitId = 'item_1';
    const staging = join(root, '.anvil', 'import-staging', batchId);
    mkdirSync(join(staging, unitId), { recursive: true });
    writeFileSync(join(staging, `${unitId}.staging.json`), JSON.stringify({ schema: 1, batchId, unitId }), 'utf8');
    writeManifest(`20261022-120001_${batchId}.json`, {
      schema: 1,
      batchId,
      sourceRoot: source,
      workspace: { realPath: root, rootCreatedAt: '2026-10-22T00:00:00.000Z' },
      createdAt: '2026-10-22T12:00:00.000Z',
      finishedAt: null,
      status: 'running',
      units: [
        { unitId, state: 'planned', objectIds: ['obj_bbbbbbbbbb'], targetRelPaths: ['practice/2026-10/nope'], itemIds: ['item_1'] },
      ],
      items: [
        {
          itemId: 'item_1',
          unitId,
          sourceRelPath: 'nope',
          sourceMtime: 0,
          fingerprint: 'f',
          action: 'import',
          kind: 'problem',
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
    writeSource('alpha/solution.cpp', 'alpha');
    await commitDefault(await scan());
    writeManifest('broken_manifest.json', { nope: true });
    const tree = await service.tree({ rescan: true });
    expect(tree.objects).toHaveLength(1);
    const plan = await scan();
    expect(plan.warnings.join(' ')).toContain('manifest 损坏');
  });
});
