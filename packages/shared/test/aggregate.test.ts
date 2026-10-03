import { describe, expect, it } from 'vitest';
import {
  aggregateDashboard,
  buildActivity,
  buildMonths,
  buildStreak,
  countDistinctProblems,
  formatDay,
  gridStartDate,
  levelOf,
  recentTicks,
  solvedPerDay,
  WEEKS,
  type AcEvent,
} from '@anvil/shared';

const D = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const ev = (day: string, problemKey = 'cf:1:A'): AcEvent => ({ day, problemKey });

describe('活跃格子 5 档分界', () => {
  it('0 / 1-2 / 3-5 / 6-9 / 10+', () => {
    expect(levelOf(0)).toBe(0);
    expect(levelOf(1)).toBe(1);
    expect(levelOf(2)).toBe(1);
    expect(levelOf(3)).toBe(2);
    expect(levelOf(5)).toBe(2);
    expect(levelOf(6)).toBe(3);
    expect(levelOf(9)).toBe(3);
    expect(levelOf(10)).toBe(4);
    expect(levelOf(99)).toBe(4);
  });
});

describe('活跃格子图窗口', () => {
  const today = D(2026, 10, 3);

  it('从 53 周前的周一起，一格一天', () => {
    expect(formatDay(gridStartDate(today, WEEKS))).toBe('2025-09-29');
    const cells = buildActivity([], today);
    expect(cells[0]!.day).toBe('2025-09-29');
    expect(cells[cells.length - 1]!.day).toBe('2026-10-03');
    expect(cells).toHaveLength(370);
  });

  it('未来日不出现：缺项 = 那天还没到', () => {
    const cells = buildActivity([ev('2026-10-09')], D(2026, 10, 5));
    expect(cells[cells.length - 1]!.day).toBe('2026-10-05');
    expect(cells.some((c) => c.day === '2026-10-09')).toBe(false);
  });

  it('同题同日多次只算一次', () => {
    const cells = buildActivity([ev('2026-10-02'), ev('2026-10-02'), ev('2026-10-02'), ev('2026-10-02', 'cf:1:B')], today);
    expect(cells.at(-2)!.solved).toBe(2);
  });
});

describe('去重与题次', () => {
  const today = D(2026, 10, 3);

  it('同题隔天再 AC：题次 +2、生涯去重 +1', () => {
    const events = [ev('2026-10-01'), ev('2026-10-02')];
    const { stats } = aggregateDashboard(events, today);
    expect(stats.activityTotal).toBe(2);
    expect(stats.totalSolved).toBe(1);
    expect(countDistinctProblems(events)).toBe(1);
  });

  it('solvedPerDay 只数独立题', () => {
    const m = solvedPerDay([ev('2026-10-01', 'cf:1:A'), ev('2026-10-01', 'cf:1:B'), ev('2026-10-01', 'cf:1:A')]);
    expect(m.get('2026-10-01')).toBe(2);
  });
});

describe('连续训练天数：诚实算法', () => {
  const today = D(2026, 10, 3);

  it('今天已开张：从今天倒推', () => {
    const s = buildStreak([ev('2026-10-01'), ev('2026-10-02'), ev('2026-10-03')], today);
    expect(s.days).toBe(3);
    expect(s.sub).toBe('已连续 3 天 · 今天已开张');
  });

  it('今天没开张：从昨天起算，文案明写', () => {
    const s = buildStreak([ev('2026-10-01'), ev('2026-10-02')], today);
    expect(s.days).toBe(2);
    expect(s.sub).toBe('今天还没开张 · 昨日 1 题');
  });

  it('昨天断：只剩今天', () => {
    expect(buildStreak([ev('2026-10-03')], today).days).toBe(1);
  });

  it('跨月不断档', () => {
    const s = buildStreak([ev('2026-09-29'), ev('2026-09-30'), ev('2026-10-01'), ev('2026-10-02')], today);
    expect(s.days).toBe(4);
  });

  it('完全没数据不吹 streak', () => {
    const s = buildStreak([], today);
    expect(s.days).toBe(0);
    expect(s.sub).toBe('今天还没开张');
  });
});

describe('月度分桶', () => {
  it('近 6 个月，末项 = 当月且 partial', () => {
    const events = [
      ev('2026-05-10', 'cf:1:A'),
      ev('2026-06-10', 'cf:1:B'),
      ev('2026-07-10', 'cf:1:C'),
      ev('2026-08-10', 'cf:1:D'),
      ev('2026-09-10', 'cf:1:E'),
      ev('2026-10-02', 'cf:1:F'),
    ];
    const months = buildMonths(events, D(2026, 10, 3));
    expect(months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(months.at(-1)!.partial).toBe(true);
    expect(months[0]!.partial).toBe(false);
  });

  it('跨年 12 → 1 月顺序正确', () => {
    const months = buildMonths([ev('2025-12-20'), ev('2026-01-05')], D(2026, 1, 15));
    expect(months.map((m) => m.month)).toEqual(['2025-12', '2026-01']);
    expect(months.at(-1)!.partial).toBe(true);
  });

  it('历史不足 6 个月就不补齐', () => {
    const months = buildMonths([ev('2026-10-02')], D(2026, 10, 3));
    expect(months).toHaveLength(1);
    expect(months[0]).toEqual({ month: '2026-10', solved: 1, partial: true });
  });

  it('同题跨月各算一次，月内去重', () => {
    const months = buildMonths([ev('2026-09-10', 'cf:1:A'), ev('2026-09-20', 'cf:1:A'), ev('2026-10-01', 'cf:1:A')], D(2026, 10, 3));
    expect(months.map((m) => m.solved)).toEqual([1, 1]);
  });

  it('没有任何 AC 时返回空数组', () => {
    expect(buildMonths([], D(2026, 10, 3))).toEqual([]);
  });
});

describe('同源派生读数', () => {
  const today = D(2026, 10, 3);

  it('最长连续 + 区间', () => {
    const events = [ev('2026-09-21'), ev('2026-09-22', 'cf:1:B'), ev('2026-09-23', 'cf:1:C')];
    const { stats } = aggregateDashboard(events, today);
    expect(stats.longestRun.days).toBe('3 天');
    expect(stats.longestRun.range).toBe('09-21 → 09-23');
  });

  it('断档 ≥3 天：只数训练之间的空档与收尾空档', () => {
    const events = [ev('2026-09-20'), ev('2026-09-25', 'cf:1:B')];
    const { stats } = aggregateDashboard(events, today);
    expect(stats.gaps3).toBe('2 次');
  });

  it('周末占比按题次算；没有题次时给 —', () => {
    // 2026-10-03 是周六
    const onlySat = aggregateDashboard([ev('2026-10-03'), ev('2026-10-03', 'cf:1:B')], today);
    expect(onlySat.stats.weekendPct).toBe('100%');
    expect(aggregateDashboard([], today).stats.weekendPct).toBeNull();
  });

  it('空档 / 空格子读数成形', () => {
    const { stats } = aggregateDashboard([ev('2026-10-03')], today);
    expect(stats.emptyCells).toBe('369 天空格');
  });
});

describe('近 14 日刻度', () => {
  it('只取最后 14 天并转档', () => {
    const today = D(2026, 10, 3);
    const cells = buildActivity(
      [
        ev('2026-10-03'),
        ev('2026-10-03', 'cf:1:B'),
        ev('2026-10-03', 'cf:1:C'),
        ev('2026-10-02', 'cf:1:D'),
      ],
      today,
    );
    const ticks = recentTicks(cells);
    expect(ticks).toHaveLength(14);
    expect(ticks.at(-1)).toBe(2);
    expect(ticks.at(-2)).toBe(1);
    expect(ticks[0]).toBe(0);
  });
});
