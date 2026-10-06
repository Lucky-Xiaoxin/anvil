/**
 * 档案长卷的派生层（docs/14 §4 末段 / §5.3）：服务端只做完官方单口径的映射，
 * 最佳名次 / 跨度 / delta / 年份分组 / 百分位格式都留在这里，纯函数便于单测。
 */
import type { XcpcHistoryRow, XcpcMedals, XcpcMetal, XcpcPlayerDto, XcpcTier } from '@anvil/shared';
import { XCPC_METALS, XCPC_TIERS } from '@anvil/shared';

export const TIER_NAME: Record<XcpcTier, string> = {
  final: '决赛',
  regional: '区域赛',
  invitational: '邀请赛',
  provincial: '省赛',
};
export const METAL_NAME: Record<XcpcMetal, string> = { gold: '金', silver: '银', bronze: '铜' };

/** 单 tier 超过 12 枚就折：渲染前 12 枚 + 「+N」计数 chip（docs/14 §5.3） */
export const MEDAL_FOLD = 12;

/** 上游原文已是 +08:00，日期取前 10 位就是比赛那天（docs/14 §5.3） */
export const dayOf = (startAt: string): string => startAt.slice(0, 10);
export const monthOf = (startAt: string): string => startAt.slice(0, 7);
export const yearOf = (startAt: string): string => startAt.slice(0, 4);

/** 版本 = generatedAt 原串，展示取日期部分（docs/14 §2） */
export const snapshotDate = (generatedAt: string | null): string => (generatedAt === null ? '—' : generatedAt.slice(0, 10));

export function snapshotDaysAgo(generatedAt: string | null, now = Date.now()): number | null {
  if (generatedAt === null) return null;
  const ts = Date.parse(generatedAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((now - ts) / 86_400_000));
}

/** 百分位读数统一一位小数 */
export const pctText = (percent: number): string => `前 ${percent.toFixed(1)}%`;

/** 名衔那格是 R/T×100（docs/14 §5.3）；分母取不到就不给编一个 */
export function pctFrom(rank: number, teams: number | null): string | null {
  if (teams === null || teams <= 0) return null;
  return pctText((rank / teams) * 100);
}

/**
 * 逐场的百分位：上游 rankPercentOfficial 就是 R/T×100，缺了才用名次与队数现算，
 * 两头都取不到才给 null（界面显示 —，不拿 0% 冒充）。
 */
export function rowPct(row: XcpcHistoryRow): string | null {
  if (row.rankPercent !== null && Number.isFinite(row.rankPercent)) return pctText(row.rankPercent);
  if (row.rank !== null) return pctFrom(row.rank, row.teams);
  return null;
}

/**
 * 生涯跨度的读数：首末场 + 整天数 + 日历月数。
 * 只吃 YYYY-MM-DD，用 UTC 解析免得运行时区把日期挪一天。
 */
export function careerSpan(history: readonly XcpcHistoryRow[]): {
  from: string;
  to: string;
  days: number;
  months: number;
} | null {
  if (history.length === 0) return null;
  const first = dayOf(history[0]!.startAt);
  const last = dayOf(history[history.length - 1]!.startAt);
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const [ay, am] = first.split('-').map(Number) as [number, number];
  const [by, bm] = last.split('-').map(Number) as [number, number];
  return {
    from: first,
    to: last,
    days: Math.round((b - a) / 86_400_000),
    months: (by - ay) * 12 + (bm - am),
  };
}

/** 一枚勋章 = 一块奖牌：把聚合桶按计数拆开摆出来 */
export interface MedalDisc {
  metal: XcpcMetal;
  /** 该 tier 该金属的总枚数，tooltip 里给「金 ×2」这种读数 */
  ofSameMetal: number;
}

export interface MedalRow {
  tier: XcpcTier;
  name: string;
  total: number;
  /** 行权重按出现序递减：第 1 行常规、第 2 行 dim、第 3+ 行 dim2 */
  weight: string;
  discs: MedalDisc[];
  /** 折叠掉的枚数（>12 时才有） */
  hidden: number;
}

export function medalRows(medals: XcpcMedals): MedalRow[] {
  const rows: MedalRow[] = [];
  for (const tier of XCPC_TIERS) {
    const bucket = medals[tier];
    if (bucket === undefined) continue;
    const expanded: MedalDisc[] = [];
    let total = 0;
    for (const metal of XCPC_METALS) {
      const n = bucket[metal] ?? 0;
      if (n <= 0) continue;
      total += n;
      for (let k = 0; k < n; k++) expanded.push({ metal, ofSameMetal: n });
    }
    if (total === 0) continue;
    rows.push({
      tier,
      name: TIER_NAME[tier] ?? tier,
      total,
      weight: rows.length === 0 ? '' : rows.length === 1 ? ' vrow--dim' : ' vrow--dim2',
      discs: expanded.slice(0, MEDAL_FOLD),
      hidden: Math.max(0, total - MEDAL_FOLD),
    });
  }
  return rows;
}

export const medalTotal = (rows: readonly MedalRow[]): number => rows.reduce((sum, r) => sum + r.total, 0);

/** 连续同名场次为一段，换名开启新段（队名墙与 hover 读数都靠它） */
export interface TeamRun {
  name: string;
  rows: XcpcHistoryRow[];
  /** 段内非打星的最小官方榜名次；整段打星 → null */
  best: XcpcHistoryRow | null;
}

export function teamRuns(history: readonly XcpcHistoryRow[]): TeamRun[] {
  const runs: TeamRun[] = [];
  for (const row of history) {
    const last = runs[runs.length - 1];
    if (!last || last.name !== row.teamName) runs.push({ name: row.teamName, rows: [row], best: null });
    else last.rows.push(row);
  }
  for (const run of runs) {
    let min = Number.POSITIVE_INFINITY;
    for (const row of run.rows) {
      if (row.star || row.rank === null) continue;
      if (row.rank < min) {
        min = row.rank;
        run.best = row;
      }
    }
  }
  return runs;
}

/** 阶梯与编年共用的时间轴：x = 全场次序号（含打星位），delta 相对上一 rated 点 */
export interface TimelinePoint {
  /** history 里的下标，也是横轴的场次位置 */
  index: number;
  row: XcpcHistoryRow;
  /** 打星点没有 y（不入线） */
  rating: number | null;
  delta: number | null;
}

export interface Timeline {
  points: TimelinePoint[];
  rated: TimelinePoint[];
  starCount: number;
  /** 卡头读数「首 → 末 · ±总差」；一场 rated 都没有 → null */
  first: number | null;
  last: number | null;
  totalDelta: number | null;
}

export function timeline(history: readonly XcpcHistoryRow[]): Timeline {
  const points: TimelinePoint[] = [];
  let prev: number | null = null;
  history.forEach((row, index) => {
    const rating = row.star ? null : row.ratingAfter;
    const value = rating === null || !Number.isFinite(rating) ? null : rating;
    const delta = value === null || prev === null ? null : value - prev;
    if (value !== null) prev = value;
    points.push({ index, row, rating: value, delta });
  });
  const rated = points.filter((p) => p.rating !== null);
  const first = rated[0]?.rating ?? null;
  const last = rated[rated.length - 1]?.rating ?? null;
  return {
    points,
    rated,
    starCount: points.length - rated.length,
    first,
    last,
    totalDelta: first === null || last === null ? null : last - first,
  };
}

/** 涨蓝跌琥珀：delta 缺失（首点）按涨（docs/14 §5.3） */
export const isUp = (delta: number | null): boolean => delta === null || delta >= 0;

/** 编年按年分章、最新在上；某年一场 rated 都没有就不写年度首末分 */
export interface ChronicleChapter {
  year: string;
  /** 年内也是最新在上 */
  rows: { row: XcpcHistoryRow; point: TimelinePoint }[];
  count: number;
  ratedFrom: number | null;
  ratedTo: number | null;
}

export function chronicleChapters(player: XcpcPlayerDto): ChronicleChapter[] {
  const tl = timeline(player.history);
  const byYear = new Map<string, ChronicleChapter>();
  // 正序走一遍，章节按年份升序建好，年度首末分自然是最早 / 最晚 rated
  tl.points.forEach((point) => {
    const year = yearOf(point.row.startAt);
    let chapter = byYear.get(year);
    if (chapter === undefined) {
      chapter = { year, rows: [], count: 0, ratedFrom: null, ratedTo: null };
      byYear.set(year, chapter);
    }
    chapter.rows.push({ row: point.row, point });
    chapter.count++;
    if (point.rating !== null) {
      if (chapter.ratedFrom === null) chapter.ratedFrom = point.rating;
      chapter.ratedTo = point.rating;
    }
  });
  return [...byYear.values()]
    .reverse()
    .map((chapter) => ({ ...chapter, rows: chapter.rows.slice().reverse() }));
}

/**
 * 编年行的档位格（docs/14 §5.3）：网络预选赛上游归进 `regional`，但展示上不算区域赛 ——
 * 该格整格换成「网络赛」；`tier` 缺失给「—」；其余走四档徽章。
 */
export function chronBadge(row: XcpcHistoryRow): { tier: XcpcTier | null; text: string } {
  if (row.online) return { tier: null, text: '网络赛' };
  if (row.tier === null) return { tier: null, text: '—' };
  return { tier: row.tier, text: TIER_NAME[row.tier] };
}

/** 最佳名次：逐场官方榜名次最小值；一场都没有 → null → 界面 — */
export function bestRank(history: readonly XcpcHistoryRow[]): XcpcHistoryRow | null {
  let best: XcpcHistoryRow | null = null;
  let min = Number.POSITIVE_INFINITY;
  for (const row of history) {
    if (row.star || row.rank === null) continue;
    if (row.rank < min) {
      min = row.rank;
      best = row;
    }
  }
  return best;
}
