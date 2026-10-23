import { describe, expect, it } from 'vitest';
import {
  classifyImportTree,
  importFingerprintInput,
  isImportAttachmentName,
  isImportSourceName,
  planImportUnits,
  problemShapeOf,
  resolveImportSelection,
  singleDirectoryImportCandidate,
  type ImportCandidatePlan,
  type ImportSelectableCandidate,
  type ImportTree,
} from '../src/work-import.ts';

const sha = 'a'.repeat(64);

function tree(files: Array<[path: string, content?: string]>, dirs: string[]): ImportTree {
  return {
    files: files.map(([path, content = 'x']) => ({ path, size: content.length, sha256: sha })),
    dirs,
  };
}

const find = (items: ImportCandidatePlan[], sourceRelPath: string): ImportCandidatePlan => {
  const item = items.find((x) => x.sourceRelPath === sourceRelPath);
  if (item === undefined) throw new Error(`缺少候选：${sourceRelPath}`);
  return item;
};

describe('源码扩展名与题号形状（契约 §5.2 / §5.4）', () => {
  it('主源码扩展名大小写不敏感', () => {
    for (const name of ['A.cpp', 'a.CC', 'x.CXX', 'x.C', 'x.PY', 'A.Java', 'x.KT', 'x.go', 'x.RS']) {
      expect(isImportSourceName(name), name).toBe(true);
    }
    for (const name of ['A.hpp', 'A.h', 'A.in', 'A.out', 'A.ans', 'README.md', 'a.txt', 'a.json', 'a.yaml', 'a.pdf']) {
      expect(isImportSourceName(name), name).toBe(false);
    }
    expect(isImportAttachmentName('A.IN')).toBe(true);
    expect(isImportAttachmentName('A.ans')).toBe(true);
    expect(isImportAttachmentName('A.cpp')).toBe(false);
  });

  it('题号形状覆盖 A / B1 / 1001 / CF1234A / ABC300F 与分隔符写法', () => {
    for (const name of ['A', 'b', 'B1', 'b-1', 'B_1', '1001', 'CF1234A', 'cf-1234-a', 'ABC300F', 'abc_300_f', 'ARC-170-D']) {
      expect(problemShapeOf(name), name).not.toBeNull();
    }
    for (const name of ['solution', 'solution2', 'data1', 'A+B', 'A 1', 'CF1234', '2024-regional', '']) {
      expect(problemShapeOf(name), name).toBeNull();
    }
  });
});

describe('候选识别（契约 §5.3 / §5.4 / §5.5 / §5.7）', () => {
  it('单文件题：标题取 stem，同 stem 的 .in / .out / .ans 一并带入', () => {
    const items = classifyImportTree(
      tree(
        [
          ['alpha.cpp', 'code'],
          ['alpha.in', 'in'],
          ['alpha.OUT', 'out'],
          ['alpha.ans', 'ans'],
          ['beta.cpp', 'other'],
          ['notes.txt', 'no'],
        ],
        [],
      ),
      'old-code',
    );
    expect(items).toHaveLength(2);
    const first = find(items, 'alpha.cpp');
    expect(first.shape).toBe('problem-file');
    expect(first.role).toBe('problem');
    expect(first.suggestedTitle).toBe('alpha');
    expect(first.files.map((f) => f.targetPath)).toEqual(['alpha.OUT', 'alpha.ans', 'alpha.cpp', 'alpha.in']);
    expect(first.unitId).toBe(first.itemId);
    expect(first.confidence).toBe('high');
  });

  it('目录题保留内部相对路径；顶层有源码即成立', () => {
    const items = classifyImportTree(
      tree(
        [
          ['data-structure/solution.cpp', 'code'],
          ['data-structure/tests/1.in', 'in'],
          ['data-structure/README.md', 'readme'],
        ],
        ['data-structure', 'data-structure/tests'],
      ),
      'old-code',
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.shape).toBe('problem-dir');
    expect(items[0]!.suggestedTitle).toBe('data-structure');
    expect(items[0]!.files.map((f) => f.targetPath)).toEqual(['README.md', 'solution.cpp', 'tests/1.in']);
    expect(items[0]!.scope).toEqual({ kind: 'dir', path: 'data-structure' });
  });

  it('题号目录只在一层范围内找到源码时是低置信', () => {
    const items = classifyImportTree(tree([['A/deep/sol.cpp', 'code']], ['A', 'A/deep']), 'old-code');
    expect(items).toHaveLength(1);
    expect(items[0]!.shape).toBe('problem-dir');
    expect(items[0]!.confidence).toBe('low');
  });

  it('contest：A.cpp + B/ + README → 一个比赛 + 两个独立题目', () => {
    const items = classifyImportTree(
      tree(
        [
          ['README.md', 'readme'],
          ['A.cpp', 'a'],
          ['A.in', 'in'],
          ['B/solution.cpp', 'b'],
          ['B/test.in', 'bin'],
        ],
        ['B'],
      ),
      '2024-regional',
    );
    expect(items).toHaveLength(3);
    const contest = find(items, '');
    expect(contest.shape).toBe('contest-group');
    expect(contest.role).toBe('contest');
    expect(contest.suggestedTitle).toBe('2024-regional');
    expect(contest.childItemIds).toEqual(['item_2', 'item_3']);
    expect(contest.unitId).toBe('unit_1');
    expect(contest.files.map((f) => f.sourcePath)).toEqual(['README.md']);
    expect(contest.confidence).toBe('high');

    const a = find(items, 'A.cpp');
    expect(a.parentItemId).toBe('item_1');
    expect(a.unitId).toBe(contest.unitId);
    expect(a.files.map((f) => f.targetPath)).toEqual(['A.cpp', 'A.in']);

    const b = find(items, 'B');
    expect(b.shape).toBe('problem-dir');
    expect(b.parentItemId).toBe('item_1');
    expect(b.unitId).toBe(contest.unitId);
    expect(b.files.map((f) => f.targetPath)).toEqual(['solution.cpp', 'test.in']);
  });

  it('源根下的比赛子目录也识别为题组；旁边未分组题目各自成候选', () => {
    const items = classifyImportTree(
      tree(
        [
          ['contestA/README.md', 'r'],
          ['contestA/A.cpp', 'a'],
          ['contestA/B/solution.cpp', 'b'],
          ['alpha/solution.cpp', 'p1'],
          ['beta/solution.cpp', 'p2'],
        ],
        ['contestA', 'contestA/B', 'alpha', 'beta'],
      ),
      'old-code',
    );
    const contests = items.filter((item) => item.role === 'contest');
    expect(contests).toHaveLength(1);
    expect(contests[0]!.sourceRelPath).toBe('contestA');
    expect(contests[0]!.suggestedTitle).toBe('contestA');
    expect(contests[0]!.childItemIds).toHaveLength(2);
    const children = items.filter((item) => item.parentItemId === contests[0]!.itemId);
    expect(children.map((item) => item.sourceRelPath)).toEqual(['contestA/A.cpp', 'contestA/B']);
    expect(children.every((item) => item.unitId === contests[0]!.unitId)).toBe(true);
    const loose = items.filter((item) => item.parentItemId === null && item.role === 'problem');
    expect(loose.map((item) => item.sourceRelPath)).toEqual(['alpha', 'beta']);
    expect(loose.every((item) => item.unitId === item.itemId)).toBe(true);
  });

  it('比赛题组至少两个题号形态题目；不足两个时按普通容器拆候选', () => {
    const one = classifyImportTree(tree([['A.cpp', 'a'], ['B/notes.txt', 'x']], ['B']), 'old');
    expect(one.map((item) => item.shape)).toEqual(['undecided', 'problem-file']);
    expect(find(one, 'A.cpp').role).toBe('problem');
    expect(find(one, 'B').role).toBe('undecided');

    const two = classifyImportTree(tree([['A.cpp', 'a'], ['B/solution.cpp', 'b']], ['B']), 'old');
    expect(two[0]!.shape).toBe('contest-group');
    expect(two).toHaveLength(3);
  });

  it('未判定目录只产生 undecided，文件归属该节点', () => {
    const items = classifyImportTree(tree([['misc/a.txt', 'a'], ['misc/sub/b.pdf', 'b']], ['misc', 'misc/sub']), 'old');
    expect(items).toHaveLength(1);
    expect(items[0]!.shape).toBe('undecided');
    expect(items[0]!.role).toBe('undecided');
    expect(items[0]!.confidence).toBe('low');
    expect(items[0]!.files.map((f) => f.targetPath)).toEqual(['a.txt', 'sub/b.pdf']);
  });

  it('空目录不产生候选；候选 itemId 在重复分类时稳定', () => {
    const input = tree([['A.cpp', 'a'], ['B/solution.cpp', 'b']], ['B', 'empty']);
    const once = classifyImportTree(input, 'old');
    const twice = classifyImportTree(input, 'old');
    expect(once.map((x) => [x.itemId, x.unitId, x.parentItemId, x.files.map((f) => f.sourcePath)])).toEqual(
      twice.map((x) => [x.itemId, x.unitId, x.parentItemId, x.files.map((f) => f.sourcePath)]),
    );
    expect(once.some((x) => x.sourceRelPath === 'empty')).toBe(false);
  });
});

describe('单目录题组候选（2026-10-22 新语义）', () => {
  it('整目录 = 一个题组：文件原样归档，不产生子题', () => {
    const candidate = singleDirectoryImportCandidate(
      tree(
        [
          ['A.cpp', 'a'],
          ['data/1.in', '1'],
          ['README.md', 'r'],
        ],
        ['data'],
      ),
      '旧代码',
    );
    expect(candidate).not.toBeNull();
    expect(candidate!.role).toBe('contest');
    expect(candidate!.shape).toBe('contest-group');
    expect(candidate!.suggestedTitle).toBe('旧代码');
    expect(candidate!.childItemIds).toEqual([]);
    expect(candidate!.files.map((f) => f.targetPath)).toEqual(['A.cpp', 'README.md', 'data/1.in']);
    expect(candidate!.files.every((f) => f.sourcePath === f.targetPath)).toBe(true);
    expect(candidate!.reasons.join(' ')).toContain('整目录导入：3 个文件');
    expect(candidate!.reasons.join(' ')).toContain('主源码 1 个');
  });

  it('空目录不产生候选', () => {
    expect(singleDirectoryImportCandidate(tree([], []), 'empty')).toBeNull();
  });
});

describe('对象指纹组合（契约 §7.2）', () => {
  it('按路径排序后拼接，枚举顺序不影响结果', () => {
    const a = { path: 'b.cpp', size: 2, sha256: 'bb' };
    const b = { path: 'a/t.in', size: 1, sha256: 'aa' };
    const one = importFingerprintInput([a, b]);
    const two = importFingerprintInput([b, a]);
    expect(one).toBe(two);
    expect(one).toBe('a/t.in\0' + '1\0aa\n' + 'b.cpp\0' + '2\0bb\n');
  });

  it('改文件名、大小、内容 hash 都改变指纹输入', () => {
    const base = importFingerprintInput([{ path: 'a.cpp', size: 3, sha256: 'aa' }]);
    expect(importFingerprintInput([{ path: 'b.cpp', size: 3, sha256: 'aa' }])).not.toBe(base);
    expect(importFingerprintInput([{ path: 'a.cpp', size: 4, sha256: 'aa' }])).not.toBe(base);
    expect(importFingerprintInput([{ path: 'a.cpp', size: 3, sha256: 'bb' }])).not.toBe(base);
  });
});

describe('提交选择矩阵（契约 §10.2）', () => {
  const cand = (patch: Partial<ImportSelectableCandidate> = {}): ImportSelectableCandidate => ({
    itemId: 'item_1',
    unitId: 'item_1',
    role: 'problem',
    shape: 'problem-file',
    parentItemId: null,
    suggestedTitle: 'A',
    duplicate: null,
    files: 1,
    ...patch,
  });

  const contest = (patch: Partial<ImportSelectableCandidate> = {}): ImportSelectableCandidate =>
    cand({ itemId: 'item_1', unitId: 'unit_1', role: 'contest', shape: 'contest-group', suggestedTitle: 'Contest', files: 0, ...patch });

  const child = (patch: Partial<ImportSelectableCandidate> = {}): ImportSelectableCandidate =>
    cand({ itemId: 'item_2', unitId: 'unit_1', role: 'problem', shape: 'problem-file', parentItemId: 'item_1', suggestedTitle: 'A', ...patch });

  it('contest + 子题整组一个单元；拆出的子题重算为独立单元', () => {
    const candidates = [contest(), child()];
    const all = resolveImportSelection(candidates, [
      { itemId: 'item_1', selected: true },
      { itemId: 'item_2', selected: true },
    ]);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.units).toEqual([{ unitId: 'unit_1', itemIds: ['item_1', 'item_2'], contestItemId: 'item_1' }]);

    const split = resolveImportSelection(candidates, [
      { itemId: 'item_1', selected: false },
      { itemId: 'item_2', selected: true, parentItemId: null },
    ]);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.units).toEqual([{ unitId: 'item_2', itemIds: ['item_2'], contestItemId: null }]);
  });

  it('父比赛未选中且子题未拆 → 非法；未回传的项按未选中', () => {
    const candidates = [contest({ files: 1 }), child()];
    const bad = resolveImportSelection(candidates, [{ itemId: 'item_2', selected: true }]);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.some((x) => x.includes('父比赛未选中'))).toBe(true);

    const valid = resolveImportSelection(candidates, [{ itemId: 'item_1', selected: true }]);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.units).toHaveLength(1);
    expect(valid.units[0]!.itemIds).toEqual(['item_1']);
    expect(valid.items.find((x) => x.candidate.itemId === 'item_2')?.selected).toBe(false);
  });

  it('空题组不能选中；有共享文件的题组可以', () => {
    const candidates = [contest()];
    const bad = resolveImportSelection(candidates, [{ itemId: 'item_1', selected: true }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((x) => x.includes('空题组'))).toBe(true);

    const withShared = resolveImportSelection([contest({ files: 2 })], [{ itemId: 'item_1', selected: true }]);
    expect(withShared.ok).toBe(true);
  });

  it('不能挂到另一个 contest-group 的组头', () => {
    const candidates = [
      contest(),
      child(),
      contest({ itemId: 'item_9', unitId: 'unit_9', suggestedTitle: 'Other' }),
    ];
    const bad = resolveImportSelection(candidates, [
      { itemId: 'item_1', selected: false },
      { itemId: 'item_9', selected: true, title: 'Other' },
      { itemId: 'item_2', selected: true, parentItemId: 'item_9' },
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((x) => x.includes('另一个比赛题组'))).toBe(true);
  });

  it('undecided 必须明确确认成题目', () => {
    const candidates = [cand({ itemId: 'item_3', role: 'undecided', shape: 'undecided', suggestedTitle: 'misc', files: 2 })];
    const bad = resolveImportSelection(candidates, [{ itemId: 'item_3', selected: true }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((x) => x.includes('确认为题目'))).toBe(true);

    const ok = resolveImportSelection(candidates, [{ itemId: 'item_3', selected: true, confirmUndecidedAsProblem: true }]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.items[0]!.candidate.role).toBe('undecided');
      expect(ok.units).toEqual([{ unitId: 'item_3', itemIds: ['item_3'], contestItemId: null }]);
    }
  });

  it('潜在重复必须明确保留副本；same-source 新版本可直接选中', () => {
    const contentDup = cand({ itemId: 'item_4', duplicate: { kind: 'same-content' } });
    const bad = resolveImportSelection([contentDup], [{ itemId: 'item_4', selected: true }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((x) => x.includes('潜在重复'))).toBe(true);
    expect(resolveImportSelection([contentDup], [{ itemId: 'item_4', selected: true, keepDuplicate: true }]).ok).toBe(true);

    const newVersion = cand({ itemId: 'item_5', duplicate: { kind: 'same-source', state: 'new-version' } });
    expect(resolveImportSelection([newVersion], [{ itemId: 'item_5', selected: true }]).ok).toBe(true);
  });

  it('未知 / 重复 itemId、空选择、标题超长全部拒绝', () => {
    const candidates = [cand({ itemId: 'item_1' })];
    expect(resolveImportSelection(candidates, [{ itemId: 'nope', selected: true }]).ok).toBe(false);
    const dup = resolveImportSelection(candidates, [
      { itemId: 'item_1', selected: true },
      { itemId: 'item_1', selected: false },
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.issues.some((x) => x.includes('重复回传'))).toBe(true);
    const none = resolveImportSelection(candidates, []);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.issues.some((x) => x.includes('没有选中'))).toBe(true);
    const long = resolveImportSelection(candidates, [{ itemId: 'item_1', selected: true, title: 'x'.repeat(121) }]);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.issues.some((x) => x.includes('标题长度'))).toBe(true);
  });

  it('planImportUnits 保持 plan 顺序，拆出的子题不参与原比赛单元', () => {
    const resolved = resolveImportSelection([contest({ files: 1 }), child(), cand({ itemId: 'item_3', suggestedTitle: 'C' })], [
      { itemId: 'item_1', selected: true },
      { itemId: 'item_2', selected: true, parentItemId: null },
      { itemId: 'item_3', selected: true },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const units = planImportUnits(resolved.items);
    expect(units).toEqual([
      { unitId: 'unit_1', itemIds: ['item_1'], contestItemId: 'item_1' },
      { unitId: 'item_2', itemIds: ['item_2'], contestItemId: null },
      { unitId: 'item_3', itemIds: ['item_3'], contestItemId: null },
    ]);
  });
});
