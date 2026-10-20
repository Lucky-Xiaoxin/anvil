import { describe, expect, it } from 'vitest';
import type { RatingPointDto } from '@anvil/shared';
import { axisIndexes, placeLine } from '../src/components/RatingChart.tsx';

const pt = (ts: string, newRating = 1500): RatingPointDto => ({ ts, newRating, contestName: 'x', delta: 0, isRated: true });

describe('折线横轴取点', () => {
  it('只打过 1 场的新号不越界（曾整页崩）', () => {
    expect(axisIndexes([pt('2026-09')])).toEqual([0]);
  });

  it('空数组给空', () => {
    expect(axisIndexes([])).toEqual([]);
  });

  it('下标一律落在范围内且递增', () => {
    for (const n of [2, 3, 4, 11, 30, 168]) {
      const series = Array.from({ length: n }, (_, i) => pt(`2026-${String((i % 12) + 1).padStart(2, '0')}`));
      const idx = axisIndexes(series);
      expect(idx.length, String(n)).toBeGreaterThan(0);
      expect(Math.max(...idx), String(n)).toBeLessThan(n);
      expect(Math.min(...idx), String(n)).toBe(0);
      expect([...idx].sort((a, b) => a - b), String(n)).toEqual(idx);
    }
  });

  it('同月相邻的场次不重复出标签', () => {
    const series = Array.from({ length: 11 }, (_, i) => pt(`2026-${String(Math.min(9, 7 + Math.floor(i / 4))).padStart(2, '0')}`));
    const idx = axisIndexes(series);
    const labels = idx.map((i) => series[i]!.ts);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('折线 tooltip 的名次行（AT 专有增量，docs/contracts/09 §4）', () => {
  it('有名次或 Perf 才出这一行', () => {
    expect(placeLine({ ...pt('2026-09'), place: 198, performance: 1377 })).toBe('第 198 名 · Perf 1377');
  });

  it('取不到的槽渲染 —，不填空', () => {
    expect(placeLine({ ...pt('2026-09'), place: null, performance: 1377 })).toBe('第 — 名 · Perf 1377');
    expect(placeLine({ ...pt('2026-09'), place: 59, performance: null })).toBe('第 59 名 · Perf —');
  });

  it('CF 两个槽都是 null → 整行不出现', () => {
    expect(placeLine(pt('2026-09'))).toBeUndefined();
  });
});
