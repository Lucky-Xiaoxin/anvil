import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { dayKeyOf, type AcEvent, type RatingRow, type SourceId, type SyncSourceId } from '@anvil/shared';

export const SCHEMA_VERSION = 3;

/** v3 增量：只加 xcpc_players 一张表（docs/14 §3）—— v2 库直接补表，老表与老数据不动 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (
  source TEXT NOT NULL DEFAULT 'cf',
  id INTEGER NOT NULL,
  contest_id INTEGER,
  problem_key TEXT NOT NULL,
  problem_name TEXT,
  problem_rating INTEGER,
  problem_tags_json TEXT,
  verdict TEXT,
  language TEXT,
  participant_type TEXT,
  created_ts INTEGER NOT NULL,
  relative_ts INTEGER,
  PRIMARY KEY (source, id)
);
CREATE INDEX IF NOT EXISTS idx_sub_time ON submissions(source, created_ts);
CREATE INDEX IF NOT EXISTS idx_sub_problem ON submissions(source, problem_key);
CREATE TABLE IF NOT EXISTS rating_history (
  source TEXT NOT NULL,
  contest_key TEXT NOT NULL,
  contest_name TEXT,
  rank INTEGER,
  old_rating INTEGER,
  new_rating INTEGER,
  is_rated INTEGER NOT NULL DEFAULT 1,
  performance INTEGER,
  updated_ts INTEGER,
  PRIMARY KEY (source, contest_key)
);
CREATE TABLE IF NOT EXISTS xcpc_players (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  snapshot_at TEXT,
  rank_total INTEGER,
  fetched_at INTEGER NOT NULL
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

export interface RatingInput {
  /** CF: "2268" / AT: "abc300" */
  contestKey: string;
  contestName: string;
  /** AT 的 Place；未上榜为 null */
  rank: number | null;
  oldRating: number;
  newRating: number;
  isRated: boolean;
  /** 非 rated 上游给 0 → 存 NULL */
  performance: number | null;
  updatedTs: number;
}

/** sync_state 键按源命名：`cf:last_sync_at`、`at:last_sync_at`、`xcpc:last_sync_at`（docs/09 §3.1 / docs/14 §4） */
export function syncKey(source: SourceId, name: string): string {
  return `${source}:${name}`;
}

/** 本地库只属于这个源的 handle */
export function handleMetaKey(source: SyncSourceId): string {
  return `${source}_handle`;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

/** v1 的表没有 source 列 —— 有表但缺这列就是老库 */
function isV1Submissions(db: DatabaseSync): boolean {
  return tableExists(db, 'submissions') && !columnsOf(db, 'submissions').includes('source');
}

function isV1RatingHistory(db: DatabaseSync): boolean {
  return tableExists(db, 'rating_history') && !columnsOf(db, 'rating_history').includes('source');
}

/**
 * v1 → v2：事务内重建两张表，CF 行按 §3.1 的规则落进新形状。
 * 幂等 —— 已经迁过的库（有 source 列）不再进重建分支，重复调用不炸、数据不动。
 * v2 → v3 是纯增量：`CREATE TABLE IF NOT EXISTS` 补一张 xcpc_players，重建分支与老数据一概不动。
 */
export function initSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);');

  const stored = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string } | undefined;
  const storedVersion = Number(stored?.v ?? SCHEMA_VERSION);
  if (Number.isFinite(storedVersion) && storedVersion > SCHEMA_VERSION) {
    throw new Error(`vault 数据库 schema v${storedVersion} 比当前应用 v${SCHEMA_VERSION} 更新；请先升级 ANVIL，别让旧版本迁移新库`);
  }

  const fromV1 = isV1Submissions(db) || isV1RatingHistory(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (fromV1) {
      if (isV1Submissions(db)) {
        db.exec(`
          ALTER TABLE submissions RENAME TO submissions_v1;
          CREATE TABLE submissions (
            source TEXT NOT NULL DEFAULT 'cf',
            id INTEGER NOT NULL,
            contest_id INTEGER,
            problem_key TEXT NOT NULL,
            problem_name TEXT,
            problem_rating INTEGER,
            problem_tags_json TEXT,
            verdict TEXT,
            language TEXT,
            participant_type TEXT,
            created_ts INTEGER NOT NULL,
            relative_ts INTEGER,
            PRIMARY KEY (source, id)
          );
          INSERT INTO submissions (source, id, contest_id, problem_key, problem_name, problem_rating,
                                   problem_tags_json, verdict, language, participant_type, created_ts, relative_ts)
          SELECT 'cf', id, contest_id, problem_key, problem_name, problem_rating,
                 problem_tags_json, verdict, language, participant_type, created_ts, relative_ts
            FROM submissions_v1;
          DROP TABLE submissions_v1;
        `);
      }
      if (isV1RatingHistory(db)) {
        db.exec(`
          ALTER TABLE rating_history RENAME TO rating_history_v1;
          CREATE TABLE rating_history (
            source TEXT NOT NULL,
            contest_key TEXT NOT NULL,
            contest_name TEXT,
            rank INTEGER,
            old_rating INTEGER,
            new_rating INTEGER,
            is_rated INTEGER NOT NULL DEFAULT 1,
            performance INTEGER,
            updated_ts INTEGER,
            PRIMARY KEY (source, contest_key)
          );
          INSERT INTO rating_history (source, contest_key, contest_name, rank, old_rating, new_rating, is_rated, updated_ts)
          SELECT 'cf', CAST(contest_id AS TEXT), contest_name, rank, old_rating, new_rating, 1, updated_ts
            FROM rating_history_v1;
          DROP TABLE rating_history_v1;
        `);
      }
      // 老键名加源前缀；重复迁移时目标键已存在就只删旧的，不让 UNIQUE 把事务打断
      db.exec(`
        DELETE FROM sync_state WHERE k LIKE 'cf:%';
        UPDATE sync_state SET k = 'cf:last_sync_at' WHERE k = 'last_sync_at';
        UPDATE sync_state SET k = 'cf:last_error' WHERE k = 'last_error';
      `);
    }
    db.exec(DDL);
    db
      .prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run('schema_version', String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

/**
 * 落库提交。重复拉取同一批不会重复计数（主键 (source, id)），但**评测中的提交允许被订正**：
 * 非最终判定的落库形态不止一种 —— CF 的 verdict 枚举含 `TESTING` / `IN_QUEUE` / `FROZEN` /
 * `WAITING`，AT 判题中的 result 是空串（`parseAtSubmission` 归一后为空串不会进来，但老库/旁路
 * 仍可能存 `''`）；用户在评测队列里点一次同步就会把那一行先写成这些形态。此后同步能重新拉到它
 * （CF 首页最新在前；AT 从已存最晚时刻 `max(created_ts)` 重叠一秒续拉，重叠行靠主键去重），
 * 纯 `INSERT OR IGNORE` 会把订正后的行丢掉 —— 那条 AC 就永久从格子/连续训练/总过题里缺席，
 * 只能靠换 handle 清库才能修。这里的 `DO UPDATE … WHERE` 只订正"原来没有结论（含非最终判定）、
 * 现在有了"的行，普通重拉仍然 `changes = 0`，`stored < fetched` 的增量早退判据不受影响。
 */
export function insertSubmissions(db: DatabaseSync, source: SyncSourceId, rows: readonly SubmissionRow[]): number {
  const stmt = db.prepare(
    `INSERT INTO submissions
       (source, id, contest_id, problem_key, problem_name, problem_rating, problem_tags_json,
        verdict, language, participant_type, created_ts, relative_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, id) DO UPDATE SET verdict = excluded.verdict
       WHERE (submissions.verdict IS NULL OR submissions.verdict IN ('TESTING','IN_QUEUE','FROZEN','WAITING',''))
         AND excluded.verdict IS NOT NULL
         AND excluded.verdict <> 'TESTING'`,
  );
  return withTransaction(db, () => {
    let stored = 0;
    for (const r of rows) {
      const res = stmt.run(
        source,
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

export function countSubmissions(db: DatabaseSync, source: SyncSourceId): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE source = ?').get(source)!['n']);
}

/** 该源生涯去重题数（首次 AC 计一道） */
export function countDistinctOkProblems(db: DatabaseSync, source: SyncSourceId): number {
  return Number(
    db
      .prepare("SELECT COUNT(DISTINCT problem_key) AS n FROM submissions WHERE source = ? AND verdict = 'OK'")
      .get(source)!['n'],
  );
}

/** 场外提交数：relativeTimeSeconds 哨兵值转 NULL。CF 专有 */
export function countOffsite(db: DatabaseSync, source: SyncSourceId): number {
  return Number(
    db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE source = ? AND relative_ts IS NULL')
      .get(source)!['n'],
  );
}

export function loadAcEvents(db: DatabaseSync, source: SyncSourceId): AcEvent[] {
  const rows = db
    .prepare(
      "SELECT problem_key AS problemKey, created_ts AS createdTs FROM submissions WHERE source = ? AND verdict = 'OK'",
    )
    .all(source);
  return rows.map((r) => ({ day: dayKeyOf(Number(r.createdTs)), problemKey: String(r.problemKey) }));
}

/** AT 增量同步的游标：该源已存最早/最晚提交时刻；空库 → null */
export function submissionTimeRange(db: DatabaseSync, source: SyncSourceId): { min: number; max: number } | null {
  const row = db
    .prepare('SELECT MIN(created_ts) AS min, MAX(created_ts) AS max FROM submissions WHERE source = ?')
    .get(source) as { min: number | null; max: number | null };
  if (row.min === null || row.max === null) return null;
  return { min: Number(row.min), max: Number(row.max) };
}

const RATING_UPSERT_SQL = `INSERT INTO rating_history (source, contest_key, contest_name, rank, old_rating, new_rating, is_rated, performance, updated_ts)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, contest_key) DO UPDATE SET
       contest_name = excluded.contest_name,
       rank = excluded.rank,
       old_rating = excluded.old_rating,
       new_rating = excluded.new_rating,
       is_rated = excluded.is_rated,
       performance = excluded.performance,
       updated_ts = excluded.updated_ts`;

function runRatingRows(stmt: StatementSync, source: SyncSourceId, rows: readonly RatingInput[]): number {
  for (const r of rows) {
    stmt.run(
      source,
      r.contestKey,
      r.contestName,
      r.rank,
      r.oldRating,
      r.newRating,
      r.isRated ? 1 : 0,
      r.performance,
      r.updatedTs,
    );
  }
  return rows.length;
}

export function upsertRatingHistory(db: DatabaseSync, source: SyncSourceId, rows: readonly RatingInput[]): number {
  const stmt = db.prepare(RATING_UPSERT_SQL);
  return withTransaction(db, () => runRatingRows(stmt, source, rows));
}

/**
 * 参赛史整域重建（AT）：先清本源、再逐行写入，**同一事务**内完成 ——
 * 中途抛错整体回滚，不会留下「曲线被清空且没恢复」的半截状态（docs/09 §3.3）。
 * CF 的增量路径不走这里，只 upsert（job.ts）。
 */
export function replaceRatingHistory(db: DatabaseSync, source: SyncSourceId, rows: readonly RatingInput[]): number {
  const stmt = db.prepare(RATING_UPSERT_SQL);
  return withTransaction(db, () => {
    db.prepare('DELETE FROM rating_history WHERE source = ?').run(source);
    return runRatingRows(stmt, source, rows);
  });
}

/**
 * 参赛史整域重建用：官方接口不给"这场撤了"的事件，只有全量重放才能让上游删掉的一场从本地消失。
 * 只清本源的行，另一源的曲线不受影响（docs/09 §3.3）。
 */
export function clearRatingHistory(db: DatabaseSync, source: SyncSourceId): void {
  db.prepare('DELETE FROM rating_history WHERE source = ?').run(source);
}

export function loadRatingRows(db: DatabaseSync, source: SyncSourceId): RatingRow[] {
  const rows = db
    .prepare(
      `SELECT contest_key AS contestKey, contest_name AS contestName, rank AS rank,
              old_rating AS oldRating, new_rating AS newRating, is_rated AS isRated,
              performance AS performance, updated_ts AS updatedTs
         FROM rating_history WHERE source = ? ORDER BY updated_ts ASC, contest_key ASC`,
    )
    .all(source);
  const out: RatingRow[] = [];
  for (const r of rows) {
    if (r.updatedTs === null || r.updatedTs === undefined) continue;
    out.push({
      contestKey: String(r.contestKey),
      contestName: String(r.contestName ?? ''),
      rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
      oldRating: Number(r.oldRating ?? 0),
      newRating: Number(r.newRating ?? 0),
      isRated: Number(r.isRated ?? 1) === 1,
      performance: r.performance === null || r.performance === undefined ? null : Number(r.performance),
      updatedTs: Number(r.updatedTs),
    });
  }
  return out;
}

/** tab 条次行的当前 rating：最近一场 rated 的新 rating */
export function latestRating(db: DatabaseSync, source: SyncSourceId): number | null {
  const row = db
    .prepare(
      `SELECT new_rating AS n FROM rating_history
        WHERE source = ? AND is_rated = 1 AND updated_ts IS NOT NULL
        ORDER BY updated_ts DESC, contest_key DESC LIMIT 1`,
    )
    .get(source) as { n: number | null } | undefined;
  return row?.n === null || row?.n === undefined ? null : Number(row.n);
}

/** 参赛场次：含非 rated（AT 的「参赛 N 场」口径，docs/09 §2） */
export function countRatingEntries(db: DatabaseSync, source: SyncSourceId): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE source = ?').get(source)!['n']);
}

/** 曲线点数：只数 rated 场 */
export function countRatingContests(db: DatabaseSync, source: SyncSourceId): number {
  return Number(
    db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE source = ? AND is_rated = 1').get(source)!['n'],
  );
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}

/**
 * 按源域清空：换 AT handle 只清 source='at'，CF 的提交与 rating 一根毛都不动（docs/09 §3.3）。
 * 该源的 sync_state 键与归属标记一起清掉。
 */
export function resetSourceData(db: DatabaseSync, source: SyncSourceId): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM submissions WHERE source = ?').run(source);
    db.prepare('DELETE FROM rating_history WHERE source = ?').run(source);
    db.prepare('DELETE FROM sync_state WHERE k LIKE ?').run(`${source}:%`);
    db.prepare('DELETE FROM meta WHERE k = ?').run(handleMetaKey(source));
  });
}

export function setSyncState(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}

export function getSyncState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT v FROM sync_state WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

/* ---------- XCPC（切片 3 · docs/14 §3）：PlayerDetail 整存 JSON 文本，读时再映射 DTO ---------- */

export interface XcpcStoredPlayer {
  key: string;
  /** PlayerDetail 原样 JSON 文本 */
  payload: string;
  /** meta.json 的 generatedAt；取不到 → NULL */
  snapshotAt: string | null;
  /** leaderboards/official/meta.json 的 total；取不到 → NULL → 界面 — */
  rankTotal: number | null;
  /** 本地拉取时刻（epoch 秒） */
  fetchedAt: number;
}

/**
 * 单档案语义：claim / refresh 都是「清掉 xcpc 域再写这一行」，同一个事务里完成。
 * 表按 key 建成是为了将来多人档案能直接扩展；当前只保一份。
 */
export function replaceXcpcPlayer(db: DatabaseSync, row: XcpcStoredPlayer): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM xcpc_players').run();
    db
      .prepare('INSERT INTO xcpc_players (key, payload, snapshot_at, rank_total, fetched_at) VALUES (?,?,?,?,?)')
      .run(row.key, row.payload, row.snapshotAt, row.rankTotal, row.fetchedAt);
  });
}

export function clearXcpcPlayer(db: DatabaseSync): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM xcpc_players').run();
  });
}

export function loadXcpcPlayer(db: DatabaseSync): XcpcStoredPlayer | null {
  const row = db
    .prepare(
      `SELECT key AS key, payload AS payload, snapshot_at AS snapshotAt, rank_total AS rankTotal, fetched_at AS fetchedAt
         FROM xcpc_players LIMIT 1`,
    )
    .get() as { key: string; payload: string; snapshotAt: string | null; rankTotal: number | null; fetchedAt: number } | undefined;
  if (!row) return null;
  return {
    key: String(row.key),
    payload: String(row.payload),
    snapshotAt: row.snapshotAt === null ? null : String(row.snapshotAt),
    rankTotal: row.rankTotal === null ? null : Number(row.rankTotal),
    fetchedAt: Number(row.fetchedAt),
  };
}
