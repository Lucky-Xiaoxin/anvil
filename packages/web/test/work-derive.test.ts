import { describe, expect, it } from 'vitest';
import type { WorkObjectDto } from '@anvil/shared';
import {
  allLabels,
  availableContests,
  contestCountLabel,
  expandKeysForSelection,
  filterWorkObjects,
  folderActionsOf,
  groupWorkObjects,
  groupWorkObjectsBySource,
  kindCounts,
  linkedProblemsetsOf,
  pathBreadcrumb,
  problemsetLinkOf,
  problemsFromArena,
} from '../src/components/work/derive.ts';

const obj = (patch: Partial<WorkObjectDto> = {}): WorkObjectDto => ({
  id: 'obj_0000000001',
  kind: 'problem',
  title: 'Cherry Tree',
  relPath: 'practice/2026-10/cherry-tree',
  parentId: null,
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

describe('工坊派生（30 §3.6：对象检索只覆盖 title / labels / relPath）', () => {
  it('kind / label / 搜索条件 AND；搜索覆盖标题、自由标签、路径', () => {
    const a = obj();
    const b = obj({
      id: 'obj_0000000002',
      kind: 'contest',
      title: 'Shanghai',
      labels: [],
      relPath: 'contests/2026-10-21_shanghai',
    });
    const base = { kind: 'all' as const, label: null, query: '' };
    expect(filterWorkObjects([a, b], base)).toHaveLength(2);
    expect(filterWorkObjects([a, b], { ...base, kind: 'contest' })).toEqual([b]);
    expect(filterWorkObjects([a, b], { ...base, label: '赛时' })).toEqual([a]);
    expect(filterWorkObjects([a, b], { ...base, query: '赛时' })).toEqual([a]);
    expect(filterWorkObjects([a, b], { ...base, query: 'shanghai' })).toEqual([b]);
  });

  it('有待补题筛选只列 todo > 0 的比赛；未标记不计数（30 §6.3）', () => {
    const todo = obj({
      id: 'obj_0000000010',
      kind: 'contest',
      title: 'Has Todo',
      relPath: 'contests/t',
      problemMarkSummary: { total: 3, marked: 1, todo: 1, starred: 0 },
    });
    const noTodo = obj({
      id: 'obj_0000000011',
      kind: 'contest',
      title: 'No Todo',
      relPath: 'contests/n',
      problemMarkSummary: { total: 3, marked: 1, todo: 0, starred: 2 },
    });
    const plain = obj({ id: 'obj_0000000012', kind: 'contest', title: 'Plain', relPath: 'contests/p' });
    const set = obj({ id: 'obj_0000000013', kind: 'problemset', relPath: 'practice/2026-10/x' });
    const base = { kind: 'all' as const, label: null, query: '', pendingOnly: true };
    expect(filterWorkObjects([todo, noTodo, plain, set], base)).toEqual([todo]);
    expect(filterWorkObjects([todo, noTodo, plain, set], { ...base, query: 'nomatch' })).toEqual([]);
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
    const base = { kind: 'all' as const, label: null, query: '' };
    expect(filterWorkObjects([plain, arena, sourced], { ...base, kind: 'contest' })).toHaveLength(3);
    expect(filterWorkObjects([plain, arena, sourced], { ...base, kind: 'problemset' })).toEqual([]);
  });

  it('计数 / labels（五类对象计数互不包含）', () => {
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

  it('比赛行摘要（27 §2.2）：旧子题数 + 关联题组数；都没有时退回源码计数', () => {
    const emptyContest = obj({ id: 'obj_0000000020', kind: 'contest', title: 'Empty', relPath: 'contests/x', sourceCount: 0, parentId: null });
    expect(contestCountLabel(emptyContest, 0, 0)).toBe('');
    const sourcedContest = obj({ ...emptyContest, sourceCount: 3 });
    expect(contestCountLabel(sourcedContest, 0, 0)).toBe('3 个源码');
    expect(contestCountLabel(emptyContest, 2, 0)).toBe('2 题');
    // 0..n：没有旧子题的比赛行也要显示关联题组数（27 §1.8）
    expect(contestCountLabel(emptyContest, 0, 3)).toBe('题组 3');
    expect(contestCountLabel(emptyContest, 2, 3)).toBe('2 题 · 题组 3');
  });
});

describe('榜单 problems[] → 题目快照（30 §3.2；缺 / 坏 alias 按题序补）', () => {
  it('保留合法 alias / title；缺 alias 补字母；重复与非法值也补', () => {
    expect(
      problemsFromArena({
        problems: [
          { alias: 'A', title: ' Alpha ' },
          { title: 'No Alias' },
          { alias: '题一', title: 'Bad Alias' },
          { alias: 'A', title: 'Duplicate' },
        ],
      }),
    ).toEqual([
      { alias: 'A', title: 'Alpha' },
      { alias: 'B', title: 'No Alias' },
      { alias: 'C', title: 'Bad Alias' },
      { alias: 'D', title: 'Duplicate' },
    ]);
  });

  it('超过 26 题用 P<n>；标题截到 200；非榜单 / 空题目返回空数组', () => {
    const many = Array.from({ length: 27 }, (_, i) => ({ title: `T${i}` }));
    expect(problemsFromArena({ problems: many })[26]?.alias).toBe('P27');
    expect(problemsFromArena({ problems: [{ alias: 'A', title: 'x'.repeat(300) }] })[0]?.title).toHaveLength(200);
    expect(problemsFromArena({})).toEqual([]);
    expect(problemsFromArena({ problems: [] })).toEqual([]);
    expect(problemsFromArena(null)).toEqual([]);
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

describe('关联比赛（27 §2：题组 0..1 → 比赛，比赛侧 0..n）', () => {
  const contest = (id: string, title: string, patch: Partial<WorkObjectDto> = {}): WorkObjectDto =>
    obj({ id, kind: 'contest', title, relPath: `contests/${title}`, parentId: null, links: {}, ...patch });
  const problemset = (id: string, title: string, parentId: string | null, patch: Partial<WorkObjectDto> = {}): WorkObjectDto =>
    obj({ id, kind: 'problemset', title, relPath: `practice/2026-10/${title}`, parentId, ...patch });

  it('题组行显示关联比赛；父对象缺失是 missing，父对象归档是 archived（27 §1.6）', () => {
    const c1 = contest('obj_0000000040', 'Shanghai');
    const cArchived = contest('obj_0000000047', 'Old', { archived: true, effectiveArchived: true });
    const linked = problemset('obj_0000000041', 'TreeDP', c1.id);
    const free = problemset('obj_0000000042', 'Free', null);
    const broken = problemset('obj_0000000043', 'Broken', 'obj_0000000099');
    const crossArchived = problemset('obj_0000000048', 'Cross', cArchived.id);
    const all = [c1, cArchived, linked, free, broken, crossArchived];
    const byId = new Map(all.map((o) => [o.id, o]));

    expect(problemsetLinkOf(linked, byId)).toEqual({ state: 'ok', contest: c1 });
    expect(problemsetLinkOf(free, byId)).toEqual({ state: 'none', contest: null });
    expect(problemsetLinkOf(broken, byId)).toEqual({ state: 'missing', contest: null });
    expect(problemsetLinkOf(c1, byId)).toEqual({ state: 'none', contest: null });
    // 活动题组关联归档比赛：显示「已归档」，不是「不可用 / 缺失」
    expect(problemsetLinkOf(crossArchived, byId)).toEqual({ state: 'archived', contest: cArchived });
  });

  it('比赛 → 关联题组 0..n：无关联 / 一个 / 多个；按归档拆组（27 §1.3）', () => {
    const c1 = contest('obj_0000000040', 'Shanghai');
    const c2 = contest('obj_0000000044', 'Nanjing');
    const a = problemset('obj_0000000041', 'A', c1.id);
    const b = problemset('obj_0000000045', 'B', c1.id);
    const c = problemset('obj_0000000046', 'C', c1.id, { archived: true, effectiveArchived: true });
    const elsewhere = problemset('obj_0000000042', 'D', c2.id);

    expect(linkedProblemsetsOf(c1, [c1, c2, a, b, c, elsewhere])).toEqual({ active: [a, b], archived: [c] });
    expect(linkedProblemsetsOf(c2, [c1, c2, a, b, c, elsewhere])).toEqual({ active: [elsewhere], archived: [] });
    expect(linkedProblemsetsOf(c1, [c1])).toEqual({ active: [], archived: [] });
  });

  it('关联选择器只列活动比赛（27 §1.5）：归档比赛不进候选，也不再看占用', () => {
    const c1 = contest('obj_0000000040', 'Shanghai');
    const c2 = contest('obj_0000000044', 'Nanjing');
    const cArchived = contest('obj_0000000047', 'Old', { archived: true, effectiveArchived: true });
    const mine = problemset('obj_0000000041', 'TreeDP', c1.id);
    const other = problemset('obj_0000000045', 'Other', c2.id);
    // 0..n：c1 / c2 已被题组关联仍可再挂；只有归档比赛被排除（relPath 排序：Nanjing 在前）
    expect(availableContests([c1, c2, cArchived, mine, other]).map((o) => o.id)).toEqual([c2.id, c1.id]);
    expect(availableContests([cArchived])).toEqual([]);
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

describe('选中项自动展开键（修复：手动折叠不被弹回的前提是 effect 只看选中项）', () => {
  it('题组沿来源祖先链给出 src: 键，从直接父级到根', () => {
    const set = obj({
      id: 'obj_0000000060',
      kind: 'problemset',
      title: 'X',
      relPath: 'practice/2026-10/x',
      sourcePath: '2026/7/16.div1',
    });
    const model = groupWorkObjects([set], [set]);
    expect(expandKeysForSelection(set.id, [set], model)).toEqual(['src:2026/7', 'src:2026', 'src:']);
  });

  it('无来源题组没有 src 键；旧题目对象与其父比赛给组键；未选中项不产生键', () => {
    const bare = obj({ id: 'obj_0000000061', kind: 'problemset', title: 'Bare', relPath: 'practice/2026-10/bare' });
    const contest = obj({ id: 'obj_0000000062', kind: 'contest', title: 'C', relPath: 'contests/c' });
    const problem = obj({ id: 'obj_0000000063', title: 'P', relPath: 'contests/c/p', parentId: contest.id });
    const all = [contest, problem, bare];
    const model = groupWorkObjects(all, all);
    expect(expandKeysForSelection(bare.id, all, model)).toEqual([]);
    expect(expandKeysForSelection(problem.id, all, model)).toEqual([contest.id]);
    expect(expandKeysForSelection(contest.id, all, model)).toEqual([contest.id]);
    expect(expandKeysForSelection('obj_0000000099', all, model)).toEqual([]);
  });
});

describe('默认模板标（23 §6.1：非归档里 updatedAt 最新的一件）', () => {
  const older = obj({ id: 'obj_0000000070', kind: 'template', title: 'Older', relPath: 'templates/a', updatedAt: '2026-10-20T00:00:00.000Z' });
  const newer = obj({ id: 'obj_0000000071', kind: 'template', title: 'Newer', relPath: 'templates/b', updatedAt: '2026-10-22T00:00:00.000Z' });
  const set = obj({ id: 'obj_0000000072', kind: 'problemset', title: 'S', relPath: 'practice/2026-10/s' });

  it('给默认那件打标；判据看全量对象，不随 kind 筛选变', () => {
    const all = [older, newer, set];
    expect(groupWorkObjects(all, all).defaultTemplateId).toBe(newer.id);
    expect(groupWorkObjects([set], all).defaultTemplateId).toBe(newer.id);
  });

  it('归档模板不参与；一件模板都没有就没有默认', () => {
    const archived = { ...newer, archived: true, effectiveArchived: true };
    expect(groupWorkObjects([older, archived], [older, archived]).defaultTemplateId).toBe(older.id);
    expect(groupWorkObjects([set], [set]).defaultTemplateId).toBeNull();
  });
});
