import { formatMonth } from './days.ts';
import type { RatingDto, RatingRow } from './types.ts';

const RANKS: readonly [number, string][] = [
  [2600, 'Legendary Grandmaster'],
  [2400, 'International Grandmaster'],
  [2300, 'Grandmaster'],
  [2100, 'International Master'],
  [1900, 'Master'],
  [1600, 'Candidate Master'],
  [1400, 'Expert'],
  [1200, 'Specialist'],
  [0, 'Newbie'],
];

export function rankLabelFor(rating: number): string {
  for (const [min, label] of RANKS) if (rating >= min) return label;
  return 'Newbie';
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
