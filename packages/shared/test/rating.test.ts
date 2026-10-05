import { describe, expect, it } from 'vitest';
import {
  buildRating,
  dayKeyOf,
  rankColorFor,
  rankLabelFor,
  shortAtCoderName,
  shortContestName,
  signedDelta,
  type RatingRow,
} from '@anvil/shared';

/** 上海日历的正午（04:00Z）：夹具不带运行机时区的痕迹 */
const at = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d, 4) / 1000);
const row = (
  contestKey: string,
  name: string,
  newRating: number,
  ts: number,
  over: Partial<RatingRow> = {},
): RatingRow => ({
  contestKey,
  contestName: name,
  rank: 10,
  oldRating: 0,
  newRating,
  isRated: true,
  performance: null,
  updatedTs: ts,
  ...over,
});

describe('CF 段位：名与边界一律不动（docs/09 §7）', () => {
  it('边界 1200 / 1400 / 1600 / 1900 / 2100 / 2300 / 2400 / 2600 / 3000', () => {
    expect(rankLabelFor(899)).toBe('Newbie');
    expect(rankLabelFor(1199)).toBe('Newbie');
    expect(rankLabelFor(1200)).toBe('Pupil');
    expect(rankLabelFor(1278)).toBe('Pupil');
    expect(rankLabelFor(1399)).toBe('Pupil');
    expect(rankLabelFor(1400)).toBe('Specialist');
    expect(rankLabelFor(1599)).toBe('Specialist');
    expect(rankLabelFor(1600)).toBe('Expert');
    expect(rankLabelFor(1683)).toBe('Expert');
    expect(rankLabelFor(1899)).toBe('Expert');
    expect(rankLabelFor(1900)).toBe('Candidate Master');
    expect(rankLabelFor(2099)).toBe('Candidate Master');
    expect(rankLabelFor(2100)).toBe('Master');
    expect(rankLabelFor(2299)).toBe('Master');
    expect(rankLabelFor(2300)).toBe('International Master');
    expect(rankLabelFor(2399)).toBe('International Master');
    expect(rankLabelFor(2400)).toBe('Grandmaster');
    expect(rankLabelFor(2599)).toBe('Grandmaster');
    expect(rankLabelFor(2600)).toBe('International Grandmaster');
    expect(rankLabelFor(2999)).toBe('International Grandmaster');
    expect(rankLabelFor(3000)).toBe('Legendary Grandmaster');
  });

  it('深底走同色相提亮表：只有 Pupil / Expert / Candidate Master 三档换值', () => {
    expect(rankColorFor(1199)).toBe('#808080'); // Newbie 原生直用
    expect(rankColorFor(1278)).toBe('#41D06B'); // Pupil 008000 → 41D06B
    expect(rankColorFor(1400)).toBe('#03A89E'); // Specialist 原生直用
    expect(rankColorFor(1683)).toBe('#5B7BFF'); // Expert 0000FF → 5B7BFF
    expect(rankColorFor(1900)).toBe('#D473D4'); // Candidate Master AA00AA → D473D4
    expect(rankColorFor(2100)).toBe('#FF8C00'); // Master 原生直用
    expect(rankColorFor(2300)).toBe('#FF8C00');
    expect(rankColorFor(2400)).toBe('#FF0000'); // GM 原生直用
    expect(rankColorFor(3676)).toBe('#FF0000');
  });
});

describe('AT 段位：只有颜色没有段位名，色名即段位名（docs/09 §5）', () => {
  it('边界 400 / 800 / 1200 / 1600 / 2000 / 2400 / 2800', () => {
    expect(rankLabelFor(1, 'at')).toBe('Gray');
    expect(rankLabelFor(399, 'at')).toBe('Gray');
    expect(rankLabelFor(400, 'at')).toBe('Brown');
    expect(rankLabelFor(799, 'at')).toBe('Brown');
    expect(rankLabelFor(800, 'at')).toBe('Green');
    expect(rankLabelFor(1199, 'at')).toBe('Green');
    expect(rankLabelFor(1200, 'at')).toBe('Cyan');
    expect(rankLabelFor(1599, 'at')).toBe('Cyan');
    expect(rankLabelFor(1600, 'at')).toBe('Blue');
    expect(rankLabelFor(1999, 'at')).toBe('Blue');
    expect(rankLabelFor(2000, 'at')).toBe('Yellow');
    expect(rankLabelFor(2399, 'at')).toBe('Yellow');
    expect(rankLabelFor(2400, 'at')).toBe('Orange');
    expect(rankLabelFor(2799, 'at')).toBe('Orange');
    expect(rankLabelFor(2800, 'at')).toBe('Red');
  });

  it('深底提亮只有 Brown / Green / Blue 三档，其余 5 档原生直用', () => {
    expect(rankColorFor(372, 'at')).toBe('#808080');
    expect(rankColorFor(500, 'at')).toBe('#C58A52'); // 804000 → C58A52
    expect(rankColorFor(900, 'at')).toBe('#41D06B'); // 008000 → 41D06B
    expect(rankColorFor(1345, 'at')).toBe('#00C0C0'); // Cyan 原生即够亮
    expect(rankColorFor(1700, 'at')).toBe('#5B7BFF'); // 0000FF → 5B7BFF
    expect(rankColorFor(2100, 'at')).toBe('#C0C000');
    expect(rankColorFor(2600, 'at')).toBe('#FF8000');
    expect(rankColorFor(2958, 'at')).toBe('#FF0000');
  });

  it('两源的段位表互不串台：同一个分数两套读法', () => {
    expect(rankLabelFor(1345)).toBe('Pupil');
    expect(rankLabelFor(1345, 'at')).toBe('Cyan');
    expect(rankColorFor(1345)).toBe('#41D06B');
    expect(rankColorFor(1345, 'at')).toBe('#00C0C0');
  });
});

describe('卡面短名', () => {
  it('CF 长模式先替', () => {
    expect(shortContestName('Educational Codeforces Round 209 (Rated for Div. 2)')).toBe('Edu 209');
    expect(shortContestName('Codeforces Round 1081 (Div. 2)')).toBe('CF 1081 (Div. 2)');
    expect(shortContestName("April Fools' Day Contest 2026")).toBe('Fools 2026');
    expect(shortContestName('Hello 2026 (Div. 1 + Div. 2)')).toBe('Hello 2026 (Div. 1 + Div. 2)');
  });

  it('AT 三件套展开成 ABC / ARC / AGC', () => {
    expect(shortAtCoderName('AtCoder Beginner Contest 300')).toBe('ABC 300');
    expect(shortAtCoderName('AtCoder Regular Contest 178')).toBe('ARC 178');
    expect(shortAtCoderName('AtCoder Grand Contest 068')).toBe('AGC 068');
    expect(shortAtCoderName('code-festival-2015-final')).toBe('code-festival-2015-final');
  });

  it('AT 冠名场从整名里提出标准赛号（真实数据）', () => {
    expect(
      shortAtCoderName('AtCoder Talent Quest 〜 今から28卒には脱出してもらいます〜予選（AtCoder Beginner Contest 472）'),
    ).toBe('ABC 472');
    expect(shortAtCoderName('Toyota Programming Contest 2024#1（AtCoder Beginner Contest 337）')).toBe('ABC 337');
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

  it('乱序输入也按时间排；ts 为上海月', () => {
    const r = buildRating([
      row('2270', 'CF 1100 (Div. 2)', 1372, at(2026, 9, 20)),
      row('2260', 'CF 1081 (Div. 2)', 1438, at(2026, 8, 1)),
    ]);
    expect(r!.series.map((p) => p.ts)).toEqual(['2026-08', '2026-09']);
    expect(r!.first).toBe(1438);
    expect(r!.current).toBe(1372);
    expect(r!.count).toBe(2);
    expect(r!.totalDelta).toBe('−66');
    expect(r!.totalDeltaTone).toBe(-66);
    expect(r!.lastDeltaText).toBe('−66');
    expect(r!.rankLabel).toBe('Pupil');
    expect(r!.lastContestShort).toBe('CF 1100 (Div. 2)');
    expect(r!.lastContest).toBe('CF 1100 (Div. 2)');
  });

  it('max 取全程峰值，首场 delta 记 0', () => {
    const r = buildRating([
      row('1', 'A', 1400, at(2026, 1, 1)),
      row('2', 'B', 1731, at(2026, 2, 1)),
      row('3', 'C', 1683, at(2026, 3, 1)),
    ]);
    expect(r!.max).toBe(1731);
    expect(r!.series[0]!.delta).toBe(0);
    expect(r!.series[1]!.delta).toBe(331);
    expect(r!.series[2]!.delta).toBe(-48);
    expect(r!.lastDeltaText).toBe('−48');
  });

  it('主曲线只收 isRated 的场：非 rated 场不进线（docs/09 §2）', () => {
    const r = buildRating(
      [
        row('abc300', 'AtCoder Beginner Contest 300', 1200, at(2023, 4, 1)),
        row('abc301', 'AtCoder Beginner Contest 301', 1250, at(2023, 4, 8), { isRated: false, rank: 16 }),
        row('abc302', 'AtCoder Beginner Contest 302', 1300, at(2023, 4, 15)),
      ],
      'at',
    );
    expect(r!.count).toBe(2);
    expect(r!.series.map((p) => p.contestName)).toEqual([
      'AtCoder Beginner Contest 300',
      'AtCoder Beginner Contest 302',
    ]);
    expect(r!.rankLabel).toBe('Cyan');
    expect(r!.lastContestShort).toBe('ABC 302');
    expect(r!.note).toBeNull(); // 诚实标注由服务端拼，不在纯函数里
  });

  it('全库只有非 rated 场 → null，不画一条假曲线', () => {
    expect(buildRating([row('abc300', 'ABC 300', 0, at(2023, 4, 1), { isRated: false })], 'at')).toBeNull();
  });

  it('tooltip 槽位随点带上 place / performance / isRated', () => {
    const r = buildRating([row('agc060', 'AGC 060', 1362, at(2024, 4, 27), { rank: 198, performance: 1377 })], 'at');
    expect(r!.series[0]).toMatchObject({ place: 198, performance: 1377, isRated: true });
  });

  it('place / performance 只在 AT 侧出：CF 有 rank 也不借这个口子（切片 1 载荷形状不动）', () => {
    const cf = buildRating([row('2268', 'CF 1100', 1438, at(2026, 9, 20), { rank: 5 })]);
    expect(cf!.series[0]).toMatchObject({ place: null, performance: null });
    const atRating = buildRating([row('abc300', 'ABC 300', 1438, at(2026, 9, 20), { rank: 5, performance: 1377 })], 'at');
    expect(atRating!.series[0]).toMatchObject({ place: 5, performance: 1377 });
  });

  it('ts 走上海月：日界线附近的场次归对月', () => {
    const ts = Date.UTC(2026, 8, 30, 17) / 1000;
    expect(dayKeyOf(ts)).toBe('2026-10-01');
    expect(buildRating([row('1', 'A', 1400, ts)])!.series[0]!.ts).toBe('2026-10');
  });
});
