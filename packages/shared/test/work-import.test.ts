import { describe, expect, it } from 'vitest';
import {
  batchCandidatesConflict,
  classifyBatchImportTree,
  cleanSourcePath,
  compareSourcePathNatural,
  importFingerprintInput,
  isImportSourceName,
  resolveBatchImportSelection,
  sourceParentPath,
  type BatchImportCandidatePlan,
  type BatchImportSelectableCandidate,
  type ImportTree,
} from '../src/work-import.ts';

const sha = 'a'.repeat(64);

function tree(files: Array<[path: string, content?: string]>, dirs: string[]): ImportTree {
  return {
    files: files.map(([path, content = 'x']) => ({ path, size: content.length, sha256: sha })),
    dirs,
  };
}

const find = <T extends BatchImportCandidatePlan>(items: readonly T[], sourceRelPath: string): T => {
  const item = items.find((x) => x.sourceRelPath === sourceRelPath);
  if (item === undefined) throw new Error(`缺少候选：${sourceRelPath}`);
  return item;
};

describe('主源码扩展名（契约 §5.2）', () => {
  it('大小写不敏感，只认源码扩展名', () => {
    for (const name of ['A.cpp', 'a.CC', 'x.CXX', 'x.C', 'x.PY', 'A.Java', 'x.KT', 'x.go', 'x.RS']) {
      expect(isImportSourceName(name), name).toBe(true);
    }
    for (const name of ['A.hpp', 'A.h', 'A.in', 'A.out', 'A.ans', 'README.md', 'a.txt', 'a.json', 'a.yaml', 'a.pdf']) {
      expect(isImportSourceName(name), name).toBe(false);
    }
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

describe('批量提交选择（契约 §5）', () => {
  const plan: BatchImportSelectableCandidate[] = [
    { itemId: 'item_1', unitId: 'unit_1', sourceRelPath: '2026', importScope: 'subtree', suggestedTitle: '2026', duplicate: null, files: 5 },
    { itemId: 'item_2', unitId: 'unit_2', sourceRelPath: '2026/10', importScope: 'subtree', suggestedTitle: '10', duplicate: null, files: 3 },
    { itemId: 'item_3', unitId: 'unit_3', sourceRelPath: '2026/10', importScope: 'direct', suggestedTitle: '10 散题', duplicate: null, files: 2 },
    { itemId: 'item_4', unitId: 'unit_4', sourceRelPath: '2026/10/A', importScope: 'subtree', suggestedTitle: 'A', duplicate: null, files: 1 },
  ];

  it('每个候选独立成单元；父子互斥或散题/整目录同选都拒绝', () => {
    const parentChild = resolveBatchImportSelection(plan, [
      { itemId: 'item_1', selected: true },
      { itemId: 'item_4', selected: true },
    ]);
    expect(parentChild.ok).toBe(false);
    if (!parentChild.ok) expect(parentChild.issues.some((x) => x.includes('父子目录'))).toBe(true);

    const wholeAndScatter = resolveBatchImportSelection(plan, [
      { itemId: 'item_2', selected: true },
      { itemId: 'item_3', selected: true },
    ]);
    expect(wholeAndScatter.ok).toBe(false);

    const scatterAndChild = resolveBatchImportSelection(plan, [
      { itemId: 'item_3', selected: true },
      { itemId: 'item_4', selected: true },
    ]);
    expect(scatterAndChild.ok).toBe(true);
    if (scatterAndChild.ok) {
      expect(scatterAndChild.units).toEqual([
        { unitId: 'unit_3', itemIds: ['item_3'] },
        { unitId: 'unit_4', itemIds: ['item_4'] },
      ]);
    }
  });

  it('同内容必须保留副本，标题与空范围仍校验', () => {
    const contentDup: BatchImportSelectableCandidate[] = [
      { itemId: 'item_1', unitId: 'unit_1', sourceRelPath: 'a', importScope: 'subtree', suggestedTitle: 'a', duplicate: { kind: 'same-content' }, files: 1 },
    ];
    expect(resolveBatchImportSelection(contentDup, [{ itemId: 'item_1', selected: true }]).ok).toBe(false);
    expect(resolveBatchImportSelection(contentDup, [{ itemId: 'item_1', selected: true, keepDuplicate: true }]).ok).toBe(true);
    const empty: BatchImportSelectableCandidate[] = [
      { itemId: 'item_1', unitId: 'unit_1', sourceRelPath: 'a', importScope: 'subtree', suggestedTitle: 'a', duplicate: null, files: 0 },
    ];
    expect(resolveBatchImportSelection(empty, [{ itemId: 'item_1', selected: true }]).ok).toBe(false);
    expect(resolveBatchImportSelection(contentDup, [{ itemId: 'nope', selected: true }]).ok).toBe(false);
    expect(resolveBatchImportSelection(contentDup, []).ok).toBe(false);
    expect(resolveBatchImportSelection(contentDup, [{ itemId: 'item_1', selected: true, title: 'x'.repeat(121) }]).ok).toBe(false);
  });
});

describe('批量目录分类（5a-3 契约 §3 / §4）', () => {
  const fixture = tree(
    [
      ['2026/10/10.ptc/A.cpp', 'a'],
      ['2026/10/10.ptc/data/1.in', '1'],
      ['2026/10/17.VP/a.cpp', 'b'],
      ['2026/10/TreeDP/sol.cpp', 'c'],
      ['2026/10/Moban.cpp', 'm'],
      ['2026/10/runner.cpp', 'r'],
      ['2026/7/A.cpp', 'd'],
      ['2026_ICPC_1/sol.cpp', 'e'],
      ['docs/README.md', 'doc'],
    ],
    ['2026', '2026/10', '2026/10/10.ptc', '2026/10/10.ptc/data', '2026/10/17.VP', '2026/10/TreeDP', '2026/7', '2026_ICPC_1', 'docs'],
  );

  it('容器 / 叶子 / 散题各自成候选；只有文档的目录不产生候选', () => {
    const items = classifyBatchImportTree(fixture, 'ACM');
    const paths = items.map((item) => `${item.sourceRelPath}:${item.importScope}`);
    expect(paths).toContain('2026/10/10.ptc:subtree');
    expect(paths).toContain('2026/10:direct');
    expect(paths).not.toContain('docs:subtree');

    const root = find(items, '');
    expect(root.isContainer).toBe(true);
    expect(root.selectedByDefault).toBe(false);
    expect(root.sourceCount).toBe(7);

    const ten = items.find((item) => item.sourceRelPath === '2026/10' && item.importScope === 'subtree')!;
    expect(ten.isContainer).toBe(true);
    expect(ten.reasons.join(' ')).toContain('容器');
    expect(ten.selectedByDefault).toBe(false);

    const leaf = items.find((item) => item.sourceRelPath === '2026/10/10.ptc')!;
    expect(leaf.isContainer).toBe(false);
    expect(leaf.selectedByDefault).toBe(true);
    expect(leaf.files.map((file) => file.targetPath)).toEqual(['A.cpp', 'data/1.in']);
    expect(leaf.sourceCount).toBe(1);

    const scatter = items.find((item) => item.sourceRelPath === '2026/10' && item.importScope === 'direct')!;
    expect(scatter.files.map((file) => file.sourcePath)).toEqual(['2026/10/Moban.cpp', '2026/10/runner.cpp']);
    expect(scatter.files.map((file) => file.targetPath)).toEqual(['Moban.cpp', 'runner.cpp']);
    expect(scatter.selectedByDefault).toBe(false);
    expect(scatter.suggestedTitle).toBe('10 散题');
  });

  it('单叶子源根：一个候选、无散题、默认选中', () => {
    const items = classifyBatchImportTree(tree([['A.cpp', 'a'], ['data/1.in', '1']], ['data']), 'old-code');
    expect(items).toHaveLength(1);
    expect(items[0]!.importScope).toBe('subtree');
    expect(items[0]!.sourceRelPath).toBe('');
    expect(items[0]!.suggestedTitle).toBe('old-code');
    expect(items[0]!.selectedByDefault).toBe(true);
    expect(items[0]!.reasons.join(' ')).toContain('整目录导入：2 个文件');
  });

  it('混合目录（自身源码 + 一个含源码子目录）：父候选包含子树，散题只含直接文件', () => {
    const items = classifyBatchImportTree(
      tree(
        [
          ['parent/P.cpp', 'p'],
          ['parent/notes.txt', 'n'],
          ['parent/kid/K.cpp', 'k'],
        ],
        ['parent', 'parent/kid'],
      ),
      'ACM',
    );
    const parent = items.find((item) => item.sourceRelPath === 'parent' && item.importScope === 'subtree')!;
    // 直接下级只有 1 个含源码目录，按契约 §3.2 不是容器
    expect(parent.isContainer).toBe(false);
    expect(parent.sourceCount).toBe(2);
    expect(parent.files.map((file) => file.targetPath)).toEqual(['P.cpp', 'kid/K.cpp', 'notes.txt']);

    const scatter = items.find((item) => item.sourceRelPath === 'parent' && item.importScope === 'direct')!;
    expect(scatter.files.map((file) => file.sourcePath)).toEqual(['parent/P.cpp', 'parent/notes.txt']);
    expect(scatter.files.map((file) => file.targetPath)).toEqual(['P.cpp', 'notes.txt']);
    expect(scatter.sourceCount).toBe(1);

    const kid = items.find((item) => item.sourceRelPath === 'parent/kid')!;
    expect(kid.isContainer).toBe(false);
    expect(kid.selectedByDefault).toBe(true);
  });

  it('没有任何主源码时返回空候选', () => {
    expect(classifyBatchImportTree(tree([['README.md', 'doc'], ['a.png', 'img']], []), 'docs')).toEqual([]);
  });
});

describe('sourcePath 与来源排序（5a-3 契约 §3.3 / §8.3）', () => {
  it('清洗绝对路径 / 反斜杠 / 空段 / 点段 / 超长', () => {
    expect(cleanSourcePath('2026/10/10.ptc')).toBe('2026/10/10.ptc');
    expect(cleanSourcePath('2026_ICPC_1')).toBe('2026_ICPC_1');
    for (const bad of ['', '/abs', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a/', 'a\0b', 'x'.repeat(301)]) {
      expect(cleanSourcePath(bad), bad).toBeNull();
    }
    expect(cleanSourcePath('x')).toBe('x');
    expect(cleanSourcePath('x'.repeat(300))).toBe('x'.repeat(300));
    expect(cleanSourcePath('2026年/十月 训练/10.ptc')).toBe('2026年/十月 训练/10.ptc');
  });

  it('来源分组键是 sourcePath 的父路径；无来源为 null', () => {
    expect(sourceParentPath('2026/10/10.ptc')).toBe('2026/10');
    expect(sourceParentPath('2026_ICPC_1')).toBe('');
    expect(sourceParentPath(undefined)).toBeNull();
  });

  it('年月数字按数值自然排序，而不是字典序', () => {
    const paths = ['2026/10', '2026/7', '2026/2', '2025/12', '2026/10/A'];
    expect([...paths].sort(compareSourcePathNatural)).toEqual(['2025/12', '2026/2', '2026/7', '2026/10', '2026/10/A']);
  });

  it('父子 / 散题冲突判据', () => {
    expect(batchCandidatesConflict({ sourceRelPath: 'a', importScope: 'subtree' }, { sourceRelPath: 'a/b', importScope: 'subtree' })).toBe(true);
    expect(batchCandidatesConflict({ sourceRelPath: 'a', importScope: 'subtree' }, { sourceRelPath: 'a/b', importScope: 'direct' })).toBe(true);
    expect(batchCandidatesConflict({ sourceRelPath: 'a', importScope: 'direct' }, { sourceRelPath: 'a/b', importScope: 'subtree' })).toBe(false);
    expect(batchCandidatesConflict({ sourceRelPath: 'a', importScope: 'subtree' }, { sourceRelPath: 'a', importScope: 'direct' })).toBe(true);
  });
});
