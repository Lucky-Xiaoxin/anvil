import { describe, expect, it } from 'vitest';
import {
  buildWorkRelPath,
  cleanLabels,
  defaultTemplateOf,
  flattenTaxonomy,
  localDateParts,
  parseTaxonomy,
  parseWorkArenaRecord,
  parseWorkMeta,
  seedTaxonomy,
  slugForAttempt,
  slugify,
  unregisteredKindHint,
  workMetaToJson,
  workMigrateProposalOf,
} from '@anvil/shared';

const D = new Date(2026, 9, 21, 12); // 本地 2026-10-21（路径日期取服务端本地日期）

const meta = (patch: Record<string, unknown> = {}) => ({
  schema: 1,
  id: 'obj_7f3a2c9b1d',
  kind: 'problem',
  title: 'Cherry Tree',
  createdAt: '2026-10-21T02:00:00.000Z',
  updatedAt: '2026-10-21T02:10:00.000Z',
  parentId: null,
  tags: { primary: 'graph/tree', related: ['dp/tree-dp'] },
  labels: ['赛时', '没调出来'],
  links: { problemKey: 'cf:2184:F' },
  archived: false,
  ...patch,
});

describe('slugify / 路径分配（契约 §5）', () => {
  it('普通标题与字母数字边界', () => {
    expect(slugify('Cherry Tree')).toBe('cherry-tree');
    expect(slugify('CF2184F')).toBe('cf-2184-f');
    expect(slugify('cf:2184:F')).toBe('cf-2184-f');
    expect(slugify('  A  B  ')).toBe('a-b');
  });

  it('中文 / 纯符号得到空 slug', () => {
    expect(slugify('樱花树')).toBe('');
    expect(slugify('（）')).toBe('');
  });

  it('去变音、保留名、结尾点空格、长度上限', () => {
    expect(slugify('Café')).toBe('cafe');
    const long = 'a'.repeat(60);
    expect(slugify(long)).toHaveLength(40);
    const rel = buildWorkRelPath('contest', { title: 'CON', date: D });
    expect(rel.ok && rel.value.relPath).toBe('contests/2026-10-21_con-obj');
    expect(slugify('foo. ')).toBe('foo');
  });

  it('冲突后缀：-2 / -3，且不超过 40 字', () => {
    expect(slugForAttempt('cherry-tree', 1)).toBe('cherry-tree');
    expect(slugForAttempt('cherry-tree', 2)).toBe('cherry-tree-2');
    expect(slugForAttempt('cherry-tree', 3)).toBe('cherry-tree-3');
    expect(slugForAttempt('a'.repeat(40), 12).length).toBeLessThanOrEqual(40);
    expect(slugForAttempt('a'.repeat(40), 12).endsWith('-12')).toBe(true);
  });
});

describe('受管路径（契约 §5.1 / 26 §2.1）', () => {
  it('五类对象的物理容器；题组落 practice/<YYYY-MM>，parentId 不进路径', () => {
    expect(buildWorkRelPath('contest', { title: 'Shanghai', date: D })).toEqual({
      ok: true,
      value: { slug: 'shanghai', relPath: 'contests/2026-10-21_shanghai' },
    });
    expect(buildWorkRelPath('problemset', { title: 'TreeDP', date: D })).toEqual({
      ok: true,
      value: { slug: 'treedp', relPath: 'practice/2026-10/treedp' },
    });
    expect(buildWorkRelPath('problem', { title: 'Cherry Tree', date: D })).toEqual({
      ok: true,
      value: { slug: 'cherry-tree', relPath: 'practice/2026-10/cherry-tree' },
    });
    expect(buildWorkRelPath('problem', { title: 'Cherry Tree', parentRelPath: 'contests/2026-10-21_shanghai', date: D })).toEqual({
      ok: true,
      value: { slug: 'cherry-tree', relPath: 'contests/2026-10-21_shanghai/cherry-tree' },
    });
    expect(buildWorkRelPath('template', { title: 'DSU', topId: 'ds', date: D }).ok).toBe(true);
    expect(buildWorkRelPath('template', { title: 'DSU', date: D })).toEqual({
      ok: true,
      value: { slug: 'dsu', relPath: 'templates/_unsorted/dsu' },
    });
    expect(buildWorkRelPath('note', { title: 'Week 1', date: D })).toEqual({
      ok: true,
      value: { slug: 'week-1', relPath: 'notes/2026/10/2026-10-21_week-1' },
    });
  });

  it('纯中文标题按来源回退：problemKey / arenaPath / kind+日期', () => {
    const byKey = buildWorkRelPath('problem', { title: '樱花树', problemKey: 'cf:2184:F', date: D });
    expect(byKey.ok && byKey.value.relPath).toBe('practice/2026-10/cf-2184-f');
    const byArena = buildWorkRelPath('contest', {
      title: '上海站',
      arenaPath: 'official/icpc/icpc2025/icpc2025shanghai.srk.json',
      date: D,
    });
    expect(byArena.ok && byArena.value.relPath).toBe('contests/2026-10-21_icpc2025shanghai');
    const plain = buildWorkRelPath('problem', { title: '樱花树', date: D });
    expect(plain.ok && plain.value.relPath).toBe('practice/2026-10/problem-2026-10-21');
  });

  it('超长路径直接失败，不静默截断', () => {
    const rel = buildWorkRelPath('note', { title: 'a'.repeat(40), parentRelPath: null, date: D });
    expect(rel.ok).toBe(true);
    const tooLong = buildWorkRelPath('problem', {
      title: 'a'.repeat(40),
      parentRelPath: `contests/${'x'.repeat(150)}`,
      date: D,
    });
    expect(tooLong.ok).toBe(false);
  });

  it('本地日期分片', () => {
    expect(localDateParts(D)).toEqual({ date: '2026-10-21', month: '2026-10', year: '2026', monthNum: '10' });
  });

  it('未登记候选位置 → kindHint（practice 自 5a-4 起提议题组）', () => {
    expect(unregisteredKindHint('contests/2026-10-21_x')).toBe('contest');
    expect(unregisteredKindHint('practice/2026-10/x')).toBe('problemset');
    expect(unregisteredKindHint('templates/ds/x')).toBe('template');
    expect(unregisteredKindHint('templates')).toBeNull();
    expect(unregisteredKindHint('notes/2026/10/x')).toBe('note');
    expect(unregisteredKindHint('practice/x')).toBeNull();
  });
});

describe('meta 校验（契约 §4.2）', () => {
  it('最小合法对象与缺省字段', () => {
    const parsed = parseWorkMeta({
      schema: 1,
      id: 'obj_7f3a2c9b1d',
      kind: 'contest',
      title: '  Shanghai  ',
      createdAt: '2026-10-21T02:00:00.000Z',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.meta.title).toBe('Shanghai');
    expect(parsed.record.meta.updatedAt).toBe('2026-10-21T02:00:00.000Z');
    expect(parsed.record.meta.parentId).toBeNull();
    expect(parsed.record.meta.tags).toEqual({ primary: null, related: [] });
    expect(parsed.record.meta.labels).toEqual([]);
    expect(parsed.record.meta.links).toEqual({});
    expect(parsed.record.meta.archived).toBe(false);
  });

  it('缺必填 / 类型错 / schema=2 / 时间坏 → 拒绝', () => {
    const base = meta();
    expect(parseWorkMeta({ ...base, id: 'obj_short' }).ok).toBe(false);
    expect(parseWorkMeta({ ...base, kind: 'other' }).ok).toBe(false);
    expect(parseWorkMeta({ ...base, title: '   ' }).ok).toBe(false);
    expect(parseWorkMeta({ ...base, schema: 2 }).ok).toBe(false);
    expect(parseWorkMeta({ ...base, createdAt: 'yesterday' }).ok).toBe(false);
    expect(parseWorkMeta({ ...base, archived: 'yes' }).ok).toBe(false);
  });

  it('parentId 只有 problemset / problem 可以非空（26 §2.3）', () => {
    expect(parseWorkMeta(meta({ parentId: 'obj_1a2b3c4d5e' })).ok).toBe(true);
    expect(parseWorkMeta(meta({ kind: 'problemset', parentId: 'obj_1a2b3c4d5e', links: {} })).ok).toBe(true);
    expect(parseWorkMeta(meta({ kind: 'contest', parentId: 'obj_1a2b3c4d5e' })).ok).toBe(false);
    expect(parseWorkMeta(meta({ kind: 'template', parentId: 'obj_1a2b3c4d5e', links: {} })).ok).toBe(false);
  });

  it('related 去重、不得含 primary；labels 清洗与上限', () => {
    const ok = parseWorkMeta(meta({ tags: { primary: 'graph', related: ['dp', 'dp'] } }));
    expect(ok.ok && ok.record.meta.tags.related).toEqual(['dp']);
    expect(parseWorkMeta(meta({ tags: { primary: 'graph', related: ['graph'] } })).ok).toBe(false);
    const labelsParsed = parseWorkMeta(meta({ labels: ['#赛时', '  赛后 ', '赛时'] }));
    expect(labelsParsed.ok && labelsParsed.record.meta.labels).toEqual(['赛时', '赛后']);
    expect(cleanLabels(Array.from({ length: 21 }, (_, i) => `l${i}`)).ok).toBe(false);
    expect(cleanLabels(['']).ok).toBe(false);
    expect(cleanLabels(['a'.repeat(25)]).ok).toBe(false);
  });

  it('links.arenaPath 走榜单白名单；arenaPath 只属于 contest（26 §2.4）', () => {
    expect(parseWorkMeta(meta({ kind: 'contest', links: { arenaPath: 'official/icpc/x/y.srk.json' } })).ok).toBe(true);
    expect(parseWorkMeta(meta({ kind: 'contest', links: { arenaPath: '../y.srk.json' } })).ok).toBe(false);
    expect(parseWorkMeta(meta({ kind: 'problemset', links: { arenaPath: 'official/icpc/x/y.srk.json' } })).ok).toBe(false);
  });

  it('sourcePath 可选、清洗后写回，不合法拒绝', () => {
    const parsed = parseWorkMeta(meta({ sourcePath: '2026/10/10.ptc' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.meta.sourcePath).toBe('2026/10/10.ptc');
    expect(workMetaToJson(parsed.record).sourcePath).toBe('2026/10/10.ptc');

    for (const bad of ['', '/abs', 'a\\b', 'a/../b', 'a//b']) {
      expect(parseWorkMeta(meta({ sourcePath: bad })), bad).toMatchObject({ ok: false });
    }
    const absent = parseWorkMeta(meta());
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.record.meta.sourcePath).toBeUndefined();
  });

  it('未知顶层字段写回时保留', () => {
    const parsed = parseWorkMeta(meta({ custom: { keep: 1 }, note: '手写扩展' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const written = workMetaToJson(parsed.record);
    expect(written.custom).toEqual({ keep: 1 });
    expect(written.note).toBe('手写扩展');
  });
});

describe('taxonomy（契约 §7）', () => {
  it('种子词表可解析，13 个一级轴', () => {
    const seed = seedTaxonomy();
    expect(seed.nodes).toHaveLength(13);
    const parsed = parseTaxonomy(seed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.taxonomy.version).toBe(1);
    expect(flattenTaxonomy(parsed.taxonomy.nodes)).toHaveLength(13 + seed.nodes.reduce((n, x) => n + (x.children?.length ?? 0), 0));
  });

  it('最多两级 / 重复 ID / 非法 ID / 别名', () => {
    const base = { schema: 1, version: 1, nodes: [{ id: 'graph', name: '图论', children: [{ id: 'graph/hld', name: '树链剖分' }] }] };
    expect(parseTaxonomy(base).ok).toBe(true);
    expect(parseTaxonomy({ ...base, nodes: [{ id: 'graph', name: '图论', children: [{ id: 'graph/hld', name: '树', children: [{ id: 'graph/hld/x', name: 'x' }] }] }] }).ok).toBe(false);
    expect(parseTaxonomy({ ...base, nodes: [{ id: 'graph', name: '图论' }, { id: 'graph', name: '重复' }] }).ok).toBe(false);
    expect(parseTaxonomy({ ...base, nodes: [{ id: 'Graph', name: '图论' }] }).ok).toBe(false);
    expect(parseTaxonomy({ ...base, aliases: { 树剖: 'graph/hld' } }).ok).toBe(true);
    expect(parseTaxonomy({ ...base, aliases: { 树剖: 'graph/nope' } }).ok).toBe(false);
  });

  it('悬空引用不在这里判（扫描时进 tag-missing），词表自身坏才 null', () => {
    const parsed = parseTaxonomy({ schema: 1, version: 1, nodes: [{ id: 'graph', name: '图论' }], aliases: {} });
    expect(parsed.ok).toBe(true);
    expect(parseTaxonomy({ schema: 2, version: 1, nodes: [] }).ok).toBe(false);
  });
});

describe('默认模板（切片 5a.1）', () => {
  const template = (patch: Record<string, unknown> = {}) => ({
    kind: 'template' as const,
    effectiveArchived: false,
    updatedAt: '2026-10-21T02:00:00.000Z',
    relPath: 'templates/ds/dsu',
    ...patch,
  });

  it('取非归档模板里 updatedAt 最新的一件；同刻按 relPath', () => {
    const older = template({ updatedAt: '2026-10-20T00:00:00.000Z', relPath: 'templates/ds/older' });
    const newer = template({ updatedAt: '2026-10-21T00:00:00.000Z', relPath: 'templates/graph/newer' });
    const tieB = template({ updatedAt: '2026-10-21T00:00:00.000Z', relPath: 'templates/b/b' });
    const tieA = template({ updatedAt: '2026-10-21T00:00:00.000Z', relPath: 'templates/a/a' });
    expect(defaultTemplateOf([older, newer, tieB, tieA])?.relPath).toBe('templates/a/a');
  });

  it('忽略非模板与归档模板；全空返回 null', () => {
    const archived = template({ effectiveArchived: true, updatedAt: '2026-10-22T00:00:00.000Z' });
    const problem = template({ kind: 'problem' as const, updatedAt: '2026-10-23T00:00:00.000Z' });
    expect(defaultTemplateOf([archived, problem])).toBeNull();
    expect(defaultTemplateOf([archived, template()])?.relPath).toBe('templates/ds/dsu');
  });
});

describe('record.json（VP 成绩存档）', () => {
  const record = (patch: Record<string, unknown> = {}) => ({
    schema: 1,
    arenaPath: 'official/icpc/icpc2025/icpc2025shanghai.srk.json',
    title: '上海站',
    savedAt: '2026-10-21T02:00:00.000Z',
    ghost: {
      show: true,
      subs: [
        { p: 1, t: 45, r: 'AC' },
        { p: 0, t: 20, r: 'WA' },
      ],
    },
    view: { mode: 'review', viewMs: 123000, paused: false, frozenView: true },
    ...patch,
  });

  it('合法 record：逐发按题序 / 时刻排序', () => {
    const parsed = parseWorkArenaRecord(record());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.ghost.subs.map((s) => [s.p, s.t])).toEqual([
      [0, 20],
      [1, 45],
    ]);
    expect(parsed.record.view.mode).toBe('review');
  });

  it('坏 schema / arenaPath / 判名 / view 全部拒绝', () => {
    expect(parseWorkArenaRecord(record({ schema: 2 })).ok).toBe(false);
    expect(parseWorkArenaRecord(record({ arenaPath: '../x.srk.json' })).ok).toBe(false);
    expect(parseWorkArenaRecord(record({ ghost: { show: true, subs: [{ p: 0, t: 1, r: 'FB' }] } })).ok).toBe(false);
    expect(parseWorkArenaRecord(record({ view: { mode: 'x', viewMs: 1, paused: false, frozenView: false } })).ok).toBe(false);
    expect(parseWorkArenaRecord(record({ view: { mode: 'live', viewMs: -1, paused: false, frozenView: false } })).ok).toBe(false);
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

  it('record / arenaPath / 旧子题 → 保持比赛；sourcePath → 题组；全无 → 待确认', () => {
    expect(workMigrateProposalOf(evidence({ hasRecord: true })).proposal).toBe('keep-contest');
    expect(workMigrateProposalOf(evidence({ hasArenaPath: true })).proposal).toBe('keep-contest');
    expect(workMigrateProposalOf(evidence({ hasChildProblem: true })).proposal).toBe('keep-contest');
    expect(workMigrateProposalOf(evidence({ hasSourcePath: true })).proposal).toBe('to-problemset');
    expect(workMigrateProposalOf(evidence()).proposal).toBe('ambiguous');
  });

  it('比赛证据优先于 sourcePath；规则文案能区分来源', () => {
    const withRecord = workMigrateProposalOf(evidence({ hasRecord: true, hasSourcePath: true }));
    expect(withRecord.proposal).toBe('keep-contest');
    expect(workMigrateProposalOf(evidence({ hasSourcePath: true })).rule).toContain('sourcePath');
    expect(workMigrateProposalOf(evidence()).rule).toContain('确认');
  });
});
