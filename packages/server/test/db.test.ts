import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  clearRatingHistory,
  countDistinctOkProblems,
  countOffsite,
  countRatingContests,
  countRatingEntries,
  countSubmissions,
  getMeta,
  getSyncState,
  handleMetaKey,
  initSchema,
  insertSubmissions,
  latestRating,
  loadAcEvents,
  loadRatingRows,
  replaceRatingHistory,
  resetSourceData,
  SCHEMA_VERSION,
  setMeta,
  setSyncState,
  submissionTimeRange,
  syncKey,
  upsertRatingHistory,
  type SubmissionRow,
} from '../src/db.ts';

/** docs/04 §4.2 的 v1 原样 DDL：迁移测试的夹具就地建一个老库 */
const DDL_V1 = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  contest_id INTEGER,
  problem_key TEXT NOT NULL,
  problem_name TEXT,
  problem_rating INTEGER,
  problem_tags_json TEXT,
  verdict TEXT,
  language TEXT,
  participant_type TEXT,
  created_ts INTEGER NOT NULL,
  relative_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sub_time ON submissions(created_ts);
CREATE INDEX IF NOT EXISTS idx_sub_problem ON submissions(problem_key);
CREATE TABLE IF NOT EXISTS rating_history (
  contest_id INTEGER PRIMARY KEY, contest_name TEXT, rank INTEGER,
  old_rating INTEGER, new_rating INTEGER, updated_ts INTEGER
);
CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** 上海日历的正午（04:00Z）：夹具不依赖运行机时区 */
const TS = Math.floor(Date.UTC(2026, 9, 2, 4) / 1000);

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
  createdTs: TS,
  relativeTs: 3600,
  ...over,
});

const mem = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
};

const memV1 = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL_V1);
  return db;
};

/** 往 v1 形状的老库里塞 CF 数据：只能用老 DDL 的列，不能用 v2 的写入函数 */
function seedV1(db: DatabaseSync, subs: readonly SubmissionRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO submissions (id, contest_id, problem_key, problem_name, problem_rating, problem_tags_json,
                             verdict, language, participant_type, created_ts, relative_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const s of subs) {
    stmt.run(s.id, s.contestId, s.problemKey, s.problemName, s.problemRating, s.problemTagsJson, s.verdict, s.language, s.participantType, s.createdTs, s.relativeTs);
  }
}

const names = (db: DatabaseSync, sql: string): string[] =>
  (db.prepare(sql).all() as { name: string }[]).map((r) => r.name).sort();

describe('Schema v3 DDL', () => {
  it('重复 init 不炸，schema_version 落 3', () => {
    const db = mem();
    expect(() => initSchema(db)).not.toThrow();
    expect(() => initSchema(db)).not.toThrow();
    const v = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string };
    expect(v.v).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('建表齐活，索引按源建复合键', () => {
    const db = mem();
    expect(names(db, "SELECT name FROM sqlite_master WHERE type='table'")).toEqual([
      'meta',
      'rating_history',
      'submissions',
      'sync_state',
      'xcpc_players',
    ]);
    expect(names(db, "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")).toEqual([
      'idx_sub_problem',
      'idx_sub_time',
    ]);
    const cols = (db.prepare('PRAGMA table_info(submissions)').all() as { name: string }[]).map((r) => r.name);
    expect(cols[0]).toBe('source');
    db.close();
  });

  it('主键 (source, id)：同一个提交号在两个源里各占一行，不互相吞掉', () => {
    const db = mem();
    expect(insertSubmissions(db, 'cf', [row({ id: 7 })])).toBe(1);
    expect(insertSubmissions(db, 'at', [row({ id: 7, problemKey: 'at:abc300_a' })])).toBe(1);
    expect(countSubmissions(db, 'cf')).toBe(1);
    expect(countSubmissions(db, 'at')).toBe(1);
    db.close();
  });

  it('重拉同一批不重复（INSERT OR IGNORE 语义）', () => {
    const db = mem();
    expect(insertSubmissions(db, 'cf', [row(), row({ id: 101 })])).toBe(2);
    expect(insertSubmissions(db, 'cf', [row(), row({ id: 101 })])).toBe(0);
    expect(countSubmissions(db, 'cf')).toBe(2);
    db.close();
  });

  it('评测中的提交能被订正：NULL / TESTING → 真结论只订正一次', () => {
    const db = mem();
    // 同步时还在评测队列里
    insertSubmissions(db, 'cf', [row({ id: 1, verdict: null }), row({ id: 2, verdict: 'TESTING' })]);
    expect(loadAcEvents(db, 'cf')).toEqual([]);
    // 再同步拉到结论：两条都该被订正，各算 1 次 changes（增量早退判据照旧）
    expect(insertSubmissions(db, 'cf', [row({ id: 1, verdict: 'OK' }), row({ id: 2, verdict: 'WRONG_ANSWER' })])).toBe(2);
    expect(loadAcEvents(db, 'cf')).toEqual([{ day: '2026-10-02', problemKey: 'cf:2268:D' }]);
    // 已经定论的行不再改写：OK 不会被后来的 WA 覆盖，重拉仍是 0
    expect(insertSubmissions(db, 'cf', [row({ id: 1, verdict: 'WRONG_ANSWER' })])).toBe(0);
    expect(loadAcEvents(db, 'cf')).toHaveLength(1);
    // 反向不算订正：拿到结论后再收到 TESTING / NULL 不该抹掉它
    expect(insertSubmissions(db, 'cf', [row({ id: 1, verdict: 'TESTING' }), row({ id: 1, verdict: null })])).toBe(0);
    expect(loadAcEvents(db, 'cf')).toHaveLength(1);
    db.close();
  });

  it('订正谓词覆盖全部非最终判定：空串 / IN_QUEUE / FROZEN / WAITING → 真结论都放行', () => {
    const db = mem();
    // AT 判题中落库的空串（老库形态）+ CF 的三种排队判名
    insertSubmissions(db, 'at', [row({ id: 1, problemKey: 'at:abc300_a', verdict: '' })]);
    insertSubmissions(db, 'cf', [
      row({ id: 2, verdict: 'IN_QUEUE' }),
      row({ id: 3, problemKey: 'cf:2268:E', verdict: 'FROZEN' }),
      row({ id: 4, problemKey: 'cf:2268:F', verdict: 'WAITING' }),
    ]);
    expect(countDistinctOkProblems(db, 'at')).toBe(0);
    expect(countDistinctOkProblems(db, 'cf')).toBe(0);
    // 订正成真结论：那条 AC 必须进得来（否则永久缺席）
    expect(insertSubmissions(db, 'at', [row({ id: 1, problemKey: 'at:abc300_a', verdict: 'OK' })])).toBe(1);
    expect(insertSubmissions(db, 'cf', [row({ id: 2, verdict: 'OK' }), row({ id: 3, verdict: 'OK' }), row({ id: 4, verdict: 'OK' })])).toBe(3);
    expect(countDistinctOkProblems(db, 'at')).toBe(1);
    expect(countDistinctOkProblems(db, 'cf')).toBe(3);
    db.close();
  });
});

describe('v1 → v2 迁移', () => {
  it('CF 数据完好：source=cf、contest_key 转字符串、is_rated=1', () => {
    const db = memV1();
    db.prepare(
      `INSERT INTO submissions (id, contest_id, problem_key, problem_name, problem_rating, problem_tags_json,
                                verdict, language, participant_type, created_ts, relative_ts)
       VALUES (5001, 2268, 'cf:2268:D', 'Iron Anvil', 1500, '["math"]', 'OK', 'C++20', 'PRACTICE', ?, NULL)`,
    ).run(TS);
    db.prepare(
      `INSERT INTO rating_history (contest_id, contest_name, rank, old_rating, new_rating, updated_ts)
       VALUES (2268, 'Codeforces Round 1100 (Div. 2)', 5, 1400, 1438, ?)`,
    ).run(TS);
    db.prepare("INSERT INTO sync_state(k, v) VALUES ('last_sync_at', '1790000000')").run();
    db.prepare("INSERT INTO sync_state(k, v) VALUES ('last_error', '上次网络不通')").run();
    db.prepare("INSERT INTO meta(k, v) VALUES ('schema_version', '1'), ('cf_handle', 'jywlq')").run();

    initSchema(db);

    expect(countSubmissions(db, 'cf')).toBe(1);
    expect(loadAcEvents(db, 'cf')).toEqual([{ day: '2026-10-02', problemKey: 'cf:2268:D' }]);
    const rating = loadRatingRows(db, 'cf');
    expect(rating).toHaveLength(1);
    expect(rating[0]).toMatchObject({ contestKey: '2268', isRated: true, performance: null, newRating: 1438 });
    expect(getSyncState(db, syncKey('cf', 'last_sync_at'))).toBe('1790000000');
    expect(getSyncState(db, syncKey('cf', 'last_error'))).toBe('上次网络不通');
    expect(getSyncState(db, 'last_sync_at')).toBeNull();
    expect(getMeta(db, handleMetaKey('cf'))).toBe('jywlq');
    expect(db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()).toEqual({ v: '3' });
    // 老表不留在库里
    expect(names(db, "SELECT name FROM sqlite_master WHERE type='table'")).toEqual([
      'meta',
      'rating_history',
      'submissions',
      'sync_state',
      'xcpc_players',
    ]);
    db.close();
  });

  it('幂等：重复迁移不炸、CF 数据一条不多一条不少', () => {
    const db = memV1();
    seedV1(db, [row({ id: 1 }), row({ id: 2, verdict: 'WA' })]);
    db.prepare(
      `INSERT INTO rating_history (contest_id, contest_name, rank, old_rating, new_rating, updated_ts)
       VALUES (2268, 'Round 1100', 5, 1400, 1438, ?)`,
    ).run(TS);
    const before = db.prepare('SELECT * FROM submissions ORDER BY id').all();
    initSchema(db);
    const afterFirst = db.prepare('SELECT * FROM submissions ORDER BY id').all();

    initSchema(db);
    initSchema(db);

    expect(db.prepare('SELECT * FROM submissions ORDER BY id').all()).toEqual(afterFirst);
    expect(afterFirst.map((r) => (r as Record<string, unknown>).source)).toEqual(['cf', 'cf']);
    expect(before).toHaveLength(2);
    expect(countSubmissions(db, 'cf')).toBe(2);
    expect(countRatingContests(db, 'cf')).toBe(1);
    expect(names(db, "SELECT name FROM sqlite_master WHERE type='table'")).toEqual([
      'meta',
      'rating_history',
      'submissions',
      'sync_state',
      'xcpc_players',
    ]);
    db.close();
  });

  it('迁移后仍能按源写：AT 的行不碰 CF', () => {
    const db = memV1();
    seedV1(db, [row({ id: 1 })]);
    initSchema(db);
    insertSubmissions(db, 'at', [row({ id: 900, problemKey: 'at:abc300_a' })]);
    expect(countSubmissions(db, 'cf')).toBe(1);
    expect(countSubmissions(db, 'at')).toBe(1);
    db.close();
  });
});

describe('按源隔离', () => {
  it('计数 / 事件 / 场外数都只算本源', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [
      row({ id: 1, relativeTs: null }),
      row({ id: 2, problemKey: 'cf:2268:E' }),
      row({ id: 3, verdict: 'WA' }),
    ]);
    insertSubmissions(db, 'at', [
      row({ id: 11, problemKey: 'at:abc300_a', relativeTs: null }),
      row({ id: 12, problemKey: 'at:abc300_b', verdict: 'WA' }),
    ]);
    expect(countSubmissions(db, 'cf')).toBe(3);
    expect(countSubmissions(db, 'at')).toBe(2);
    expect(countDistinctOkProblems(db, 'cf')).toBe(2);
    expect(countDistinctOkProblems(db, 'at')).toBe(1);
    // 场外数是 CF 专有读数：AT 那侧的 NULL 相对时间不能串进来，反之也一样
    expect(countOffsite(db, 'cf')).toBe(1);
    expect(countOffsite(db, 'at')).toBe(1);
    expect(loadAcEvents(db, 'at').map((e) => e.problemKey)).toEqual(['at:abc300_a']);
    db.close();
  });

  it('换 AT handle 只清 AT：CF 的提交、rating、同步状态一根毛都不动', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [row({ id: 1 }), row({ id: 2 })]);
    insertSubmissions(db, 'at', [row({ id: 9, problemKey: 'at:abc300_a' })]);
    upsertRatingHistory(db, 'cf', [
      { contestKey: '2268', contestName: 'Round', rank: 5, oldRating: 1400, newRating: 1438, isRated: true, performance: null, updatedTs: TS },
    ]);
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc300', contestName: 'ABC 300', rank: 198, oldRating: 1200, newRating: 1345, isRated: true, performance: 1377, updatedTs: TS },
    ]);
    setSyncState(db, syncKey('cf', 'last_sync_at'), '1');
    setSyncState(db, syncKey('at', 'last_sync_at'), '2');
    setMeta(db, handleMetaKey('at'), 'oldGuy');

    // 迁移层的清空入口：同步作业在拉到第一手数据后才调用它
    resetSourceData(db, 'at');

    expect(countSubmissions(db, 'at')).toBe(0);
    expect(countRatingContests(db, 'at')).toBe(0);
    expect(getSyncState(db, syncKey('at', 'last_sync_at'))).toBeNull();
    expect(getMeta(db, handleMetaKey('at'))).toBeNull();
    expect(countSubmissions(db, 'cf')).toBe(2);
    expect(countRatingContests(db, 'cf')).toBe(1);
    expect(getSyncState(db, syncKey('cf', 'last_sync_at'))).toBe('1');
    expect(latestRating(db, 'cf')).toBe(1438);
    expect(latestRating(db, 'at')).toBeNull();
    db.close();
  });

  it('rating_history 主键 (source, contest_key)：同名 contest_key 两源并存', () => {
    const db = mem();
    const input = (source: 'cf' | 'at', key: string, n: number) =>
      upsertRatingHistory(db, source, [
        { contestKey: key, contestName: `${source} ${key}`, rank: 1, oldRating: 0, newRating: n, isRated: true, performance: null, updatedTs: TS },
      ]);
    expect(input('cf', '2268', 1438)).toBe(1);
    expect(input('at', '2268', 900)).toBe(1);
    expect(loadRatingRows(db, 'cf')[0]!.contestName).toBe('cf 2268');
    expect(loadRatingRows(db, 'at')[0]!.contestName).toBe('at 2268');
    db.close();
  });

  it('参赛场次含非 rated，曲线场次只数 rated（docs/09 §2）', () => {
    const db = mem();
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc300', contestName: 'ABC 300', rank: 1, oldRating: 0, newRating: 1200, isRated: true, performance: 1200, updatedTs: TS },
      { contestKey: 'abc301', contestName: 'ABC 301', rank: 16, oldRating: 1200, newRating: 1200, isRated: false, performance: null, updatedTs: TS + 604800 },
    ]);
    expect(countRatingEntries(db, 'at')).toBe(2);
    expect(countRatingContests(db, 'at')).toBe(1);
    expect(loadRatingRows(db, 'at').map((r) => r.isRated)).toEqual([true, false]);
    expect(latestRating(db, 'at')).toBe(1200); // 非 rated 场不参与"当前 rating"
    db.close();
  });

  it('clearRatingHistory 只清本源', () => {
    const db = mem();
    upsertRatingHistory(db, 'cf', [
      { contestKey: '1', contestName: 'A', rank: 1, oldRating: 0, newRating: 1, isRated: true, performance: null, updatedTs: TS },
    ]);
    upsertRatingHistory(db, 'at', [
      { contestKey: 'a', contestName: 'B', rank: 1, oldRating: 0, newRating: 2, isRated: true, performance: null, updatedTs: TS },
    ]);
    clearRatingHistory(db, 'at');
    expect(countRatingEntries(db, 'at')).toBe(0);
    expect(countRatingEntries(db, 'cf')).toBe(1);
    db.close();
  });

  it('replaceRatingHistory：整域重建 = 清本源 + 写新行，同一事务内完成', () => {
    const db = mem();
    upsertRatingHistory(db, 'at', [
      { contestKey: 'a', contestName: '将撤的一场', rank: 1, oldRating: 0, newRating: 2, isRated: true, performance: null, updatedTs: TS },
    ]);
    upsertRatingHistory(db, 'cf', [
      { contestKey: '1', contestName: 'A', rank: 1, oldRating: 0, newRating: 1, isRated: true, performance: null, updatedTs: TS },
    ]);
    // 上游删掉一场：重建后本地只留新的一批，另一源不动
    expect(
      replaceRatingHistory(db, 'at', [
        { contestKey: 'b', contestName: 'B', rank: 3, oldRating: 2, newRating: 5, isRated: true, performance: null, updatedTs: TS },
      ]),
    ).toBe(1);
    expect(loadRatingRows(db, 'at').map((r) => r.contestKey)).toEqual(['b']);
    expect(countRatingEntries(db, 'cf')).toBe(1);
    // 空行批次 = 上游全清（合法答案），事务内同样成立
    replaceRatingHistory(db, 'at', []);
    expect(countRatingEntries(db, 'at')).toBe(0);
    db.close();
  });

  it('提交时间范围给 AT 当增量游标；空库给 null', () => {
    const db = mem();
    expect(submissionTimeRange(db, 'at')).toBeNull();
    insertSubmissions(db, 'at', [row({ id: 1, createdTs: 1000 }), row({ id: 2, createdTs: 5000 })]);
    expect(submissionTimeRange(db, 'at')).toEqual({ min: 1000, max: 5000 });
    expect(submissionTimeRange(db, 'cf')).toBeNull();
    db.close();
  });

  it('AC 事件只取 verdict=OK，按上海日出题键', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [
      row({ id: 1, verdict: 'OK' }),
      row({ id: 2, verdict: 'WA' }),
      row({ id: 3, verdict: 'OK', problemKey: 'cf:2268:E' }),
      row({ id: 4, verdict: 'OK', createdTs: Math.floor(Date.UTC(2026, 9, 3, 4) / 1000) }),
    ]);
    const events = loadAcEvents(db, 'cf');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.day).sort()).toEqual(['2026-10-02', '2026-10-02', '2026-10-03']);
    expect(countDistinctOkProblems(db, 'cf')).toBe(2);
    db.close();
  });

  it('场外哨兵值存 NULL，正常场内相对时间原样存', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [row({ id: 1, relativeTs: null }), row({ id: 2, relativeTs: 120 })]);
    const rows = db.prepare('SELECT id, relative_ts FROM submissions ORDER BY id').all() as {
      id: number;
      relative_ts: number | null;
    }[];
    expect(rows[0]!.relative_ts).toBeNull();
    expect(rows[1]!.relative_ts).toBe(120);
    expect(countOffsite(db, 'cf')).toBe(1);
    db.close();
  });

  it('gym 题没有 rating / tags 也不崩', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [row({ id: 7, problemRating: null, problemTagsJson: '[]', contestId: 999999 })]);
    const r = db.prepare('SELECT problem_rating, problem_tags_json FROM submissions WHERE id = 7').get() as {
      problem_rating: number | null;
      problem_tags_json: string;
    };
    expect(r.problem_rating).toBeNull();
    expect(JSON.parse(r.problem_tags_json)).toEqual([]);
    db.close();
  });

  it('participantType 原样存，后续切片要用', () => {
    const db = mem();
    insertSubmissions(db, 'cf', [row({ id: 1, participantType: 'VIRTUAL' })]);
    const r = db.prepare('SELECT participant_type FROM submissions WHERE id = 1').get() as {
      participant_type: string;
    };
    expect(r.participant_type).toBe('VIRTUAL');
    db.close();
  });
});

describe('rating 史读取', () => {
  it('按 contest_key 覆盖更新', () => {
    const db = mem();
    const input = (n: number, ts: number) =>
      upsertRatingHistory(db, 'cf', [
        { contestKey: '2268', contestName: 'Round 1100 (Div. 2)', rank: 5, oldRating: 1400, newRating: n, isRated: true, performance: null, updatedTs: ts },
      ]);
    expect(input(1438, 1)).toBe(1);
    expect(input(1460, 2)).toBe(1);
    expect(countRatingContests(db, 'cf')).toBe(1);
    expect(loadRatingRows(db, 'cf')[0]!.newRating).toBe(1460);
    db.close();
  });

  it('按时间升序返回，updated_ts 缺失的行丢掉', () => {
    const db = mem();
    upsertRatingHistory(db, 'cf', [
      { contestKey: '2', contestName: 'B', rank: 1, oldRating: 0, newRating: 1500, isRated: true, performance: null, updatedTs: 200 },
      { contestKey: '1', contestName: 'A', rank: 1, oldRating: 0, newRating: 1400, isRated: true, performance: null, updatedTs: 100 },
    ]);
    expect(loadRatingRows(db, 'cf').map((r) => r.contestName)).toEqual(['A', 'B']);
    db.close();
  });
});

describe('sync_state', () => {
  it('同一个 key 覆盖写', () => {
    const db = mem();
    setSyncState(db, syncKey('cf', 'last_sync_at'), '1789000000');
    setSyncState(db, syncKey('cf', 'last_sync_at'), '1789000600');
    expect(getSyncState(db, syncKey('cf', 'last_sync_at'))).toBe('1789000600');
    expect(getSyncState(db, 'nope')).toBeNull();
    db.close();
  });
});
