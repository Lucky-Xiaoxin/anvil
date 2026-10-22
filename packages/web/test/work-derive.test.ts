import { describe, expect, it } from 'vitest';
import type { WorkObjectDto, WorkTaxonomyDto } from '@anvil/shared';
import {
  allLabels,
  contestBadgeOf,
  contestCountLabel,
  fileSize,
  filterWorkObjects,
  folderActionsOf,
  flatNodes,
  groupWorkObjects,
  kindCounts,
  matchesTag,
  pathBreadcrumb,
  primaryName,
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

  it('flatNodes / 名字 / 计数 / labels', () => {
    expect(flatNodes(taxonomy)).toHaveLength(5);
    expect(flatNodes(null)).toEqual([]);
    expect(primaryName(obj(), taxonomy)).toBe('树');
    expect(kindCounts([obj(), obj({ kind: 'note' })])).toEqual({ all: 2, contest: 0, problem: 1, template: 0, note: 1 });
    expect(allLabels([obj(), obj({ labels: ['赛时', '复盘'] })])).toEqual(expect.arrayContaining(['赛时', '复盘']));
  });

  it('problem 详情两个文件夹入口；其它 kind 只有 auto', () => {
    expect(folderActionsOf('problem')).toEqual([
      { app: 'explorer', label: '打开文件夹' },
      { app: 'vscode', label: '用 VS Code 打开' },
    ]);
    for (const kind of ['contest', 'template', 'note'] as const) {
      expect(folderActionsOf(kind)).toEqual([{ app: 'auto', label: '打开文件夹' }]);
    }
  });

  it('比赛只有挂了题组才显示题组徽章；计数区分源码 / 旧子题', () => {
    const emptyContest = obj({ id: 'obj_0000000020', kind: 'contest', title: 'Empty', relPath: 'contests/x', sourceCount: 0, parentId: null });
    expect(contestBadgeOf(emptyContest, 0)).toBeNull();
    expect(contestCountLabel(emptyContest, 0)).toBe('无题组');
    const groupContest = obj({ ...emptyContest, sourceCount: 3 });
    expect(contestBadgeOf(groupContest, 0)).toBe('题组');
    expect(contestCountLabel(groupContest, 0)).toBe('3 个源码');
    expect(contestBadgeOf(emptyContest, 2)).toBe('题组');
    expect(contestCountLabel(emptyContest, 2)).toBe('2 题');
  });

  it('文件大小与日期', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(2048)).toBe('2.0 KB');
    expect(fileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('中间列表分组（切片 5a.1）', () => {
  const contest = (id: string, title: string, relPath: string): WorkObjectDto =>
    obj({ id, kind: 'contest', title, relPath, parentId: null, links: {} });
  const problem = (id: string, title: string, relPath: string, parentId: string | null): WorkObjectDto =>
    obj({ id, title, relPath, parentId });

  it('比赛题按父比赛分组；比赛本身命中筛选时组头可进详情', () => {
    const c1 = contest('obj_0000000010', 'Shanghai', 'contests/2026-10-21_shanghai');
    const c2 = contest('obj_0000000011', 'Nanjing', 'contests/2026-10-22_nanjing');
    const p1 = problem('obj_0000000012', 'A', 'contests/2026-10-21_shanghai/a', c1.id);
    const p2 = problem('obj_0000000013', 'B', 'contests/2026-10-21_shanghai/b', c1.id);
    const p3 = problem('obj_0000000014', 'C', 'contests/2026-10-22_nanjing/c', c2.id);
    const all = [c1, c2, p1, p2, p3];

    const model = groupWorkObjects(all, all);
    expect(model.groups.map((g) => g.contest.id)).toEqual([c1.id, c2.id]);
    expect(model.groups[0]?.problems.map((p) => p.id)).toEqual([p1.id, p2.id]);
    expect(model.groups[0]?.included).toBe(true);
    expect(model.ungrouped).toEqual([]);
  });

  it('kind=题目 时父比赛不在筛选结果里，仍按比赛分组且组头不可点', () => {
    const c1 = contest('obj_0000000010', 'Shanghai', 'contests/2026-10-21_shanghai');
    const p1 = problem('obj_0000000012', 'A', 'contests/2026-10-21_shanghai/a', c1.id);
    const model = groupWorkObjects([p1], [c1, p1]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.included).toBe(false);
    expect(model.groups[0]?.problems.map((p) => p.id)).toEqual([p1.id]);
  });

  it('未挂比赛的题目进单题区；模板 / 笔记各自成区；父对象缺失兜底', () => {
    const c1 = contest('obj_0000000010', 'Shanghai', 'contests/2026-10-21_shanghai');
    const single = problem('obj_0000000012', 'Single', 'practice/2026-10/single', null);
    const orphan = problem('obj_0000000013', 'Orphan', 'practice/2026-10/orphan', 'obj_0000000099');
    const template = obj({ id: 'obj_0000000014', kind: 'template', title: 'DSU', relPath: 'templates/ds/dsu' });
    const note = obj({ id: 'obj_0000000015', kind: 'note', title: 'Week', relPath: 'notes/2026/10/x' });
    const model = groupWorkObjects([single, orphan, template, note, c1], [c1, single, orphan, template, note]);
    expect(model.ungrouped.map((p) => p.id)).toEqual([single.id]);
    expect(model.orphans.map((p) => p.id)).toEqual([orphan.id]);
    expect(model.templates.map((p) => p.id)).toEqual([template.id]);
    expect(model.notes.map((p) => p.id)).toEqual([note.id]);
    expect(model.groups[0]?.problems).toEqual([]);
  });

  it('单题目录面包屑去掉对象文件夹本身', () => {
    expect(pathBreadcrumb('practice/2026-10/cherry-tree')).toEqual(['practice', '2026-10']);
    expect(pathBreadcrumb('manual/problem')).toEqual(['manual']);
    expect(pathBreadcrumb('cherry-tree')).toEqual([]);
  });
});
