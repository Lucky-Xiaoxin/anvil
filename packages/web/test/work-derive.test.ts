import { describe, expect, it } from 'vitest';
import type { WorkObjectDto, WorkTaxonomyDto } from '@anvil/shared';
import { workMigrateProposalOf } from '@anvil/shared';
import {
  allLabels,
  availableContests,
  contestCountLabel,
  fileSize,
  filterWorkObjects,
  folderActionsOf,
  flatNodes,
  groupWorkObjects,
  groupWorkObjectsBySource,
  kindCounts,
  linkedProblemsetOf,
  matchesTag,
  pathBreadcrumb,
  primaryName,
  problemsetLinkOf,
} from '../src/components/work/derive.ts';

const taxonomy: WorkTaxonomyDto = {
  version: 1,
  nodes: [
    {
      id: 'graph',
      name: '图论',
      count: 1,
      children: [
        { id: 'graph/tree', name: '树', count: 1 },
        { id: 'graph/hld', name: '树链剖分', count: 0 },
      ],
    },
    { id: 'dp', name: '动态规划', count: 0, children: [{ id: 'dp/tree-dp', name: '树形 DP', count: 0 }] },
  ],
};

const obj = (patch: Partial<WorkObjectDto> = {}): WorkObjectDto => ({
  id: 'obj_0000000001',
  kind: 'problem',
  title: 'Cherry Tree',
  relPath: 'practice/2026-10/cherry-tree',
  parentId: null,
  tags: { primary: 'graph/tree', related: ['dp/tree-dp'] },
  labels: ['赛时'],
  links: {},
  archived: false,
  effectiveArchived: false,
  createdAt: '2026-10-21T02:00:00.000Z',
  updatedAt: '2026-10-21T02:10:00.000Z',
  fileCount: 3,
  sourceCount: 0,
  ...patch,
});

describe('工坊派生（契约 §7.3 筛选口径）', () => {
  it('一级标签筛选包含直属二级；related 也参与导航', () => {
    const one = obj();
    expect(matchesTag(one, taxonomy, 'graph')).toBe(true);
    expect(matchesTag(one, taxonomy, 'graph/tree')).toBe(true);
    expect(matchesTag(one, taxonomy, 'graph/hld')).toBe(false);
    expect(matchesTag(one, taxonomy, 'dp')).toBe(true);
    expect(matchesTag(one, taxonomy, 'dp/tree-dp')).toBe(true);
  });

  it('kind / label / 搜索条件 AND；搜索覆盖标题、标签名、路径', () => {
    const a = obj();
    const b = obj({ id: 'obj_0000000002', kind: 'contest', title: 'Shanghai', tags: { primary: null, related: [] }, labels: [], relPath: 'contests/2026-10-21_shanghai' });
    const base = { kind: 'all' as const, nodeId: null, label: null, query: '' };
    expect(filterWorkObjects([a, b], taxonomy, base)).toHaveLength(2);
    expect(filterWorkObjects([a, b], taxonomy, { ...base, kind: 'contest' })).toEqual([b]);
    expect(filterWorkObjects([a, b], taxonomy, { ...base, label: '赛时' })).toEqual([a]);
    expect(filterWorkObjects([a, b], taxonomy, { ...base, query: '树形' })).toEqual([a]);
    expect(filterWorkObjects([a, b], taxonomy, { ...base, query: 'shanghai' })).toEqual([b]);
    expect(filterWorkObjects([a, b], taxonomy, { ...base, nodeId: 'graph' })).toEqual([a]);
    expect(filterWorkObjects([a, b], taxonomy, { ...base, kind: 'contest', nodeId: 'graph' })).toEqual([]);
  });

  it('kind 筛选只看 kind（26 §8）：arenaPath / sourcePath 不参与分类', () => {
    const plain = obj({ id: 'obj_0000000021', kind: 'contest', title: 'Manual Contest', relPath: 'contests/m', links: {} });
    const arena = obj({
      id: 'obj_0000000022',
      kind: 'contest',
      title: 'Arena Contest',
      relPath: 'contests/a',
      links: { arenaPath: 'official/icpc/x/y.srk.json' },
    });
    const sourced = obj({
      id: 'obj_0000000023',
      kind: 'contest',
      title: 'Sourced Contest',
      relPath: 'contests/s',
      sourcePath: '2026/10/x',
    });
    const base = { kind: 'all' as const, nodeId: null, label: null, query: '' };
    expect(filterWorkObjects([plain, arena, sourced], taxonomy, { ...base, kind: 'contest' })).toHaveLength(3);
    expect(filterWorkObjects([plain, arena, sourced], taxonomy, { ...base, kind: 'problemset' })).toEqual([]);
  });

  it('flatNodes / 名字 / 计数 / labels（五类对象计数互不包含）', () => {
    expect(flatNodes(taxonomy)).toHaveLength(5);
    expect(flatNodes(null)).toEqual([]);
    expect(primaryName(obj(), taxonomy)).toBe('树');
    expect(
      kindCounts([
        obj(),
        obj({ kind: 'note' }),
        obj({ kind: 'problemset', relPath: 'practice/2026-10/set' }),
        obj({ kind: 'contest', relPath: 'contests/x' }),
      ]),
    ).toEqual({ all: 4, contest: 1, problemset: 1, problem: 1, template: 0, note: 1 });
    expect(allLabels([obj(), obj({ labels: ['赛时', '复盘'] })])).toEqual(expect.arrayContaining(['赛时', '复盘']));
  });

  it('比赛 / 题组 / 旧题目对象三个文件夹入口；模板 / 笔记只有 auto', () => {
    const two = [
      { app: 'explorer', label: '打开文件夹' },
      { app: 'vscode', label: '用 VS Code 打开' },
    ];
    for (const kind of ['contest', 'problemset', 'problem'] as const) {
      expect(folderActionsOf(kind)).toEqual(two);
    }
    for (const kind of ['template', 'note'] as const) {
      expect(folderActionsOf(kind)).toEqual([{ app: 'auto', label: '打开文件夹' }]);
    }
  });

  it('比赛行不再叫题组（26 §6.1）：源码显示「含源码」计数，旧子题仍显示题数', () => {
    const emptyContest = obj({ id: 'obj_0000000020', kind: 'contest', title: 'Empty', relPath: 'contests/x', sourceCount: 0, parentId: null });
    expect(contestCountLabel(emptyContest, 0)).toBe('');
    const sourcedContest = obj({ ...emptyContest, sourceCount: 3 });
    expect(contestCountLabel(sourcedContest, 0)).toBe('3 个源码');
    expect(contestCountLabel(emptyContest, 2)).toBe('2 题');
  });
});

describe('中间列表分区（26 §6.1：kind 分区，不读 arenaPath / sourcePath）', () => {
  const contest = (id: string, title: string, relPath: string): WorkObjectDto =>
    obj({ id, kind: 'contest', title, relPath, parentId: null, links: {} });
  const problemset = (id: string, title: string, relPath: string, patch: Partial<WorkObjectDto> = {}): WorkObjectDto =>
    obj({ id, kind: 'problemset', title, relPath, parentId: null, ...patch });
  const problem = (id: string, title: string, relPath: string, parentId: string | null): WorkObjectDto =>
    obj({ id, title, relPath, parentId });

  it('比赛与题组分列两区；题组不再落进笔记区', () => {
    const c1 = contest('obj_0000000010', 'Shanghai', 'contests/2026-10-21_shanghai');
    const s1 = problemset('obj_0000000012', 'TreeDP', 'practice/2026-10/treedp');
    const note = obj({ id: 'obj_0000000013', kind: 'note', title: 'Week', relPath: 'notes/2026/10/w' });
    const model = groupWorkObjects([c1, s1, note], [c1, s1, note]);
    expect(model.groups.map((g) => g.contest.id)).toEqual([c1.id]);
    expect(model.groups[0]?.problems).toEqual([]);
    expect(model.problemSets.map((s) => s.id)).toEqual([s1.id]);
    expect(model.notes.map((n) => n.id)).toEqual([note.id]);
  });

  it('旧 problem 仍按父比赛折叠；未挂与父缺失的进各自兜底区', () => {
    const c1 = contest('obj_0000000010', 'Shanghai', 'contests/2026-10-21_shanghai');
    const p1 = problem('obj_0000000012', 'A', 'contests/2026-10-21_shanghai/a', c1.id);
    const single = problem('obj_0000000013', 'Single', 'practice/2026-10/single', null);
    const orphan = problem('obj_0000000014', 'Orphan', 'practice/2026-10/orphan', 'obj_0000000099');
    const model = groupWorkObjects([c1, p1, single, orphan], [c1, p1, single, orphan]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.included).toBe(true);
    expect(model.groups[0]?.problems.map((p) => p.id)).toEqual([p1.id]);
    expect(model.problemSets).toEqual([]);
    expect(model.ungrouped.map((p) => p.id)).toEqual([single.id]);
    expect(model.orphans.map((p) => p.id)).toEqual([orphan.id]);
  });

  it('kind=题目 时父比赛不在筛选结果里，仍按比赛分组且组头不可点', () => {
    const c1 = contest('obj_0000000010', 'Shanghai', 'contests/2026-10-21_shanghai');
    const p1 = problem('obj_0000000012', 'A', 'contests/2026-10-21_shanghai/a', c1.id);
    const model = groupWorkObjects([p1], [c1, p1]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.included).toBe(false);
    expect(model.groups[0]?.problems.map((p) => p.id)).toEqual([p1.id]);
  });

  it('单题目录面包屑去掉对象文件夹本身', () => {
    expect(pathBreadcrumb('practice/2026-10/cherry-tree')).toEqual(['practice', '2026-10']);
    expect(pathBreadcrumb('manual/problem')).toEqual(['manual']);
    expect(pathBreadcrumb('cherry-tree')).toEqual([]);
  });
});

describe('关联比赛（26 §2.3 / §5.2：0..1 逻辑关联）', () => {
  const contest = (id: string, title: string): WorkObjectDto =>
    obj({ id, kind: 'contest', title, relPath: `contests/${title}`, parentId: null, links: {} });
  const problemset = (id: string, title: string, parentId: string | null): WorkObjectDto =>
    obj({ id, kind: 'problemset', title, relPath: `practice/2026-10/${title}`, parentId });

  it('题组行显示关联比赛；父对象缺失时是 missing 而不是报错', () => {
    const c1 = contest('obj_0000000040', 'Shanghai');
    const linked = problemset('obj_0000000041', 'TreeDP', c1.id);
    const free = problemset('obj_0000000042', 'Free', null);
    const broken = problemset('obj_0000000043', 'Broken', 'obj_0000000099');
    const all = [c1, linked, free, broken];
    const byId = new Map(all.map((o) => [o.id, o]));

    expect(problemsetLinkOf(linked, byId)).toEqual({ state: 'ok', contest: c1 });
    expect(problemsetLinkOf(free, byId)).toEqual({ state: 'none', contest: null });
    expect(problemsetLinkOf(broken, byId)).toEqual({ state: 'missing', contest: null });
    expect(problemsetLinkOf(c1, byId)).toEqual({ state: 'none', contest: null });
  });

  it('比赛行显示关联题组（0..1）', () => {
    const c1 = contest('obj_0000000040', 'Shanghai');
    const c2 = contest('obj_0000000044', 'Nanjing');
    const linked = problemset('obj_0000000041', 'TreeDP', c1.id);
    expect(linkedProblemsetOf(c1, [c1, c2, linked])).toEqual(linked);
    expect(linkedProblemsetOf(c2, [c1, c2, linked])).toBeNull();
  });

  it('关联选择器排除已被其它题组占用的比赛；自己已关联的保留', () => {
    const c1 = contest('obj_0000000040', 'Shanghai');
    const c2 = contest('obj_0000000044', 'Nanjing');
    const mine = problemset('obj_0000000041', 'TreeDP', c1.id);
    const other = problemset('obj_0000000045', 'Other', c2.id);
    const free = contest('obj_0000000046', 'Xian');
    // 自己（mine）已占用 c1，不排除；other 占用 c2，要排除
    expect(availableContests([c1, c2, free, mine, other], mine.id).map((o) => o.id)).toEqual([c1.id, free.id]);
    // 从旁观者角度：c1 / c2 都被占用
    expect(availableContests([c1, c2, free, mine, other], null).map((o) => o.id)).toEqual([free.id]);
  });
});

describe('来源虚拟视图（26 §6.1 / §6.2：只组织 problemset）', () => {
  const sourcedSet = (id: string, title: string, relPath: string, sourcePath: string): WorkObjectDto =>
    obj({ id, kind: 'problemset', title, relPath, parentId: null, sourcePath, sourceCount: 1 });

  it('按 sourcePath 父路径生成树；年月自然排序；组头统计子树', () => {
    const a = sourcedSet('obj_0000000030', '10.ptc', 'practice/2026-10/a', '2026/10/10.ptc');
    const b = sourcedSet('obj_0000000031', '17.VP', 'practice/2026-10/b', '2026/10/17.VP');
    const c = sourcedSet('obj_0000000032', 'July', 'practice/2026-07/c', '2026/7/A');
    const d = sourcedSet('obj_0000000033', 'Root', 'practice/2026-07/d', '2026_ICPC_1');
    const manual = obj({ id: 'obj_0000000034', kind: 'problemset', title: 'Manual', relPath: 'practice/2026-10/m', parentId: null });
    const model = groupWorkObjectsBySource([a, b, c, d, manual]);

    expect(model.hasSourcePath).toBe(true);
    expect(model.root?.count).toBe(4);
    expect(model.root?.objects.map((set) => set.sourcePath)).toEqual(['2026_ICPC_1']);
    expect(model.root?.children.map((node) => node.key)).toEqual(['2026']);
    expect(model.root?.children[0]?.children.map((node) => node.key)).toEqual(['2026/7', '2026/10']);
    expect(model.root?.children[0]?.children[1]?.objects.map((set) => set.sourcePath)).toEqual([
      '2026/10/10.ptc',
      '2026/10/17.VP',
    ]);
    // 无 sourcePath 的题组是普通题组行（26 已拍板 #9：无负向标签）
    expect(model.unsourced.map((set) => set.id)).toEqual([manual.id]);
  });

  it('来源组的题组数与文件数包含子组', () => {
    const a = sourcedSet('obj_0000000036', '10.ptc', 'practice/2026-10/a', '2026/10/10.ptc');
    a.fileCount = 5;
    const b = sourcedSet('obj_0000000038', 'July', 'practice/2026-07/b', '2026/7/B');
    b.fileCount = 4;
    const model = groupWorkObjectsBySource([a, b]);

    const year = model.root?.children[0]!;
    const october = year.children.find((node) => node.key === '2026/10')!;
    expect(october.count).toBe(1);
    expect(october.fileCount).toBe(5);
    expect(year.count).toBe(2);
    expect(year.fileCount).toBe(9);
    expect(model.root?.count).toBe(2);
    expect(model.root?.fileCount).toBe(9);
  });

  it('比赛不进来源树；没有任何带来源题组时退化为平铺', () => {
    const contest = obj({ id: 'obj_0000000050', kind: 'contest', title: 'C', relPath: 'contests/c', sourcePath: '2026/x' });
    const manual = obj({ id: 'obj_0000000035', kind: 'problemset', title: 'Manual', relPath: 'practice/2026-10/m', parentId: null });
    const only = groupWorkObjectsBySource([manual]);
    expect(only.hasSourcePath).toBe(false);
    expect(only.root).toBeNull();
    expect(only.unsourced.map((set) => set.id)).toEqual([manual.id]);

    const withContest = groupWorkObjectsBySource([contest, manual]);
    expect(withContest.hasSourcePath).toBe(false);
    expect(withContest.unsourced.map((set) => set.id)).toEqual([manual.id]);
  });
});

describe('角色迁移提议（契约 26 §3.2）', () => {
  const evidence = (patch: Partial<Parameters<typeof workMigrateProposalOf>[0]> = {}) => ({
    hasRecord: false,
    hasArenaPath: false,
    hasChildProblem: false,
    hasSourcePath: false,
    ...patch,
  });

  it('record / arenaPath / 旧子题 → 保持比赛', () => {
    expect(workMigrateProposalOf(evidence({ hasRecord: true })).proposal).toBe('keep-contest');
    expect(workMigrateProposalOf(evidence({ hasArenaPath: true })).proposal).toBe('keep-contest');
    expect(workMigrateProposalOf(evidence({ hasChildProblem: true })).proposal).toBe('keep-contest');
  });

  it('sourcePath → 转为题组；全无证据 → 待确认', () => {
    const sourced = workMigrateProposalOf(evidence({ hasSourcePath: true }));
    expect(sourced.proposal).toBe('to-problemset');
    expect(sourced.rule).toContain('sourcePath');

    const ambiguous = workMigrateProposalOf(evidence());
    expect(ambiguous.proposal).toBe('ambiguous');
    expect(ambiguous.rule).toContain('确认');
  });

  it('record 优先于 sourcePath（已存成绩的比赛不迁移）', () => {
    expect(workMigrateProposalOf(evidence({ hasRecord: true, hasSourcePath: true })).proposal).toBe('keep-contest');
  });
});
