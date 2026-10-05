import { dayOf, formatMonth } from './days.ts';
import type { RatingDto, RatingRow, SyncSourceId } from './types.ts';

/** 段位色按源分派；'xcpc' 无段位色名，不进这张表（docs/09 §9） */
export type RankSource = SyncSourceId;

/**
 * [档位下限, 段位色名, 站点原生色, 深底可用色]
 * 第四位只在原生值读不出来时提亮，同色相只提明度（docs/09 §7 定稿表）。
 */
const RANKS: Record<RankSource, readonly (readonly [number, string, string, string])[]> = {
  cf: [
    [3000, 'Legendary Grandmaster', '#FF0000', '#FF0000'],
    [2600, 'International Grandmaster', '#FF0000', '#FF0000'],
    [2400, 'Grandmaster', '#FF0000', '#FF0000'],
    [2300, 'International Master', '#FF8C00', '#FF8C00'],
    [2100, 'Master', '#FF8C00', '#FF8C00'],
    [1900, 'Candidate Master', '#AA00AA', '#D473D4'],
    [1600, 'Expert', '#0000FF', '#5B7BFF'],
    [1400, 'Specialist', '#03A89E', '#03A89E'],
    [1200, 'Pupil', '#008000', '#41D06B'],
    [0, 'Newbie', '#808080', '#808080'],
  ],
  // AT 只有颜色没有段位名：色名即段位名（docs/09 §5）
  at: [
    [2800, 'Red', '#FF0000', '#FF0000'],
    [2400, 'Orange', '#FF8000', '#FF8000'],
    [2000, 'Yellow', '#C0C000', '#C0C000'],
    [1600, 'Blue', '#0000FF', '#5B7BFF'],
    [1200, 'Cyan', '#00C0C0', '#00C0C0'],
    [800, 'Green', '#008000', '#41D06B'],
    [400, 'Brown', '#804000', '#C58A52'],
    [0, 'Gray', '#808080', '#808080'],
  ],
};

function rankOf(source: RankSource, rating: number): (readonly [number, string, string, string]) {
  const table = RANKS[source];
  return table.find(([min]) => rating >= min) ?? table[table.length - 1]!;
}

export function rankLabelFor(rating: number, source: RankSource = 'cf'): string {
  return rankOf(source, rating)[1];
}

/** 原生色留在表里备查，界面取的是深底可用值 —— 原生 #0000FF 在 #0A0C10 上约 1.6:1，13px 读不出来 */
export function rankColorFor(rating: number, source: RankSource = 'cf'): string {
  return rankOf(source, rating)[3];
}

/** 长模式先替，否则 "Educational Codeforces Round" 会被先截成 "Educational CF" */
export function shortContestName(name: string): string {
  return name
    .replace('Educational Codeforces Round ', 'Edu ')
    .replace('Codeforces Round ', 'CF ')
    .replace("April Fools' Day Contest ", 'Fools ')
    .replace(' (Rated for Div. 2)', '');
}

export function shortAtCoderName(name: string): string {
  return name
    .replace('AtCoder Beginner Contest ', 'ABC ')
    .replace('AtCoder Regular Contest ', 'ARC ')
    .replace('AtCoder Grand Contest ', 'AGC ');
}

export function signedDelta(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;
}

/** epoch 秒 → 上海日历月 "YYYY-MM" */
export function monthOfTs(epochSeconds: number): string {
  return formatMonth(dayOf(epochSeconds));
}

/**
 * 主曲线只收 `isRated` 的场次（docs/09 §2：非 rated 的 OldRating==NewRating、Performance=0，
 * 收进来会把平段画成噪声）；非 rated 场由调用方折算成「参赛 N 场」副行。
 * 传空表或全非 rated → null，界面按「取不到 → —」渲染。
 */
export function buildRating(rows: readonly RatingRow[], source: RankSource = 'cf'): RatingDto | null {
  const sorted = rows
    .filter((r) => r.isRated)
    .sort((a, b) => a.updatedTs - b.updatedTs || a.contestKey.localeCompare(b.contestKey));
  if (sorted.length === 0) return null;

  const series = sorted.map((r, i) => ({
    ts: monthOfTs(r.updatedTs),
    newRating: r.newRating,
    contestName: r.contestName,
    delta: i === 0 ? 0 : r.newRating - sorted[i - 1]!.newRating,
    isRated: true,
    // place / performance 是 AT 那侧的增量槽位（docs/09 §4）；CF 的 rank 不借这个口子，切片 1 的载荷形状原样不动
    place: source === 'at' ? r.rank : null,
    performance: source === 'at' ? r.performance : null,
  }));
  const last = series[series.length - 1]!;
  const first = series[0]!;
  const max = series.reduce((m, p) => Math.max(m, p.newRating), first.newRating);
  const totalTone = last.newRating - first.newRating;
  const shorten = source === 'at' ? shortAtCoderName : shortContestName;

  return {
    count: series.length,
    current: last.newRating,
    first: first.newRating,
    max,
    rankLabel: rankLabelFor(last.newRating, source),
    totalDelta: signedDelta(totalTone),
    totalDeltaTone: totalTone,
    lastDeltaText: signedDelta(last.delta),
    lastDeltaTone: last.delta,
    lastContestShort: shorten(last.contestName),
    lastContest: last.contestName,
    series,
    note: null,
  };
}
