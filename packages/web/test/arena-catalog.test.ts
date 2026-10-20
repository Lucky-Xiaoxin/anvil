/**
 * 目录派生与会话存储单测（docs/contracts/16 §5.1 / §3）。零网络、夹具自造。
 */
import { describe, expect, it } from 'vitest';
import type { ArenaCatalogNode } from '@anvil/shared';
import { catalogHeadline, flattenLeaves, leafRowOf, searchLeaves, tierOf, toGroupNode } from '../src/components/arena/catalog.ts';
import {
  clearGhost,
  clearSession,
  ghostKey,
  loadGhost,
  loadOpenGroups,
  loadRail,
  loadScrollTop,
  loadSession,
  listSessionPaths,
  saveGhost,
  saveOpenGroups,
  saveRail,
  saveScrollTop,
  saveSession,
  type Store,
} from '../src/components/arena/session.ts';

/** 内存版 localStorage：带 key()/length，够走「枚举进行中场次」那条路 */
function memoryStore(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Store & { map: Map<string, string> };
}

const leaf = (name: string, path: string): ArenaCatalogNode => ({ name, path, format: 'srk.json', count: 1 });

const TREE: ArenaCatalogNode[] = [
  {
    name: 'ICPC',
    count: 3,
    children: [
      { name: 'ICPC 2025 (50th)', count: 2, children: [leaf('2025-11-23 上海站', 'official/icpc/icpc2025/a.srk.json'), leaf('2025-10-19 西安站', 'official/icpc/icpc2025/b.srk.json')] },
      { name: 'ICPC 2019 (44th)', count: 1, children: [leaf('2019-11-30 南京站', 'official/icpc/icpc2019/c.srk.json')] },
    ],
  },
  { name: 'Universal Cup', count: 1, children: [leaf('2026-05-10 The 3rd Finals', 'official/ucup/u1.srk.json')] },
];

describe('tier 徽章派生', () => {
  it('关键词优先于类目', () => {
    expect(tierOf('2025-04-27 武汉邀请赛 icpc2025invitational-wuhan', 'ICPC')).toEqual({ tier: 'invitational', label: '邀请赛' });
    expect(tierOf('2025-09-07 网络赛第一场 icpc2025preliminary-1', 'ICPC')).toEqual({ tier: 'other', label: '网络赛' });
    expect(tierOf('2025-12-20 EC Final finals', 'ICPC')).toEqual({ tier: 'final', label: '决赛' });
  });

  it('半决赛不能被 finals 抢走', () => {
    expect(tierOf('2025-08-24 The 3rd Semifinals ucup3rdsemifinals', 'Universal Cup')).toEqual({ tier: 'other', label: '半决赛' });
    expect(tierOf('2026-05-10 The 3rd Finals ucup3rdfinals', 'Universal Cup')).toEqual({ tier: 'final', label: '决赛' });
  });

  it('类目兜底：省赛 / 校赛 / UCUP / ICPC 站点名', () => {
    expect(tierOf('2026-05-10 2026 bjcpc2026', '省赛')).toEqual({ tier: 'provincial', label: '省赛' });
    expect(tierOf('2023-05-28 2023 thupc2023', '校赛')).toEqual({ tier: 'other', label: '校赛' });
    expect(tierOf('2025-05-18 第九届 hecpc9th', '省赛')).toEqual({ tier: 'provincial', label: '省赛' });
    expect(tierOf('2025-10-19 西安站 icpc2025xi_an', 'ICPC')).toEqual({ tier: 'regional', label: '区域赛' });
    expect(tierOf('某场没关键词的比赛 x', 'CCPC')).toEqual({ tier: 'regional', label: '区域赛' });
    // 认不出的类目不硬套一档：徽章文字退回类目名
    expect(tierOf('某场没关键词的比赛 x', '邀请赛之外的新类目')).toEqual({ tier: 'other', label: '邀请赛之外的新类目' });
  });
});

describe('目录行与搜索', () => {
  it('叶子名剥掉日期前缀，没有日期就留空', () => {
    const row = leafRowOf(leaf('2025-11-23 上海站', 'official/icpc/icpc2025/a.srk.json'), ['ICPC', 'ICPC 2025 (50th)']);
    expect(row.date).toBe('2025-11-23');
    expect(row.name).toBe('上海站');
    const noDate = leafRowOf(leaf('无日期场次', 'official/x.srk.json'), ['ICPC']);
    expect(noDate.date).toBe('');
    expect(noDate.name).toBe('无日期场次');
  });

  it('名称整个是日期时退回路径段，不给空行', () => {
    const row = leafRowOf(leaf('2025-11-23', 'official/icpc/icpc2025/zz.srk.json'), ['ICPC']);
    expect(row.date).toBe('2025-11-23');
    expect(row.name).toBe('zz');
  });

  it('目录里的占位日期照原样进日期列，不假装知道月日（实测 2009 武汉网络赛）', () => {
    const row = leafRowOf(leaf('2009-??-?? 武汉网络赛', 'official/icpc/icpc2009/icpc2009preliminary-wuhan.srk.json'), ['ICPC', 'ICPC 2009']);
    expect(row.date).toBe('2009-??-??');
    expect(row.name).toBe('武汉网络赛');
    expect(row.badge).toEqual({ tier: 'other', label: '网络赛' });
  });

  it('cached 透传：服务端标的本地缓存跟着进行，没标的当没缓存（docs/contracts/20 §1 预拉取）', () => {
    const hit = leafRowOf({ ...leaf('2025-11-23 上海站', 'official/icpc/icpc2025/a.srk.json'), cached: true }, ['ICPC']);
    expect(hit.cached).toBe(true);
    expect(leafRowOf(leaf('2025-10-19 西安站', 'official/icpc/icpc2025/b.srk.json'), ['ICPC']).cached).toBe(false);
    // 摊平（搜索命中）与分组（树视图）两条路都要带上，界面只从 LeafRow 读这一份
    const tree: ArenaCatalogNode[] = [
      { name: 'ICPC', count: 2, children: [
        { ...leaf('2025-11-23 上海站', 'official/icpc/icpc2025/a.srk.json'), cached: true },
        leaf('2025-10-19 西安站', 'official/icpc/icpc2025/b.srk.json'),
      ] },
    ];
    expect(flattenLeaves(tree).map((r) => [r.path, r.cached])).toEqual([
      ['official/icpc/icpc2025/a.srk.json', true],
      ['official/icpc/icpc2025/b.srk.json', false],
    ]);
    expect(toGroupNode(tree[0]!, []).leaves.map((r) => r.cached)).toEqual([true, false]);
  });

  it('摊平后按名称 / 日期 / 分组链命中，大小写不敏感', () => {
    const rows = flattenLeaves(TREE);
    expect(rows).toHaveLength(4);
    expect(searchLeaves(rows, '上海').map((r) => r.name)).toEqual(['上海站']);
    expect(searchLeaves(rows, '2019').map((r) => r.name)).toEqual(['南京站']);
    expect(searchLeaves(rows, 'universal cup')).toHaveLength(1);
    expect(searchLeaves(rows, 'ICPC 2025')).toHaveLength(2);
    expect(searchLeaves(rows, '   ')).toEqual([]);
    expect(searchLeaves(rows, '不存在的站名')).toEqual([]);
  });

  it('分组结构：叶子与子分组分列，计数照服务端给的 count', () => {
    const top = toGroupNode(TREE[0]!, []);
    expect(top.name).toBe('ICPC');
    expect(top.count).toBe(3);
    expect(top.leaves).toEqual([]);
    expect(top.kids.map((k) => [k.name, k.count, k.leaves.length])).toEqual([
      ['ICPC 2025 (50th)', 2, 2],
      ['ICPC 2019 (44th)', 1, 1],
    ]);
    expect(catalogHeadline(394)).toBe('目录 394 场 · 榜单来自官方快照');
  });
});

describe('会话与轨道状态存储', () => {
  const PATH = 'official/icpc/icpc2025/a.srk.json';

  it('没有记录 → null；坏 JSON → null 而不是抛', () => {
    const s = memoryStore();
    expect(loadSession(s, PATH)).toBeNull();
    s.setItem(`arena:session:${PATH}`, '{ 半截');
    expect(loadSession(s, PATH)).toBeNull();
    s.setItem(`arena:session:${PATH}`, JSON.stringify({ started: '不是数字' }));
    expect(loadSession(s, PATH)).toBeNull();
  });

  it('缺字段回落到安全默认值，不造出 NaN 时钟', () => {
    const s = memoryStore();
    s.setItem(`arena:session:${PATH}`, JSON.stringify({ started: 1234, paused: true }));
    expect(loadSession(s, PATH)).toEqual({ started: 1234, hold: false, paused: true, ended: false, scrubMs: 0, at: 0, durationMs: 0 });
  });

  it('每场一条，按官方路径分键，互不串台', () => {
    const s = memoryStore();
    const a = { started: 1, hold: false, paused: false, ended: false, scrubMs: 0, at: 0, durationMs: 5 };
    const b = { ...a, started: 2 };
    saveSession(s, 'official/x/a.srk.json', a);
    saveSession(s, 'official/x/b.srk.json', b);
    expect(loadSession(s, 'official/x/a.srk.json')?.started).toBe(1);
    expect(loadSession(s, 'official/x/b.srk.json')?.started).toBe(2);
    expect(listSessionPaths(s).sort()).toEqual(['official/x/a.srk.json', 'official/x/b.srk.json']);
    clearSession(s, 'official/x/a.srk.json');
    expect(listSessionPaths(s)).toEqual(['official/x/b.srk.json']);
  });

  it('存储抛错时静默降级：读回 null / 写不进去也不炸', () => {
    const angry = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(loadSession(angry, PATH)).toBeNull();
    expect(() => saveSession(angry, PATH, { started: 1, hold: false, paused: false, ended: false, scrubMs: 0, at: 0, durationMs: 0 })).not.toThrow();
    expect(() => clearSession(angry, PATH)).not.toThrow();
    expect(listSessionPaths(angry)).toEqual([]);
  });

  it('侧栏收起态：只有 "1" 算收起，其他一律展开', () => {
    const s = memoryStore();
    expect(loadRail(s)).toBe(false);
    saveRail(s, true);
    expect(loadRail(s)).toBe(true);
    expect(s.getItem('arena:rail')).toBe('1');
    saveRail(s, false);
    expect(loadRail(s)).toBe(false);
    s.setItem('arena:rail', 'yes');
    expect(loadRail(s)).toBe(false);
  });
});

describe('「我的成绩」幽灵行存储（docs/contracts/20 §2.1 · v8 逐发）', () => {
  const PATH = 'official/icpc/icpc2025/a.srk.json';

  it('键族是 arena:ghost:<官方路径>，且不混进「进行中场次」的枚举', () => {
    expect(ghostKey(PATH)).toBe(`arena:ghost:${PATH}`);
    const s = memoryStore();
    saveGhost(s, PATH, { show: true, subs: [{ p: 0, t: 113, r: 'AC' }] });
    // 目录那行「回放中」只认 arena:session: 前缀，幽灵键不该被当成一场活着的回放
    expect(listSessionPaths(s)).toEqual([]);
  });

  it('subs 先按题、再按时刻升序落盘（乱序录入也存成榜上的读法）', () => {
    const s = memoryStore();
    saveGhost(s, PATH, {
      show: true,
      subs: [
        { p: 7, t: 187, r: 'AC' },
        { p: 1, t: 45, r: 'AC' },
        { p: 7, t: 170, r: 'WA' },
        { p: 1, t: 28, r: 'WA' },
      ],
    });
    expect(s.getItem(ghostKey(PATH))).toBe(
      '{"show":true,"subs":[{"p":1,"t":28,"r":"WA"},{"p":1,"t":45,"r":"AC"},{"p":7,"t":170,"r":"WA"},{"p":7,"t":187,"r":"AC"}]}',
    );
  });

  it('「展示我」关掉也照样留数据；全空的 subs 存得下（清除后重录）', () => {
    const s = memoryStore();
    saveGhost(s, PATH, { show: false, subs: [{ p: 0, t: 113, r: 'AC' }] });
    expect(loadGhost(s, PATH)).toEqual({ show: false, subs: [{ p: 0, t: 113, r: 'AC' }] });
    saveGhost(s, PATH, { show: true, subs: [] });
    expect(loadGhost(s, PATH)).toEqual({ show: true, subs: [] });
  });

  it('没存过 / 空串 / 坏 JSON / 形状不对 → null（当没有，而不是半条榜）', () => {
    const s = memoryStore();
    expect(loadGhost(s, PATH)).toBeNull();
    for (const raw of ['', '{ 半截', '[]', '3', 'null', '{"subs":"不是数组"}', '{"show":true}']) {
      s.setItem(ghostKey(PATH), raw);
      expect(loadGhost(s, PATH)).toBeNull();
    }
  });

  it('v7 那份聚合形状（{ show, marks }）不迁移 → 当没有，面板全空重录', () => {
    const s = memoryStore();
    s.setItem(ghostKey(PATH), '{"show":true,"marks":[{"p":0,"ac":113},{"p":10,"fails":2}]}');
    expect(loadGhost(s, PATH)).toBeNull();
  });

  it('缺 show 默认开（手改的键不该把行悄悄藏掉）', () => {
    const s = memoryStore();
    s.setItem(ghostKey(PATH), '{"subs":[{"p":1,"t":60,"r":"AC"}]}');
    expect(loadGhost(s, PATH)).toEqual({ show: true, subs: [{ p: 1, t: 60, r: 'AC' }] });
  });

  it('非法逐发整条丢弃：题序或时刻不是非负整数、判名不在五档内都不要（FB 进不来 → 幽灵永不首杀）', () => {
    const s = memoryStore();
    s.setItem(
      ghostKey(PATH),
      '{"show":true,"subs":[null,7,{"p":0,"t":10},{"p":"A","t":10,"r":"AC"},{"p":-1,"t":10,"r":"AC"},' +
        '{"p":1.5,"t":10,"r":"AC"},{"p":2,"t":-5,"r":"AC"},{"p":3,"t":1.5,"r":"AC"},' +
        '{"p":4,"t":20,"r":"RJ"},{"p":5,"t":30,"r":"FB"},{"p":6,"t":40,"r":"AC"},{"p":7,"t":50,"r":"CE"},' +
        '{"p":8,"t":60,"r":"AC","extra":"多字段不影响"}]}',
    );
    expect(loadGhost(s, PATH)?.subs).toEqual([
      { p: 6, t: 40, r: 'AC' },
      { p: 7, t: 50, r: 'CE' },
      { p: 8, t: 60, r: 'AC' },
    ]);
  });

  it('每场一条互不串台；clearGhost 只删这一场的键，会话记录照旧', () => {
    const s = memoryStore();
    saveGhost(s, 'official/x/a.srk.json', { show: true, subs: [{ p: 0, t: 10, r: 'AC' }] });
    saveGhost(s, 'official/x/b.srk.json', { show: true, subs: [{ p: 1, t: 20, r: 'WA' }] });
    saveSession(s, 'official/x/a.srk.json', { started: 1, hold: false, paused: false, ended: false, scrubMs: 0, at: 0, durationMs: 5 });
    clearGhost(s, 'official/x/a.srk.json');
    expect(loadGhost(s, 'official/x/a.srk.json')).toBeNull();
    expect(loadGhost(s, 'official/x/b.srk.json')?.subs).toEqual([{ p: 1, t: 20, r: 'WA' }]);
    expect(loadSession(s, 'official/x/a.srk.json')?.started).toBe(1);
  });

  it('存储抛错时静默降级：读回 null / 写不进去也不炸', () => {
    const angry = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(loadGhost(angry, PATH)).toBeNull();
    expect(() => saveGhost(angry, PATH, { show: true, subs: [{ p: 0, t: 10, r: 'AC' }] })).not.toThrow();
    expect(() => clearGhost(angry, PATH)).not.toThrow();
  });
});

describe('目录收放与停留位置存储', () => {
  it('没存过 → 空集合（默认全收起，连顶层五类也不自动展开）', () => {
    const s = memoryStore();
    expect(loadOpenGroups(s).size).toBe(0);
  });

  it('存展开的组键集合，回读逐键相等；重复键自然并掉', () => {
    const s = memoryStore();
    saveOpenGroups(s, new Set(['ICPC', 'ICPC / ICPC 2025 (50th)', 'ICPC']));
    expect([...loadOpenGroups(s)]).toEqual(['ICPC', 'ICPC / ICPC 2025 (50th)']);
    expect(s.getItem('arena:tree')).toBe('["ICPC","ICPC / ICPC 2025 (50th)"]');
  });

  it('坏 JSON / 不是数组 / 混进非字符串 → 各自退回能读的部分，不抛', () => {
    const s = memoryStore();
    s.setItem('arena:tree', '[ "ICPC", 7, null, "省赛" ]');
    expect([...loadOpenGroups(s)]).toEqual(['ICPC', '省赛']);
    s.setItem('arena:tree', '{ "ICPC": true }');
    expect(loadOpenGroups(s).size).toBe(0);
    s.setItem('arena:tree', '半截');
    expect(loadOpenGroups(s).size).toBe(0);
  });

  it('滚动位置：正数四舍五入回读，坏值 / 负数当 0', () => {
    const s = memoryStore();
    expect(loadScrollTop(s)).toBe(0);
    saveScrollTop(s, 1234.6);
    expect(loadScrollTop(s)).toBe(1235);
    s.setItem('arena:tree-scroll', 'NaN');
    expect(loadScrollTop(s)).toBe(0);
    s.setItem('arena:tree-scroll', '-40');
    expect(loadScrollTop(s)).toBe(0);
  });

  it('存储抛错时静默降级：读回默认、写不进去也不炸', () => {
    const angry = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(loadOpenGroups(angry).size).toBe(0);
    expect(loadScrollTop(angry)).toBe(0);
    expect(() => saveOpenGroups(angry, new Set(['ICPC']))).not.toThrow();
    expect(() => saveScrollTop(angry, 10)).not.toThrow();
  });
});
