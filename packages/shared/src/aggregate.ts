import { addDays, addMonths, civilDay, dowMon, formatDay, formatMonth, gridStartDate, monthOfDay, parseDayKey, WEEKS } from './days.ts';
import type { AcEvent, ActivityCellDto, LongestRunDto, MonthBucketDto, StatsDto, StreakDto } from './types.ts';

/** 5 档：0 / 1-2 / 3-5 / 6-9 / 10+ */
export function levelOf(solved: number): number {
  if (solved <= 0) return 0;
  if (solved <= 2) return 1;
  if (solved <= 5) return 2;
  if (solved <= 9) return 3;
  return 4;
}

/** 同题同日多次只算一次 → day -> 当日独立过题数 */
export function solvedPerDay(events: readonly AcEvent[]): Map<string, number> {
  const byDay = new Map<string, Set<string>>();
  for (const e of events) {
    let set = byDay.get(e.day);
    if (!set) {
      set = new Set();
      byDay.set(e.day, set);
    }
    set.add(e.problemKey);
  }
  const counts = new Map<string, number>();
  for (const [day, set] of byDay) counts.set(day, set.size);
  return counts;
}

export function countDistinctProblems(events: readonly AcEvent[]): number {
  return new Set(events.map((e) => e.problemKey)).size;
}

/** 53 周 × 7 天窗口内、今天及以前的每一格；未来日不出现（缺项 = 那天还没到）。`today` 传真实时刻 */
export function buildActivity(events: readonly AcEvent[], today: Date, weeks = WEEKS): ActivityCellDto[] {
  const counts = solvedPerDay(events);
  const day = civilDay(today);
  const start = gridStartDate(day, weeks);
  const cells: ActivityCellDto[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    if (d.getTime() > day.getTime()) break;
    cells.push({ day: formatDay(d), solved: counts.get(formatDay(d)) ?? 0 });
  }
  return cells;
}

export function buildStreak(events: readonly AcEvent[], today: Date): StreakDto {
  const counts = solvedPerDay(events);
  const day = civilDay(today);
  const todayKey = formatDay(day);
  const todaySolved = counts.get(todayKey) ?? 0;
  const cursor = todaySolved > 0 ? day : addDays(day, -1);

  let days = 0;
  let at = cursor;
  while ((counts.get(formatDay(at)) ?? 0) > 0) {
    days++;
    at = addDays(at, -1);
  }

  let sub: string;
  if (todaySolved > 0) sub = `已连续 ${days} 天 · 今天已开张`;
  else if (days > 0) sub = `今天还没开张 · 昨日 ${counts.get(formatDay(addDays(day, -1))) ?? 0} 题`;
  else sub = '今天还没开张';

  return { days, sub };
}

/** 近 6 个上海日历月；历史不足就不补齐 */
export function buildMonths(events: readonly AcEvent[], today: Date): MonthBucketDto[] {
  if (events.length === 0) return [];
  const byMonth = new Map<string, Set<string>>();
  let earliest = '';
  for (const e of events) {
    const m = monthOfDay(e.day);
    if (earliest === '' || m < earliest) earliest = m;
    let set = byMonth.get(m);
    if (!set) {
      set = new Set();
      byMonth.set(m, set);
    }
    set.add(e.problemKey);
  }

  const day = civilDay(today);
  const currentMonth = formatDay(day).slice(0, 7);
  const months: MonthBucketDto[] = [];
  for (let back = 5; back >= 0; back--) {
    const key = formatMonth(addMonths(day, -back));
    if (key < earliest) continue;
    months.push({ month: key, solved: byMonth.get(key)?.size ?? 0, partial: key === currentMonth });
  }
  return months;
}

export function buildStats(events: readonly AcEvent[], cells: readonly ActivityCellDto[], today: Date): StatsDto {
  const activityTotal = cells.reduce((s, c) => s + c.solved, 0);
  const weekend = cells.reduce((s, c) => (dowMon(parseDayKey(c.day)) >= 5 ? s + c.solved : s), 0);

  let best = 0;
  let cur = 0;
  let bestEnd = 0;
  let gaps = 0;
  let gap = 0;
  let seenAny = false;
  cells.forEach((c, i) => {
    if (c.solved > 0) {
      seenAny = true;
      cur++;
      if (cur > best) {
        best = cur;
        bestEnd = i;
      }
      if (gap >= 3) gaps++;
      gap = 0;
    } else {
      if (seenAny) gap++;
      cur = 0;
    }
  });
  if (gap >= 3) gaps++;

  let longestRun: LongestRunDto;
  if (best === 0) {
    longestRun = { days: '0 天', range: '—' };
  } else {
    // 窗口跨年，只留 MM-DD 会把 2025-10 读成"这个 10 月"
    const from = cells[bestEnd - best + 1]!.day.slice(2);
    const to = cells[bestEnd]!.day.slice(2);
    longestRun = { days: `${best} 天`, range: `${from} → ${to}` };
  }

  const emptyDays = cells.reduce((s, c) => (c.solved === 0 ? s + 1 : s), 0);

  return {
    totalSolved: countDistinctProblems(events),
    activityTotal,
    months: buildMonths(events, today),
    streak: buildStreak(events, today),
    longestRun,
    gaps3: `${gaps} 次`,
    weekendPct: activityTotal === 0 ? null : `${Math.round((weekend / activityTotal) * 100)}%`,
    emptyCells: `${emptyDays} 天空格`,
  };
}

export interface DashboardAggregates {
  activity: ActivityCellDto[];
  stats: StatsDto;
}

export function aggregateDashboard(events: readonly AcEvent[], today = new Date(), weeks = WEEKS): DashboardAggregates {
  const cells = buildActivity(events, today, weeks);
  return { activity: cells, stats: buildStats(events, cells, today) };
}

/** 连续天数卡下方的近 14 日刻度 */
export function recentTicks(cells: readonly ActivityCellDto[], n = 14): number[] {
  return cells.slice(-n).map((c) => levelOf(c.solved));
}
