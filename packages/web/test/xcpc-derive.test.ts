/**
 * 长卷派生层单测（docs/14 §4 末段 / §5.3 / §7）：服务端只做完官方单口径，
 * 这里测的是前端那套「最佳名次 / 跨度 / delta / 年份分组 / 百分位 / 勋章折叠」。
 */
import { describe, expect, it } from 'vitest';
import type { XcpcHistoryRow, XcpcMedals, XcpcPlayerDto } from '@anvil/shared';
import {
  bestRank,
  careerSpan,
  chronBadge,
  chronicleChapters,
  isUp,
  medalRows,
  medalTotal,
  pctFrom,
  rowPct,
  snapshotDate,
  snapshotDaysAgo,
  teamRuns,
  timeline,
} from '../src/components/xcpc/derive.ts';

const DAY = 86_400_000;

function row(over: Partial<XcpcHistoryRow> = {}): XcpcHistoryRow {
  return {
    contestId: 'c1',
    title: '某赛',
    startAt: '2024-05-18T09:00:00+08:00',
    teamName: '三把火',
    tier: 'provincial',
    online: false,
    solved: 3,
    star: false,
    rank: 92,
    teams: 310,
    rankPercent: 29.67741935483871,
    perf: 1601.2,
    ratingAfter: 1544.6,
    dirt: 0.67,
    firstATime: 31.2,
    lastHourSolved: 0,
    ...over,
  };
}

const player = (history: XcpcHistoryRow[], medals: XcpcMedals = {}): XcpcPlayerDto => ({
  key: '某人@某校',
  name: '某人',
  org: '某校',
  contests: history.length,
  officialRating: 1544.6,
  officialRank: 9123,
  medals,
  history,
});

describe('荣誉陈列（docs/14 §5.3）', () => {
  it('一枚 = 一块奖牌：聚合桶按计数拆开，金属按金→银→铜排', () => {
    const rows = medalRows({ provincial: { gold: 2, bronze: 1, silver: 0 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discs.map((d) => d.metal)).toEqual(['gold', 'gold', 'bronze']);
    expect(rows[0]!.total).toBe(3);
    expect(rows[0]!.hidden).toBe(0);
  });

  it('行序 final→regional→invitational→provincial，零奖牌 tier 整行省略', () => {
    const rows = medalRows({ invitational: { silver: 1 }, provincial: { gold: 0 }, final: { gold: 1 }, regional: { bronze: 2 } });
    expect(rows.map((r) => r.tier)).toEqual(['final', 'regional', 'invitational']);
  });

  it('行权重按出现序递减：常规 / dim / dim2', () => {
    const rows = medalRows({ final: { gold: 1 }, regional: { gold: 1 }, invitational: { gold: 1 }, provincial: { gold: 1 } });
    expect(rows.map((r) => r.weight)).toEqual(['', ' vrow--dim', ' vrow--dim2', ' vrow--dim2']);
  });

  it('单 tier 超 12 枚只列前 12 枚，剩下的报数（14 → 12 + 2）', () => {
    const rows = medalRows({ provincial: { gold: 14 } });
    expect(rows[0]!.discs).toHaveLength(12);
    expect(rows[0]!.hidden).toBe(2);
    expect(rows[0]!.total).toBe(14);
    // 正好 12 枚不折
    const exact = medalRows({ provincial: { gold: 12 } });
    expect(exact[0]!.discs).toHaveLength(12);
    expect(exact[0]!.hidden).toBe(0);
  });

  it('medalTotal 给「共 N 枚」用，算的是全量而不是摆出来的枚数', () => {
    expect(medalTotal(medalRows({ provincial: { gold: 14 }, final: { silver: 1 } }))).toBe(15);
  });
});

describe('时间轴与 delta（docs/14 §5.3）', () => {
  const history = [
    row({ startAt: '2023-10-21T09:00:00+08:00', ratingAfter: 1480 }),
    row({ startAt: '2024-04-27T09:00:00+08:00', ratingAfter: 1489 }),
    row({ startAt: '2024-06-01T09:00:00+08:00', star: true, ratingAfter: null, rank: null, teams: null, rankPercent: null, perf: null }),
    row({ startAt: '2024-10-19T09:00:00+08:00', ratingAfter: 1608 }),
  ];
  const tl = timeline(history);

  it('打星位占一个场次序号但不进 rated，也没有 y', () => {
    expect(tl.points).toHaveLength(4);
    expect(tl.rated).toHaveLength(3);
    expect(tl.starCount).toBe(1);
    expect(tl.points[2]!.rating).toBeNull();
  });

  it('delta 相对上一个 rated 点：打星场被跨过，首点为 null', () => {
    expect(tl.points.map((p) => p.delta)).toEqual([null, 9, null, 119]);
    expect(tl.first).toBe(1480);
    expect(tl.last).toBe(1608);
    expect(tl.totalDelta).toBe(128);
  });

  it('首点按涨处理（涨蓝跌琥珀的读法与 CF / AT 一致）', () => {
    expect(isUp(null)).toBe(true);
    expect(isUp(0)).toBe(true);
    expect(isUp(-1)).toBe(false);
  });

  it('一场 rated 都没有 → 读数全空，界面走空态', () => {
    const none = timeline([row({ star: true, ratingAfter: null })]);
    expect(none.rated).toHaveLength(0);
    expect([none.first, none.last, none.totalDelta]).toEqual([null, null, null]);
  });
});

describe('队名墙（docs/14 §5.3）', () => {
  it('连续同名算一段，换名开新段（哪怕后来又叫回同一个名）', () => {
    const runs = teamRuns([
      row({ teamName: 'A' }),
      row({ teamName: 'A' }),
      row({ teamName: 'B' }),
      row({ teamName: 'A' }),
    ]);
    expect(runs.map((r) => [r.name, r.rows.length])).toEqual([
      ['A', 2],
      ['B', 1],
      ['A', 1],
    ]);
  });

  it('段内最佳取非打星的最小官方榜名次；整段打星 → null', () => {
    const runs = teamRuns([row({ teamName: 'A', rank: 90 }), row({ teamName: 'A', rank: 15 }), row({ teamName: 'A', rank: 40 })]);
    expect(runs[0]!.best!.rank).toBe(15);

    const starred = teamRuns([row({ teamName: 'A', star: true, rank: null })]);
    expect(starred[0]!.best).toBeNull();
  });
});

describe('逐场编年分章（docs/14 §5.3）', () => {
  const chapters = chronicleChapters(
    player([
      row({ startAt: '2023-10-21T09:00:00+08:00', ratingAfter: 1480 }),
      row({ startAt: '2024-05-18T09:00:00+08:00', ratingAfter: 1544 }),
      row({ startAt: '2024-06-01T09:00:00+08:00', star: true, ratingAfter: null }),
    ]),
  );

  it('年份章节最新在上，年内场次也最新在上', () => {
    expect(chapters.map((c) => c.year)).toEqual(['2024', '2023']);
    expect(chapters[0]!.rows.map((r) => r.row.startAt.slice(0, 10))).toEqual(['2024-06-01', '2024-05-18']);
  });

  it('年度小结给该年 rated 首末分；计数含打星场', () => {
    expect(chapters[0]).toMatchObject({ count: 2, ratedFrom: 1544, ratedTo: 1544 });
  });

  it('整年都是打星 → 不编年度分数段', () => {
    const only = chronicleChapters(player([row({ startAt: '2025-01-01T09:00:00+08:00', star: true, ratingAfter: null })]));
    expect(only[0]).toMatchObject({ count: 1, ratedFrom: null, ratedTo: null });
  });
});

describe('名衔读数（docs/14 §5.3）', () => {
  it('最佳名次 = 逐场官方榜名次最小值，打星与空名次不参与', () => {
    const best = bestRank([row({ rank: null }), row({ star: true, rank: 3 }), row({ rank: 15 }), row({ rank: 60 })]);
    expect(best!.rank).toBe(15);
    expect(bestRank([row({ star: true, rank: null })])).toBeNull();
  });

  it('生涯跨度给整天数与日历月数', () => {
    const span = careerSpan([row({ startAt: '2023-10-21T09:00:00+08:00' }), row({ startAt: '2026-06-28T09:00:00+08:00' })])!;
    expect(span.from).toBe('2023-10-21');
    expect(span.to).toBe('2026-06-28');
    expect(span.months).toBe(32);
    expect(span.days).toBe(981);
  });

  it('空履历没有跨度可读', () => {
    expect(careerSpan([])).toBeNull();
  });

  it('分母取不到就不编一个百分位', () => {
    expect(pctFrom(3412, 63120)).toBe('前 5.4%');
    expect(pctFrom(3412, null)).toBeNull();
    expect(pctFrom(3412, 0)).toBeNull();
  });

  it('百分位优先用上游 rankPercent，缺了才用名次 ÷ 队数现算', () => {
    expect(rowPct(row({ rankPercent: 51.293103448275865, rank: 119, teams: 232 }))).toBe('前 51.3%');
    expect(rowPct(row({ rankPercent: null, rank: 62, teams: 348 }))).toBe('前 17.8%');
    expect(rowPct(row({ rankPercent: null, rank: null, teams: null }))).toBeNull();
  });
});

describe('两钟口径（docs/14 §2.4）', () => {
  it('数据版本取 generatedAt 的日期部分，不做时区换算', () => {
    expect(snapshotDate('2026-09-28T19:57:35.521003+00:00')).toBe('2026-09-28');
    expect(snapshotDate(null)).toBe('—');
  });

  it('生成天数向下取整，读不出时刻就给 null', () => {
    const now = Date.UTC(2026, 9, 6, 0);
    expect(snapshotDaysAgo('2026-09-28T19:57:35.521003+00:00', now)).toBe(7);
    expect(snapshotDaysAgo('不是日期', now)).toBeNull();
    expect(snapshotDaysAgo(null, now)).toBeNull();
  });

  it('未来的时间戳不报负数天数', () => {
    expect(snapshotDaysAgo(new Date(Date.UTC(2026, 9, 10)).toISOString(), Date.UTC(2026, 9, 6))).toBe(0);
  });
});

describe('编年档位格（docs/14 §5.3，复核后修订）', () => {
  it('网络预选赛顶替 tier 徽章：上游归进 regional，展示上不算区域赛', () => {
    expect(chronBadge(row({ online: true, tier: 'regional' }))).toEqual({ tier: null, text: '网络赛' });
  });

  it('tier 缺失给「—」，其余走四档徽章', () => {
    expect(chronBadge(row({ online: false, tier: null }))).toEqual({ tier: null, text: '—' });
    expect(chronBadge(row({ online: false, tier: 'final' }))).toEqual({ tier: 'final', text: '决赛' });
  });
});
