import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { levelOf } from '@anvil/shared';
import { AT_NOTE, buildDashboard } from '../src/dashboard.ts';
import { initSchema, insertSubmissions, upsertRatingHistory, type SubmissionRow } from '../src/db.ts';

const mem = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
};

/** 上海日历日 12:00 的 epoch 秒 */
const shNoon = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d, 4) / 1000);

const sub = (id: number, source: 'cf' | 'at', day: { y: number; m: number; d: number }, n = 1, verdict = 'OK'): SubmissionRow => ({
  id,
  contestId: source === 'cf' ? 2268 : null,
  problemKey: source === 'cf' ? `cf:2268:${n}` : `at:abc300_${n}`,
  problemName: null,
  problemRating: null,
  problemTagsJson: null,
  verdict,
  language: 'C++20',
  participantType: null,
  createdTs: shNoon(day.y, day.m, day.d),
  relativeTs: null,
});

const TODAY = new Date(Date.UTC(2026, 9, 3, 4));

describe('CF 载荷保持切片 1 语义', () => {
  it('空库：三块都在，rating 给 null 让界面渲染 —', () => {
    const db = mem();
    const d = buildDashboard(db, 'cf', TODAY);
    expect(d.stats.totalSolved).toBe(0);
    expect(d.rating).toBeNull();
    expect(d.stats.entryCount).toBeUndefined();
    expect(d.activity.length).toBeGreaterThan(0);
    db.close();
  });

  it('AT 专有字段不出现在 CF 载荷里', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [sub(1, 'cf', { y: 2026, m: 10, d: 1 })]);
    upsertRatingHistory(db, 'cf', [
      { contestKey: '2268', contestName: 'Codeforces Round 1100 (Div. 2)', rank: 5, oldRating: 1400, newRating: 1438, isRated: true, performance: null, updatedTs: shNoon(2026, 9, 20) },
    ]);
    const d = buildDashboard(db, 'cf', TODAY);
    expect(d.rating!.note).toBeNull();
    expect(d.stats.entryCount).toBeUndefined();
    expect(d.rating!.rankLabel).toBe('Specialist');
    expect(d.rating!.series[0]).toMatchObject({ place: null, performance: null, isRated: true });
    db.close();
  });
});

describe('AT 载荷（docs/contracts/09 §4/§5）', () => {
  it('诚实标注一行 + 参赛副行', () => {
    const db = mem();
    insertSubmissions(db, 'at', [sub(1, 'at', { y: 2026, m: 10, d: 1 })]);
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc300', contestName: 'AtCoder Beginner Contest 300', rank: 198, oldRating: 1200, newRating: 1345, isRated: true, performance: 1377, updatedTs: shNoon(2023, 4, 29) },
      { contestKey: 'abc073', contestName: 'AtCoder Beginner Contest 073', rank: 16, oldRating: 1345, newRating: 1345, isRated: false, performance: null, updatedTs: shNoon(2017, 9, 9) },
    ]);
    const d = buildDashboard(db, 'at', TODAY);
    expect(d.rating!.note).toBe(AT_NOTE);
    expect(d.rating!.note).toBe('2016 起 · 参赛史非提交史 · 来源：AtCoder 官方页 / AtCoder Problems');
    expect(d.stats.entryCount).toBe('参赛 2 场 · 非 rated 1 场');
    db.close();
  });

  it('曲线只收 rated，段位名走 AT 原生色名，place / performance 随点带出', () => {
    const db = mem();
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc300', contestName: 'AtCoder Beginner Contest 300', rank: 198, oldRating: 1200, newRating: 1345, isRated: true, performance: 1377, updatedTs: shNoon(2023, 4, 29) },
      { contestKey: 'abc073', contestName: 'AtCoder Beginner Contest 073', rank: 16, oldRating: 1345, newRating: 1345, isRated: false, performance: null, updatedTs: shNoon(2017, 9, 9) },
    ]);
    const d = buildDashboard(db, 'at', TODAY);
    expect(d.rating!.count).toBe(1);
    expect(d.rating!.series.map((p) => p.contestName)).toEqual(['AtCoder Beginner Contest 300']);
    expect(d.rating!.rankLabel).toBe('Cyan');
    expect(d.rating!.lastContestShort).toBe('ABC 300');
    expect(d.rating!.series[0]).toMatchObject({ place: 198, performance: 1377 });
    db.close();
  });

  it('一场 rated 都没有：rating null，副行照实说', () => {
    const db = mem();
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc073', contestName: 'ABC 073', rank: 16, oldRating: 0, newRating: 0, isRated: false, performance: null, updatedTs: shNoon(2017, 9, 9) },
    ]);
    const d = buildDashboard(db, 'at', TODAY);
    expect(d.rating).toBeNull();
    expect(d.stats.entryCount).toBe('参赛 1 场 · 非 rated 1 场');
    db.close();
  });

  it('聚合函数直接复用：AT 提交吃同一套阈值，日格按上海日切（epoch→日与本机时区无关）', () => {
    const db = mem();
    // 2026-10-01T16:30Z = 上海 2026-10-02 00:30：UTC 看着是 10-01，上海已经是 10-02
    const late = Math.floor(Date.UTC(2026, 9, 1, 16, 30) / 1000);
    insertSubmissions(
      db,
      'at',
      Array.from({ length: 6 }, (_, i) => ({ ...sub(i + 1, 'at', { y: 2026, m: 10, d: 2 }, i + 1), createdTs: late })),
    );
    const d = buildDashboard(db, 'at', TODAY);
    const cell = d.activity.find((c) => c.day === '2026-10-02');
    expect(cell!.solved).toBe(6);
    // 与 CF 同一把尺：6 题 = 第 3 档（0 / 1-2 / 3-5 / 6-9 / 10+）
    expect(levelOf(cell!.solved)).toBe(3);
    expect(d.stats.totalSolved).toBe(6);
    db.close();
  });
});

describe('两源互不串台', () => {
  it('同一天的 CF 与 AT 各算各的格子与题数', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [sub(1, 'cf', { y: 2026, m: 10, d: 2 }), sub(2, 'cf', { y: 2026, m: 10, d: 2 }, 2)]);
    insertSubmissions(db, 'at', [sub(11, 'at', { y: 2026, m: 10, d: 2 })]);
    const cf = buildDashboard(db, 'cf', TODAY);
    const at = buildDashboard(db, 'at', TODAY);
    expect(cf.activity.find((c) => c.day === '2026-10-02')!.solved).toBe(2);
    expect(at.activity.find((c) => c.day === '2026-10-02')!.solved).toBe(1);
    expect(cf.stats.totalSolved).toBe(2);
    expect(at.stats.totalSolved).toBe(1);
    expect(cf.stats.months.at(-1)!.solved).toBe(2);
    expect(at.stats.months.at(-1)!.solved).toBe(1);
    db.close();
  });

  it('同一个 id 在两个源里是两条不同提交（主键 (source, id)）', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [sub(5, 'cf', { y: 2026, m: 10, d: 2 })]);
    insertSubmissions(db, 'at', [sub(5, 'at', { y: 2026, m: 10, d: 2 })]);
    expect(buildDashboard(db, 'cf', TODAY).stats.totalSolved).toBe(1);
    expect(buildDashboard(db, 'at', TODAY).stats.totalSolved).toBe(1);
    expect(buildDashboard(db, 'at', TODAY).activity.find((c) => c.day === '2026-10-02')!.solved).toBe(1);
    db.close();
  });
});
