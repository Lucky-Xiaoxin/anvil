import { describe, expect, it } from 'vitest';
import type { WorkObjectDto, WorkTaxonomyDto } from '@anvil/shared';
import { allLabels, fileSize, filterWorkObjects, flatNodes, kindCounts, matchesTag, primaryName } from '../src/components/work/derive.ts';

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

  it('文件大小与日期', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(2048)).toBe('2.0 KB');
    expect(fileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
