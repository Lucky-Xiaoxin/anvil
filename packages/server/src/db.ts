import { DatabaseSync } from 'node:sqlite';
import { localDayKey, type AcEvent, type RatingRow } from '@anvil/shared';

export const SCHEMA_VERSION = 1;

const DDL = `
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

export interface SubmissionRow {
  id: number;
  contestId: number | null;
  problemKey: string;
  problemName: string | null;
  problemRating: number | null;
  problemTagsJson: string | null;
  verdict: string | null;
  language: string | null;
  participantType: string | null;
  createdTs: number;
  relativeTs: number | null;
}

export function initSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);
  db
    .prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO NOTHING')
    .run('schema_version', String(SCHEMA_VERSION));
}

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  initSchema(db);
  return db;
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** INSERT OR IGNORE：重拉同一批提交不会重复落库 */
export function insertSubmissions(db: DatabaseSync, rows: readonly SubmissionRow[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO submissions
       (id, contest_id, problem_key, problem_name, problem_rating, problem_tags_json,
        verdict, language, participant_type, created_ts, relative_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  return withTransaction(db, () => {
    let stored = 0;
    for (const r of rows) {
      const res = stmt.run(
        r.id,
        r.contestId,
        r.problemKey,
        r.problemName,
        r.problemRating,
        r.problemTagsJson,
        r.verdict,
        r.language,
        r.participantType,
        r.createdTs,
        r.relativeTs,
      );
      stored += Number(res.changes);
    }
    return stored;
  });
}

export function countSubmissions(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM submissions').get()!['n']);
}

/** 生涯去重题数（首次 AC 计一道） */
export function countDistinctOkProblems(db: DatabaseSync): number {
  return Number(
    db.prepare("SELECT COUNT(DISTINCT problem_key) AS n FROM submissions WHERE verdict = 'OK'").get()![
      'n'
    ],
  );
}

/** 场外提交数：relativeTimeSeconds 哨兵值转 NULL */
export function countOffsite(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE relative_ts IS NULL').get()!['n']);
}

export function loadAcEvents(db: DatabaseSync): AcEvent[] {
  const rows = db
    .prepare("SELECT problem_key AS problemKey, created_ts AS createdTs FROM submissions WHERE verdict = 'OK'")
    .all();
  return rows.map((r) => ({ day: localDayKey(Number(r.createdTs)), problemKey: String(r.problemKey) }));
}

export interface RatingInput {
  contestId: number;
  contestName: string;
  rank: number;
  oldRating: number;
  newRating: number;
  updatedTs: number;
}

export function upsertRatingHistory(db: DatabaseSync, rows: readonly RatingInput[]): number {
  const stmt = db.prepare(
    `INSERT INTO rating_history (contest_id, contest_name, rank, old_rating, new_rating, updated_ts)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(contest_id) DO UPDATE SET
       contest_name = excluded.contest_name,
       rank = excluded.rank,
       old_rating = excluded.old_rating,
       new_rating = excluded.new_rating,
       updated_ts = excluded.updated_ts`,
  );
  return withTransaction(db, () => {
    for (const r of rows) stmt.run(r.contestId, r.contestName, r.rank, r.oldRating, r.newRating, r.updatedTs);
    return rows.length;
  });
}

export function loadRatingRows(db: DatabaseSync): RatingRow[] {
  const rows = db
    .prepare(
      `SELECT contest_id AS contestId, contest_name AS contestName, rank AS rank,
              old_rating AS oldRating, new_rating AS newRating, updated_ts AS updatedTs
         FROM rating_history ORDER BY updated_ts ASC`,
    )
    .all();
  const out: RatingRow[] = [];
  for (const r of rows) {
    if (r.updatedTs === null || r.updatedTs === undefined) continue;
    out.push({
      contestId: Number(r.contestId),
      contestName: String(r.contestName ?? ''),
      rank: Number(r.rank ?? 0),
      oldRating: Number(r.oldRating ?? 0),
      newRating: Number(r.newRating ?? 0),
      updatedTs: Number(r.updatedTs),
    });
  }
  return out;
}

export function countRatingContests(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM rating_history').get()!['n']);
}

export function setSyncState(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}

export function getSyncState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT v FROM sync_state WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}
