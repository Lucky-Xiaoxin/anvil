import { formatMonth } from './days.ts';
import type { RatingDto, RatingRow } from './types.ts';

/**
 * CF 段位：下限 / 官方英文段位名（API user.info 的 rank 字段那套：pupil、specialist…）/ 名字颜色。
 * 边界与颜色取自 CF 自己的渲染：gray→green→cyan→blue→violet→orange→red→legendary。
 */
const RANKS: readonly [number, string, string][] = [
  [3000, 'Legendary Grandmaster', '#FF0000'],
  [2600, 'International Grandmaster', '#FF0000'],
  [2400, 'Grandmaster', '#FF0000'],
  [2300, 'International Master', '#FF8C00'],
  [2100, 'Master', '#FF8C00'],
  [1900, 'Candidate Master', '#AA00AA'],
  [1600, 'Expert', '#0000FF'],
  [1400, 'Specialist', '#03A89E'],
  [1200, 'Pupil', '#008000'],
  [0, 'Newbie', '#808080'],
];

function rankOf(rating: number): [number, string, string] {
  return RANKS.find(([min]) => rating >= min) ?? RANKS[RANKS.length - 1]!;
}

export function rankLabelFor(rating: number): string {
  return rankOf(rating)[1];
}

/** 与 CF 名字同色；深色底上仍用 CF 原值，不自行提亮 */
export function rankColorFor(rating: number): string {
  return rankOf(rating)[2];
}

/** 长模式先替，否则 "Educational Codeforces Round" 会被先截成 "Educational CF" */
export function shortContestName(name: string): string {
  return name
    .replace('Educational Codeforces Round ', 'Edu ')
    .replace('Codeforces Round ', 'CF ')
    .replace("April Fools' Day Contest ", 'Fools ')
    .replace(' (Rated for Div. 2)', '');
}

export function signedDelta(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;
}

export function buildRating(rows: readonly RatingRow[]): RatingDto | null {
  const sorted = [...rows].sort((a, b) => a.updatedTs - b.updatedTs);
  if (sorted.length === 0) return null;

  const series = sorted.map((r, i) => ({
    ts: formatMonth(new Date(r.updatedTs * 1000)),
    newRating: r.newRating,
    contestName: r.contestName,
    delta: i === 0 ? 0 : r.newRating - sorted[i - 1]!.newRating,
  }));
  const last = series[series.length - 1]!;
  const first = series[0]!;
  const max = series.reduce((m, p) => Math.max(m, p.newRating), first.newRating);
  const totalTone = last.newRating - first.newRating;

  return {
    count: series.length,
    current: last.newRating,
    first: first.newRating,
    max,
    rankLabel: rankLabelFor(last.newRating),
    totalDelta: signedDelta(totalTone),
    totalDeltaTone: totalTone,
    lastDeltaText: signedDelta(last.delta),
    lastDeltaTone: last.delta,
    lastContestShort: shortContestName(last.contestName),
    lastContest: last.contestName,
    series,
  };
}
