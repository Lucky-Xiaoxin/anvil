import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  countDistinctOkProblems,
  countOffsite,
  countRatingContests,
  countSubmissions,
  getSyncState,
  initSchema,
  insertSubmissions,
  loadAcEvents,
  loadRatingRows,
  SCHEMA_VERSION,
  setSyncState,
  upsertRatingHistory,
  type SubmissionRow,
} from '../src/db.ts';

const row = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
  id: 100,
  contestId: 2268,
  problemKey: 'cf:2268:D',
  problemName: 'Iron Anvil',
  problemRating: 1500,
  problemTagsJson: '["math"]',
  verdict: 'OK',
  language: 'C++20 (GCC 13-64)',
  participantType: 'PRACTICE',
  createdTs: Math.floor(new Date(2026, 9, 2, 12).getTime() / 1000),
  relativeTs: 3600,
  ...over,
});

const mem = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
};

describe('DDL', () => {
  it('重复 init 不炸，schema_version 落 1', () => {
    const db = mem();
    expect(() => initSchema(db)).not.toThrow();
    expect(() => initSchema(db)).not.toThrow();
    const v = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string };
    expect(v.v).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('建表齐活：submissions / rating_history / sync_state + 两个索引', () => {
    const db = mem();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(['meta', 'rating_history', 'submissions', 'sync_state']);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual(['idx_sub_problem', 'idx_sub_time']);
    db.close();
  });
});

describe('提交落库', () => {
  it('重拉同一批不重复（INSERT OR IGNORE）', () => {
    const db = mem();
    expect(insertSubmissions(db, [row(), row({ id: 101 })])).toBe(2);
    expect(insertSubmissions(db, [row(), row({ id: 101 })])).toBe(0);
    expect(countSubmissions(db)).toBe(2);
    db.close();
  });

  it('场外哨兵值存 NULL，正常场内相对时间原样存', () => {
    const db = mem();
    insertSubmissions(db, [row({ id: 1, relativeTs: null }), row({ id: 2, relativeTs: 120 })]);
    const rows = db.prepare('SELECT id, relative_ts FROM submissions ORDER BY id').all() as { id: number; relative_ts: number | null }[];
    expect(rows[0]!.relative_ts).toBeNull();
    expect(rows[1]!.relative_ts).toBe(120);
    expect(countOffsite(db)).toBe(1);
    db.close();
  });

  it('gym 题没有 rating / tags 也不崩', () => {
    const db = mem();
    insertSubmissions(db, [row({ id: 7, problemRating: null, problemTagsJson: '[]', contestId: 999999 })]);
    const r = db.prepare('SELECT problem_rating, problem_tags_json FROM submissions WHERE id = 7').get() as {
      problem_rating: number | null;
      problem_tags_json: string;
    };
    expect(r.problem_rating).toBeNull();
    expect(JSON.parse(r.problem_tags_json)).toEqual([]);
    db.close();
  });

  it('AC 事件只取 verdict=OK，按本地日出题键', () => {
    const db = mem();
    insertSubmissions(db, [
      row({ id: 1, verdict: 'OK' }),
      row({ id: 2, verdict: 'WA' }),
      row({ id: 3, verdict: 'OK', problemKey: 'cf:2268:E' }),
      row({ id: 4, verdict: 'OK', createdTs: Math.floor(new Date(2026, 9, 3, 12).getTime() / 1000) }),
    ]);
    const events = loadAcEvents(db);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.day).sort()).toEqual(['2026-10-02', '2026-10-02', '2026-10-03']);
    expect(countDistinctOkProblems(db)).toBe(2);
    db.close();
  });

  it('participantType 原样存，后续切片要用', () => {
    const db = mem();
    insertSubmissions(db, [row({ id: 1, participantType: 'VIRTUAL' })]);
    const r = db.prepare('SELECT participant_type FROM submissions').get() as { participant_type: string };
    expect(r.participant_type).toBe('VIRTUAL');
    db.close();
  });
});

describe('rating 史', () => {
  it('按 contest_id 覆盖更新', () => {
    const db = mem();
    upsertRatingHistory(db, [{ contestId: 2268, contestName: 'Round 1100 (Div. 2)', rank: 5, oldRating: 1400, newRating: 1438, updatedTs: 1 }]);
    upsertRatingHistory(db, [{ contestId: 2268, contestName: 'Round 1100 (Div. 2)', rank: 5, oldRating: 1400, newRating: 1460, updatedTs: 2 }]);
    expect(countRatingContests(db)).toBe(1);
    expect(loadRatingRows(db)[0]!.newRating).toBe(1460);
    db.close();
  });

  it('按时间升序返回', () => {
    const db = mem();
    upsertRatingHistory(db, [
      { contestId: 2, contestName: 'B', rank: 1, oldRating: 0, newRating: 1500, updatedTs: 200 },
      { contestId: 1, contestName: 'A', rank: 1, oldRating: 0, newRating: 1400, updatedTs: 100 },
    ]);
    expect(loadRatingRows(db).map((r) => r.contestName)).toEqual(['A', 'B']);
    db.close();
  });
});

describe('sync_state', () => {
  it('同一个 key 覆盖写', () => {
    const db = mem();
    setSyncState(db, 'last_sync_at', '1789000000');
    setSyncState(db, 'last_sync_at', '1789000600');
    expect(getSyncState(db, 'last_sync_at')).toBe('1789000600');
    expect(getSyncState(db, 'nope')).toBeNull();
    db.close();
  });
});
