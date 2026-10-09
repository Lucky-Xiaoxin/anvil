/**
 * 目录派生（docs/16 §5.1）：把服务端给的 `{name, path, children, count}` 树折成界面用的行。
 *
 * tier 徽章与日期都是从**实测命名**里推出来的（2026-10-09 抽样）：
 * 叶子名 = `YYYY-MM-DD 站名/届数`，分组名 = `ICPC 2025 (50th)` / `北京市赛` / `Universal Cup`。
 * 认不出的不硬套一档 —— 与 XCPC 那边「没见过的值给 null」同一口径。
 */
import type { ArenaCatalogNode } from '@anvil/shared';

/** 稿内四款具名徽章 + 一款中性档（中性档自带文案：网络赛 / 校赛 / 统一赛 / 半决赛 / 女生赛…） */
export type Tier = 'final' | 'regional' | 'invitational' | 'provincial' | 'other';

export interface TierBadge {
  tier: Tier;
  /** 徽章文字：四款具名档用固定词，other 用这个字段 */
  label: string;
}

export interface LeafRow {
  /** 官方路径 = `/api/arena/contest?path=` 的入参 */
  path: string;
  /** 日期（`YYYY-MM-DD`），名称里没有日期则空串 */
  date: string;
  /** 去掉日期前缀后的名称 */
  name: string;
  /** 分组链（类目 → … → 年份 / 省），搜索与搜索结果的路径后缀用 */
  group: string[];
  badge: TierBadge;
}

export interface GroupNode {
  name: string;
  count: number;
  /** 展开态由界面管，这里只给结构 */
  kids: GroupNode[];
  leaves: LeafRow[];
}

const TIER_CN: Record<Exclude<Tier, 'other'>, string> = {
  final: '决赛',
  regional: '区域赛',
  invitational: '邀请赛',
  provincial: '省赛',
};

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\s+/;

/**
 * tier 判据：先看名称与路径段里的关键词，再退到类目本身。
 * 半决赛要在 finals 之前判 —— `ucup3rdsemifinals` 里就含 `final`。
 */
export function tierOf(hay: string, category: string): TierBadge {
  const s = hay.toLowerCase();
  if (/半决赛|semifinal/.test(s)) return { tier: 'other', label: '半决赛' };
  if (/邀请赛|invitational/.test(s)) return { tier: 'invitational', label: TIER_CN.invitational };
  if (/网络赛|online|preliminary/.test(s)) return { tier: 'other', label: '网络赛' };
  if (/女生|wom(en)?en|girls?/.test(s)) return { tier: 'other', label: '女生赛' };
  if (/总决赛|决赛|finals?\b/.test(s)) return { tier: 'final', label: TIER_CN.final };
  if (/省赛|provincial/.test(s) || category === '省赛') return { tier: 'provincial', label: TIER_CN.provincial };
  if (/校赛|校内|university-level/.test(s) || category === '校赛') return { tier: 'other', label: '校赛' };
  if (/ucup|universal cup/.test(s) || category === 'Universal Cup') return { tier: 'other', label: '统一赛' };
  if (/区域赛|regional/.test(s) || category === 'ICPC' || category === 'CCPC') {
    return { tier: 'regional', label: TIER_CN.regional };
  }
  return { tier: 'other', label: category === '' ? '其他' : category };
}

/** 叶子行：日期从名称里剥，剥不动就留空（不猜日期） */
export function leafRowOf(node: ArenaCatalogNode, group: string[]): LeafRow {
  const raw = node.name ?? '';
  const m = DATE_RE.exec(raw);
  const date = m?.[1] ?? '';
  const rest = m !== null ? raw.slice(m[0].length).trim() : raw.trim();
  const category = group[0] ?? '';
  const path = node.path ?? '';
  const seg = path.split('/').pop() ?? '';
  return {
    path,
    date,
    name: rest === '' ? seg.replace(/\.srk\.json$/, '') : rest,
    group,
    badge: tierOf(`${raw} ${seg}`, category),
  };
}

const isLeaf = (n: ArenaCatalogNode): boolean => n.path !== undefined;

/** 摊平所有叶子（搜索与计数用） */
export function flattenLeaves(tree: ArenaCatalogNode[]): LeafRow[] {
  const out: LeafRow[] = [];
  const walk = (nodes: ArenaCatalogNode[], chain: string[]): void => {
    for (const n of nodes) {
      if (isLeaf(n)) out.push(leafRowOf(n, chain));
      else walk(n.children ?? [], [...chain, n.name]);
    }
  };
  walk(tree, []);
  return out;
}

/** 渲染用的分组结构：叶子与子分组各自成列，计数照服务端给的 count */
export function toGroupNode(node: ArenaCatalogNode, chain: string[]): GroupNode {
  const kids = (node.children ?? []).filter((c) => !isLeaf(c)).map((c) => toGroupNode(c, [...chain, node.name]));
  const leaves = (node.children ?? []).filter(isLeaf).map((c) => leafRowOf(c, [...chain, node.name]));
  return { name: node.name, count: node.count ?? leaves.length + kids.reduce((s, k) => s + k.count, 0), kids, leaves };
}

/**
 * 搜索：赛事名 + 日期 + 分组链一起命中（契约 §5.1「按赛事名过滤，含年份 / 城市」）。
 * 大小写不敏感；空串不在此处理（界面走树视图）。
 */
export function searchLeaves(rows: LeafRow[], q: string): LeafRow[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [];
  return rows.filter((r) => `${r.name} ${r.date} ${r.group.join(' ')}`.toLowerCase().includes(needle));
}

/** 目录头一行与计数（诚实标注，§2.3 一处不改） */
export const catalogHeadline = (total: number): string => `目录 ${total} 场 · 榜单来自官方快照`;
