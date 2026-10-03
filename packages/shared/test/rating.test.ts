import { describe, expect, it } from 'vitest';
import { buildRating, localDayKey, rankLabelFor, shortContestName, signedDelta, type RatingRow } from '@anvil/shared';

const at = (y: number, m: number, d: number) => Math.floor(new Date(y, m - 1, d, 12).getTime() / 1000);
const row = (contestId: number, name: string, newRating: number, ts: number): RatingRow => ({
  contestId,
  contestName: name,
  rank: 10,
  oldRating: 0,
  newRating,
  updatedTs: ts,
});

describe('rating 段位名（CF 原始英文，不做中译）', () => {
  it('按 CF 真实门槛', () => {
    expect(rankLabelFor(899)).toBe('Newbie');
    expect(rankLabelFor(1200)).toBe('Specialist');
    expect(rankLabelFor(1399)).toBe('Specialist');
    expect(rankLabelFor(1400)).toBe('Expert');
    expect(rankLabelFor(1683)).toBe('Candidate Master');
    expect(rankLabelFor(1900)).toBe('Master');
    expect(rankLabelFor(2100)).toBe('International Master');
    expect(rankLabelFor(2350)).toBe('Grandmaster');
    expect(rankLabelFor(2400)).toBe('International Grandmaster');
    expect(rankLabelFor(3000)).toBe('Legendary Grandmaster');
  });
});

describe('卡面短名', () => {
  it('长模式先替', () => {
    expect(shortContestName('Educational Codeforces Round 209 (Rated for Div. 2)')).toBe('Edu 209');
    expect(shortContestName('Codeforces Round 1081 (Div. 2)')).toBe('CF 1081 (Div. 2)');
    expect(shortContestName("April Fools' Day Contest 2026")).toBe('Fools 2026');
    expect(shortContestName('Hello 2026 (Div. 1 + Div. 2)')).toBe('Hello 2026 (Div. 1 + Div. 2)');
  });

  it('正负号给串、数值给 tone', () => {
    expect(signedDelta(28)).toBe('+28');
    expect(signedDelta(-19)).toBe('−19');
    expect(signedDelta(0)).toBe('±0');
  });
});

describe('rating 折线数据', () => {
  it('没有场次时给 null，界面渲染 —', () => {
    expect(buildRating([])).toBeNull();
  });

  it('乱序输入也按时间排；ts 为本地月', () => {
    const r = buildRating([row(2270, 'CF 1100 (Div. 2)', 1372, at(2026, 9, 20)), row(2260, 'CF 1081 (Div. 2)', 1438, at(2026, 8, 1))]);
    expect(r!.series.map((p) => p.ts)).toEqual(['2026-08', '2026-09']);
    expect(r!.first).toBe(1438);
    expect(r!.current).toBe(1372);
    expect(r!.count).toBe(2);
    expect(r!.totalDelta).toBe('−66');
    expect(r!.totalDeltaTone).toBe(-66);
    expect(r!.lastDeltaText).toBe('−66');
    expect(r!.lastDeltaTone).toBe(-66);
    expect(r!.rankLabel).toBe('Specialist');
    expect(r!.lastContestShort).toBe('CF 1100 (Div. 2)');
    expect(r!.lastContest).toBe('CF 1100 (Div. 2)');
  });

  it('max 取全程峰值，首场 delta 记 0', () => {
    const r = buildRating([
      row(1, 'A', 1400, at(2026, 1, 1)),
      row(2, 'B', 1731, at(2026, 2, 1)),
      row(3, 'C', 1683, at(2026, 3, 1)),
    ]);
    expect(r!.max).toBe(1731);
    expect(r!.series[0]!.delta).toBe(0);
    expect(r!.series[1]!.delta).toBe(331);
    expect(r!.series[2]!.delta).toBe(-48);
    expect(r!.lastDeltaText).toBe('−48');
  });
});

describe('epoch → 本地日', () => {
  it('正午时刻不受时区影响', () => {
    expect(localDayKey(at(2026, 10, 3))).toBe('2026-10-03');
  });
});
