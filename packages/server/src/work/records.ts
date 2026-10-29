/**
 * 榜单多存档的文件层（docs/contracts/29）：`.anvil-records/<recordId>.json`、旧根 `record.json`、
 * revision（原文件字节 SHA-256）、缓存榜单校验、单档回收清单与恢复映射。
 * 宿主查找、索引与写队列在 store.ts；这里只认「已经定位好的比赛目录」。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  ARENA_RECORD_FILE_MAX_BYTES,
  LEGACY_RECORD_ID,
  arenaRecordAddressOk,
  arenaRecordContentEquals,
  arenaTrashIdOk,
  contestPathOk,
  legacyArenaRecordName,
  normalizeArenaRecordName,
  parseArenaRecordFile,
  parseArenaRecordResult,
  parseWorkArenaGhost,
  parseWorkArenaRecord,
  projectLegacyReview,
  summaryOfArenaRecord,
  workIdOk,
  type ArenaRecord,
  type ArenaRecordCreateInput,
  type ArenaRecordErrorDto,
  type ArenaRecordResult,
  type ArenaRecordSummaryDto,
  type ArenaLegacyRecordDto,
  type ArenaLegacySummaryDto,
  type ArenaRecordUpdateInput,
  type ArenaRecordRenameInput,
  type ArenaRecordsListDto,
  type ArenaRecordRestoreResult,
  type WorkArenaGhost,
  type WorkArenaRecordDto,
} from '@anvil/shared';
import { writeFileAtomic } from '../atomic.ts';
import { WorkError } from './errors.ts';
import { assertNoSymlinkComponents, localTrashStamp, lstatOrNull } from './paths.ts';

export const RECORDS_DIR_NAME = '.anvil-records';
export const LEGACY_FILE_NAME = 'record.json';

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function recordFileNameOf(recordId: string): string {
  return recordId === LEGACY_RECORD_ID ? LEGACY_FILE_NAME : `${recordId}.json`;
}

/** 卡片上的文件清单不展示 .anvil-records（点目录开头，本身已被扫描忽略） */
export function recordsDirOf(contestAbs: string): string {
  return join(contestAbs, RECORDS_DIR_NAME);
}

function recordAbsPathOf(host: RecordHostInfo, recordId: string): string {
  return recordId === LEGACY_RECORD_ID
    ? join(host.contestAbs, LEGACY_FILE_NAME)
    : join(recordsDirOf(host.contestAbs), `${recordId}.json`);
}

export interface RecordHostInfo {
  root: string;
  contestId: string;
  contestRelPath: string;
  contestAbs: string;
  arenaPath: string;
  /** 宿主归档时管理动作冻结；成绩写入不受此限 */
  effectiveArchived: boolean;
}

type RecordFileBase = {
  fileName: string;
  absPath: string;
  revision: string;
  text: string;
};

export type RecordFileRead =
  | { kind: 'missing' }
  | (RecordFileBase & { kind: 'record'; record: ArenaRecord })
  | (RecordFileBase & { kind: 'legacy-review'; record: WorkArenaRecordDto })
  | (RecordFileBase & { kind: 'legacy-live'; record: WorkArenaRecordDto });

function readOrdinaryFile(absPath: string, label: string): string | null {
  const st = lstatOrNull(absPath);
  if (st === null) return null;
  if (st.isSymbolicLink() || !st.isFile()) throw new WorkError('unsafe-path', `${label} 必须是普通文件，不允许符号链接`);
  if (st.size > ARENA_RECORD_FILE_MAX_BYTES) {
    throw new WorkError('invalid', `${label} 超过 1 MiB，不能在 ANVIL 里读写`);
  }
  try {
    return readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new WorkError('internal', `${label} 读不出来：${asError(err).message}`);
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new WorkError('internal', `${label} 不是合法 JSON：${asError(err).message}`);
  }
}

function assertRecordHome(host: RecordHostInfo, recordId: string): void {
  assertNoSymlinkComponents(host.root, host.contestAbs);
  if (recordId === LEGACY_RECORD_ID) return;
  const dir = recordsDirOf(host.contestAbs);
  const st = lstatOrNull(dir);
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new WorkError('unsafe-path', `${RECORDS_DIR_NAME} 必须是比赛目录里的普通目录`);
  }
}

/**
 * 读取一份存档。旧根文件兼容 schema 1；`.anvil-records` 只认 schema 2。
 * 正文 ID / 场次 / 宿主与寻址不一致时拒绝，不尝试猜另一个位置。
 */
export function readRecordFile(host: RecordHostInfo, recordId: string): RecordFileRead {
  if (!arenaRecordAddressOk(recordId)) throw new WorkError('invalid', 'recordId 形状不合法');
  assertRecordHome(host, recordId);
  const absPath = recordAbsPathOf(host, recordId);
  const text = readOrdinaryFile(absPath, recordId === LEGACY_RECORD_ID ? LEGACY_FILE_NAME : `${recordId}.json`);
  if (text === null) return { kind: 'missing' };
  const revision = hashText(text);
  const raw = parseJson(text, recordId === LEGACY_RECORD_ID ? LEGACY_FILE_NAME : `${recordId}.json`);
  const fileName = recordId === LEGACY_RECORD_ID ? LEGACY_FILE_NAME : `${recordId}.json`;

  const parsed = parseArenaRecordFile(raw);
  if (parsed.ok) {
    if (parsed.record.recordId !== recordId) {
      throw new WorkError('conflict', `存档正文的 recordId（${parsed.record.recordId}）与寻址不一致`);
    }
    if (parsed.record.contestId !== host.contestId) {
      throw new WorkError('conflict', '存档正文的 contestId 与宿主比赛不一致');
    }
    if (parsed.record.arenaPath !== host.arenaPath) {
      throw new WorkError('conflict', '存档正文的 arenaPath 与宿主比赛不一致');
    }
    return { kind: 'record', record: parsed.record, revision, text, fileName, absPath };
  }

  if (recordId !== LEGACY_RECORD_ID) {
    throw new WorkError('internal', `存档文件不合法：${parsed.message}`);
  }
  const legacy = parseWorkArenaRecord(raw);
  if (!legacy.ok) throw new WorkError('internal', `旧存档不合法：${legacy.message}`);
  if (legacy.record.arenaPath !== host.arenaPath) {
    throw new WorkError('conflict', '旧存档的 arenaPath 与宿主比赛不一致');
  }
  return {
    kind: legacy.record.view.mode === 'review' ? 'legacy-review' : 'legacy-live',
    record: legacy.record,
    revision,
    text,
    fileName,
    absPath,
  };
}

/* ---------- 缓存榜单校验（服务端不发起上游请求） ---------- */

export interface CachedContestInfo {
  problemCount: number;
  durationMs: number;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

function tupleMs(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (Array.isArray(input)) {
    const n = Number(input[0]);
    if (!Number.isFinite(n)) return null;
    const unit = typeof input[1] === 'string' ? input[1] : 'ms';
    return Math.round(n * (UNIT_MS[unit] ?? 1));
  }
  return null;
}

/** 读 `vault/arena/<arenaPath>` 的题数与时长；缺失 / 不可解析返回 null（保存时拒绝） */
export function readCachedContestInfo(arenaDir: string, arenaPath: string): CachedContestInfo | null {
  const file = join(arenaDir, arenaPath);
  const st = lstatOrNull(file);
  if (st === null || st.isSymbolicLink() || !st.isFile()) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { problems?: unknown; contest?: { duration?: unknown } };
    const problems = Array.isArray(doc.problems) ? doc.problems.length : 0;
    const durationMs = tupleMs(doc.contest?.duration);
    if (problems <= 0 || durationMs === null || durationMs <= 0) return null;
    return { problemCount: problems, durationMs };
  } catch {
    return null;
  }
}

function assertWritableResult(result: ArenaRecordResult): void {
  if (result.origin === 'legacy-review') {
    throw new WorkError('invalid', '结束时间未知的旧回顾不能作为新成绩保存；先确认已结束再编辑');
  }
}

function validateAgainstBoard(
  arenaDir: string,
  arenaPath: string,
  result: ArenaRecordResult,
  ghost: WorkArenaGhost,
): void {
  const info = readCachedContestInfo(arenaDir, arenaPath);
  if (info === null) {
    throw new WorkError('conflict', '这场还没有可用的榜单缓存；先打开榜单加载，再保存成绩');
  }
  if (result.durationMs !== info.durationMs) {
    throw new WorkError('conflict', '本场时长与榜单缓存不一致；重新载入榜单后再保存');
  }
  for (const sub of ghost.subs) {
    if (sub.p >= info.problemCount) {
      throw new WorkError('invalid', `第 ${sub.p + 1} 题超出本场题数（${info.problemCount} 题）`);
    }
    if (sub.t * 60_000 > info.durationMs) {
      throw new WorkError('invalid', `提交时刻 ${sub.t}′ 超过本场时长 ${Math.floor(info.durationMs / 60_000)}′`);
    }
  }
}

/* ---------- 列表 ---------- */

/**
 * 列表由存档文件派生：`.anvil-records` 里合法 schema 2 + 根文件（schema 2 或 schema 1 review 投影），
 * 旧 schema 1 live 只进 `legacy`。损坏项单独报错，其它合法档照常返回。
 */
export function scanContestRecords(host: RecordHostInfo): ArenaRecordsListDto {
  const records: ArenaRecordSummaryDto[] = [];
  const errors: ArenaRecordErrorDto[] = [];
  let legacy: ArenaLegacySummaryDto | null = null;

  const collect = (record: ArenaRecord, revision: string): void => {
    records.push(summaryOfArenaRecord(record, revision));
  };

  const readInto = (fileName: string, absPath: string, recordIdHint: string | null): void => {
    let text: string;
    try {
      const st = lstatOrNull(absPath);
      if (st === null) return;
      if (st.isSymbolicLink() || !st.isFile()) {
        errors.push({ file: fileName, message: '必须是普通文件，不允许符号链接' });
        return;
      }
      if (st.size > ARENA_RECORD_FILE_MAX_BYTES) {
        errors.push({ file: fileName, message: '超过 1 MiB，不能在 ANVIL 里读写' });
        return;
      }
      text = readFileSync(absPath, 'utf8');
    } catch (err) {
      errors.push({ file: fileName, message: `读取失败：${asError(err).message}` });
      return;
    }
    const revision = hashText(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      errors.push({ file: fileName, message: `不是合法 JSON：${asError(err).message}` });
      return;
    }
    const parsed = parseArenaRecordFile(raw);
    if (parsed.ok) {
      const expectedId = recordIdHint ?? LEGACY_RECORD_ID;
      if (parsed.record.recordId !== expectedId) {
        errors.push({ file: fileName, message: '正文 recordId 与文件名 / 根文件身份不一致' });
        return;
      }
      if (parsed.record.contestId !== host.contestId || parsed.record.arenaPath !== host.arenaPath) {
        errors.push({ file: fileName, message: '正文场次 / 宿主与比赛不一致' });
        return;
      }
      collect(parsed.record, revision);
      return;
    }
    if (recordIdHint !== null) {
      errors.push({ file: fileName, message: parsed.message });
      return;
    }
    const legacyParsed = parseWorkArenaRecord(raw);
    if (!legacyParsed.ok) {
      errors.push({ file: fileName, message: legacyParsed.message });
      return;
    }
    if (legacyParsed.record.arenaPath !== host.arenaPath) {
      errors.push({ file: fileName, message: '旧存档的 arenaPath 与宿主比赛不一致' });
      return;
    }
    if (legacyParsed.record.view.mode === 'live') {
      // 旧 live 只有一份，按契约只披露为旧进度，不计数、不投影成正式档
      if (legacy === null) {
        legacy = {
          mode: 'live',
          savedAt: legacyParsed.record.savedAt,
          submissionCount: legacyParsed.record.ghost.subs.length,
          revision,
        };
      } else {
        errors.push({ file: fileName, message: '旧进度重复出现，只保留一条' });
      }
      return;
    }
    collect(projectLegacyReview(legacyParsed.record, host.contestId), revision);
  };

  const rootFile = join(host.contestAbs, LEGACY_FILE_NAME);
  readInto(LEGACY_FILE_NAME, rootFile, null);

  const dir = recordsDirOf(host.contestAbs);
  const dirStat = lstatOrNull(dir);
  if (dirStat !== null) {
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      errors.push({ file: RECORDS_DIR_NAME, message: '必须是比赛目录里的普通目录，不允许符号链接' });
    } else {
      assertNoSymlinkComponents(host.root, host.contestAbs);
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        errors.push({ file: RECORDS_DIR_NAME, message: `目录读不出来：${asError(err).message}` });
        entries = [];
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          errors.push({ file: `${RECORDS_DIR_NAME}/${entry.name}`, message: '存档目录里只能有普通文件' });
          continue;
        }
        const match = /^(rec_[0-9a-f]{32})\.json$/.exec(entry.name);
        if (match === null) {
          errors.push({ file: `${RECORDS_DIR_NAME}/${entry.name}`, message: '未知文件，不接管也不覆盖' });
          continue;
        }
        readInto(`${RECORDS_DIR_NAME}/${entry.name}`, join(dir, entry.name), match[1]!);
      }
    }
  }

  records.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  });
  errors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return { contestId: host.contestId, records, legacy, errors };
}

/* ---------- 写入 ---------- */

function writeRecordFile(host: RecordHostInfo, record: ArenaRecord, recordId: string): { record: ArenaRecord; revision: string } {
  assertNoSymlinkComponents(host.root, host.contestAbs);
  if (recordId !== LEGACY_RECORD_ID) {
    const dir = recordsDirOf(host.contestAbs);
    const st = lstatOrNull(dir);
    if (st === null) {
      try {
        mkdirSync(dir);
      } catch (err) {
        throw new WorkError('internal', `创建存档目录失败：${asError(err).message}`);
      }
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorkError('unsafe-path', `${RECORDS_DIR_NAME} 必须是普通目录`);
    }
    assertNoSymlinkComponents(host.root, dir);
  }
  const absPath = recordAbsPathOf(host, recordId);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  try {
    writeFileAtomic(absPath, text);
  } catch (err) {
    throw new WorkError('internal', `存档写入失败：${asError(err).message}`);
  }
  return { record, revision: hashText(text) };
}

export interface CreateRecordOutcome {
  created: boolean;
  record: ArenaRecord;
  revision: string;
}

export function createRecordFile(
  host: RecordHostInfo,
  input: ArenaRecordCreateInput,
  opts: { now: Date; arenaDir: string; trashedRecordIds: ReadonlySet<string> },
): CreateRecordOutcome {
  if (!arenaRecordAddressOk(input.recordId) || input.recordId === LEGACY_RECORD_ID) {
    throw new WorkError('invalid', 'recordId 必须是 rec_ 加 32 位小写十六进制');
  }
  const name = normalizeArenaRecordName(input.name);
  if (!name.ok) throw new WorkError('invalid', name.message);
  const result = parseArenaRecordResult(input.result);
  if (!result.ok) throw new WorkError('invalid', result.message);
  const ghost = parseWorkArenaGhost(input.ghost);
  if (!ghost.ok) throw new WorkError('invalid', ghost.message);
  assertWritableResult(result.result);

  // 先对账同 ID：响应丢失后的重试不依赖榜单缓存仍然存在（契约 §5.3）
  if (opts.trashedRecordIds.has(input.recordId)) {
    throw new WorkError('conflict', '这份存档在回收站里；先恢复它再保存');
  }
  const existing = readRecordFile(host, input.recordId);
  if (existing.kind !== 'missing') {
    if (existing.kind === 'record') {
      const same = arenaRecordContentEquals(
        { name: existing.record.name, result: existing.record.result, ghost: existing.record.ghost },
        { name: name.name, result: result.result, ghost: ghost.ghost },
      );
      if (same) return { created: false, record: existing.record, revision: existing.revision };
      throw new WorkError('conflict', '同 ID 的存档已存在且内容不同，不能覆盖');
    }
    throw new WorkError('conflict', '同 ID 的存档已存在，不能覆盖');
  }

  validateAgainstBoard(opts.arenaDir, host.arenaPath, result.result, ghost.ghost);

  const nowIso = opts.now.toISOString();
  const record: ArenaRecord = {
    schema: 2,
    recordId: input.recordId,
    contestId: host.contestId,
    arenaPath: host.arenaPath,
    name: name.name,
    createdAt: nowIso,
    updatedAt: nowIso,
    result: result.result,
    ghost: ghost.ghost,
  };
  const written = writeRecordFile(host, record, input.recordId);
  return { created: true, ...written };
}

export function updateRecordFile(
  host: RecordHostInfo,
  input: ArenaRecordUpdateInput,
  opts: { now: Date; arenaDir: string },
): { record: ArenaRecord; revision: string } {
  const read = readRecordFile(host, input.recordId);
  if (read.kind === 'missing') throw new WorkError('not-found', '找不到这份存档');
  if (read.kind === 'legacy-live') {
    throw new WorkError('conflict', '旧进度不能直接编辑；先恢复为当前练习');
  }
  if (read.revision !== input.expectedRevision) {
    throw new WorkError('conflict', '这份存档在别处改过了，重新载入后再保存');
  }
  const result = parseArenaRecordResult(input.result);
  if (!result.ok) throw new WorkError('invalid', result.message);
  const ghost = parseWorkArenaGhost(input.ghost);
  if (!ghost.ok) throw new WorkError('invalid', ghost.message);
  assertWritableResult(result.result);
  validateAgainstBoard(opts.arenaDir, host.arenaPath, result.result, ghost.ghost);

  const nowIso = opts.now.toISOString();
  const base =
    read.kind === 'legacy-review'
      ? {
          // 旧 review 编辑前已由界面确认结束；根路径原子升级为 schema 2
          name: legacyArenaRecordName(read.record.savedAt),
          createdAt: read.record.savedAt,
        }
      : { name: read.record.name, createdAt: read.record.createdAt };
  const record: ArenaRecord = {
    schema: 2,
    recordId: input.recordId,
    contestId: host.contestId,
    arenaPath: host.arenaPath,
    name: base.name,
    createdAt: base.createdAt,
    updatedAt: nowIso,
    result: result.result,
    ghost: ghost.ghost,
  };
  return writeRecordFile(host, record, input.recordId);
}

export function renameRecordFile(
  host: RecordHostInfo,
  input: ArenaRecordRenameInput,
  opts: { now: Date },
): { record: ArenaRecord; revision: string } {
  if (host.effectiveArchived) throw new WorkError('conflict', '已归档的比赛不能管理存档；先取消归档');
  const read = readRecordFile(host, input.recordId);
  if (read.kind === 'missing') throw new WorkError('not-found', '找不到这份存档');
  if (read.kind === 'legacy-live') {
    throw new WorkError('conflict', '旧进度不能改名；先恢复为当前练习');
  }
  if (read.revision !== input.expectedRevision) {
    throw new WorkError('conflict', '这份存档在别处改过了，重新载入后再改名');
  }
  const name = normalizeArenaRecordName(input.name);
  if (!name.ok) throw new WorkError('invalid', name.message);

  const nowIso = opts.now.toISOString();
  const record: ArenaRecord =
    read.kind === 'legacy-review'
      ? {
          schema: 2,
          recordId: LEGACY_RECORD_ID,
          contestId: host.contestId,
          arenaPath: host.arenaPath,
          name: name.name,
          createdAt: read.record.savedAt,
          updatedAt: nowIso,
          // 仅改名不把旧回顾伪装成完赛：保留 legacy-review / unknown
          result: { origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null },
          ghost: read.record.ghost,
        }
      : {
          ...read.record,
          name: name.name,
          updatedAt: nowIso,
        };
  return writeRecordFile(host, record, input.recordId);
}

/* ---------- 单档回收站 ---------- */

export interface RecordTrashManifest {
  schema: 2;
  entryType: 'arena-record';
  id: string;
  recordId: string;
  contestId: string;
  arenaPath: string;
  title: string;
  trashedAt: string;
  originalRelPath: string;
  fileName: string;
}

const REL_SEG_BAD = new Set(['', '.', '..']);

function relativePosixOk(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((seg) => !REL_SEG_BAD.has(seg));
}

export function parseRecordTrashManifest(input: unknown): { ok: true; manifest: RecordTrashManifest } | { ok: false; message: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: '回收清单不是对象' };
  }
  const v = input as Record<string, unknown>;
  if (v.schema !== 2 || v.entryType !== 'arena-record') return { ok: false, message: '不是成绩存档的回收清单' };
  if (!arenaTrashIdOk(v.id)) return { ok: false, message: 'trashId 形状不合法' };
  if (!arenaRecordAddressOk(v.recordId)) return { ok: false, message: 'recordId 形状不合法' };
  if (!workIdOk(v.contestId)) return { ok: false, message: 'contestId 形状不合法' };
  if (typeof v.arenaPath !== 'string' || !contestPathOk(v.arenaPath)) {
    return { ok: false, message: 'arenaPath 不合法' };
  }
  if (typeof v.title !== 'string' || v.title.trim() === '') return { ok: false, message: 'title 缺失' };
  if (typeof v.trashedAt !== 'string' || Number.isNaN(Date.parse(v.trashedAt))) {
    return { ok: false, message: 'trashedAt 不是合法时间' };
  }
  if (typeof v.originalRelPath !== 'string' || !relativePosixOk(v.originalRelPath)) {
    return { ok: false, message: 'originalRelPath 不是合法相对路径' };
  }
  if (typeof v.fileName !== 'string') return { ok: false, message: 'fileName 缺失' };
  if (v.fileName !== recordFileNameOf(v.recordId as string)) {
    return { ok: false, message: 'fileName 与 recordId 的恢复位置不一致' };
  }
  return {
    ok: true,
    manifest: {
      schema: 2,
      entryType: 'arena-record',
      id: v.id,
      recordId: v.recordId as string,
      contestId: v.contestId,
      arenaPath: v.arenaPath,
      title: v.title,
      trashedAt: v.trashedAt,
      originalRelPath: v.originalRelPath,
      fileName: v.fileName,
    },
  };
}

export function trashRecordFile(
  host: RecordHostInfo,
  input: { recordId: string; expectedRevision: string },
  opts: { now: Date; trashRoot: string; trashId: string },
): { trashId: string; trashName: string; fileName: string } {
  if (host.effectiveArchived) throw new WorkError('conflict', '已归档的比赛不能管理存档；先取消归档');
  const read = readRecordFile(host, input.recordId);
  if (read.kind === 'missing') throw new WorkError('not-found', '找不到这份存档');
  if (read.revision !== input.expectedRevision) {
    throw new WorkError('conflict', '这份存档在别处改过了，重新载入后再删除');
  }

  const rootStat = lstatOrNull(opts.trashRoot);
  if (rootStat === null) {
    try {
      mkdirSync(opts.trashRoot, { recursive: true });
    } catch (err) {
      throw new WorkError('internal', `创建回收站失败：${asError(err).message}`);
    }
  } else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorkError('unsafe-path', '回收站必须是受管根内的普通目录');
  }

  const stamp = localTrashStamp(opts.now);
  let trashName = `${stamp}_${opts.trashId}`;
  for (let i = 2; lstatOrNull(join(opts.trashRoot, trashName)) !== null; i += 1) {
    trashName = `${stamp}_${opts.trashId}-${i}`;
  }
  const wrapper = join(opts.trashRoot, trashName);
  try {
    mkdirSync(wrapper);
  } catch (err) {
    throw new WorkError('internal', `创建回收条目录失败：${asError(err).message}`);
  }

  const readRecordTitle =
    read.kind === 'record'
      ? read.record.name
      : read.kind === 'legacy-review'
        ? legacyArenaRecordName(read.record.savedAt)
        : `旧进度 ${read.record.savedAt}`;
  const manifest: RecordTrashManifest = {
    schema: 2,
    entryType: 'arena-record',
    id: opts.trashId,
    recordId: input.recordId,
    contestId: host.contestId,
    arenaPath: host.arenaPath,
    title: readRecordTitle,
    trashedAt: opts.now.toISOString(),
    originalRelPath: host.contestRelPath,
    fileName: read.fileName,
  };

  const target = join(wrapper, read.fileName);
  try {
    renameSync(read.absPath, target);
  } catch (err) {
    try {
      rmdirSync(wrapper);
    } catch {
      /* 空目录删不掉就留着，恢复入口仍按清单 */
    }
    throw new WorkError('internal', `移入回收站失败：${asError(err).message}`);
  }
  try {
    writeFileAtomic(join(wrapper, 'trash.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    try {
      renameSync(target, read.absPath);
      rmdirSync(wrapper);
    } catch {
      /* 至少有一份完整内容留在回收位置 */
    }
    throw new WorkError('internal', `回收清单写入失败：${asError(err).message}`);
  }
  return { trashId: opts.trashId, trashName, fileName: read.fileName };
}

export function restoreRecordFile(
  host: RecordHostInfo,
  trashAbs: string,
  manifest: RecordTrashManifest,
): ArenaRecordRestoreResult {
  if (host.effectiveArchived) throw new WorkError('conflict', '已归档的比赛不能恢复存档；先取消归档');
  assertNoSymlinkComponents(host.root, host.contestAbs);
  const source = join(trashAbs, manifest.fileName);
  const sourceStat = lstatOrNull(source);
  if (sourceStat === null || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new WorkError('not-found', '回收条目里找不到存档文件');
  }
  if (sourceStat.size > ARENA_RECORD_FILE_MAX_BYTES) {
    throw new WorkError('invalid', '回收里的存档超过 1 MiB，拒绝恢复');
  }
  // 恢复前先读一遍：清单说的 ID / 场次与文件正文不一致时，不把坏档搬回比赛目录
  let sourceRaw: unknown;
  try {
    sourceRaw = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    throw new WorkError('internal', '回收里的存档读不出来，未恢复');
  }
  const sourceRecord = parseArenaRecordFile(sourceRaw);
  if (sourceRecord.ok) {
    if (sourceRecord.record.recordId !== manifest.recordId || sourceRecord.record.arenaPath !== manifest.arenaPath) {
      throw new WorkError('conflict', '回收清单与存档正文不一致，未恢复');
    }
  } else {
    const sourceLegacy = parseWorkArenaRecord(sourceRaw);
    if (!sourceLegacy.ok || manifest.recordId !== LEGACY_RECORD_ID) {
      throw new WorkError('internal', '回收里的旧存档不合法，未恢复');
    }
    if (sourceLegacy.record.arenaPath !== manifest.arenaPath) {
      throw new WorkError('conflict', '回收清单与旧存档正文不一致，未恢复');
    }
  }

  if (manifest.recordId === LEGACY_RECORD_ID) {
    if (manifest.fileName !== LEGACY_FILE_NAME) {
      throw new WorkError('invalid', 'legacy 只能回到比赛根目录的 record.json');
    }
  } else {
    if (manifest.fileName !== `${manifest.recordId}.json`) {
      throw new WorkError('invalid', '存档文件名与 recordId 不一致');
    }
    const dir = recordsDirOf(host.contestAbs);
    const dirStat = lstatOrNull(dir);
    if (dirStat === null) {
      try {
        mkdirSync(dir);
      } catch (err) {
        throw new WorkError('internal', `创建存档目录失败：${asError(err).message}`);
      }
    } else if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new WorkError('unsafe-path', `${RECORDS_DIR_NAME} 必须是普通目录`);
    }
    assertNoSymlinkComponents(host.root, dir);
  }

  const target = recordAbsPathOf(host, manifest.recordId);
  if (lstatOrNull(target) !== null) {
    throw new WorkError('path-occupied', '原位置已有同名存档，不能自动覆盖');
  }
  try {
    renameSync(source, target);
  } catch (err) {
    throw new WorkError('internal', `恢复存档失败：${asError(err).message}`);
  }
  for (const leftover of ['trash.json']) {
    try {
      unlinkSync(join(trashAbs, leftover));
    } catch {
      /* 清单删不掉不影响文件已回到原位 */
    }
  }
  try {
    rmdirSync(trashAbs);
  } catch {
    /* 回收目录里还有别的文件就留着，不递归删未知内容 */
  }

  const restored = readRecordFile(host, manifest.recordId);
  if (restored.kind === 'missing') throw new WorkError('internal', '恢复后找不到存档文件');
  if (restored.kind === 'legacy-live') {
    return {
      restored: 'legacy-progress',
      legacy: { mode: 'live', record: restored.record, revision: restored.revision } satisfies ArenaLegacyRecordDto,
    };
  }
  if (restored.kind === 'legacy-review') {
    return {
      restored: 'record',
      record: projectLegacyReview(restored.record, host.contestId),
      revision: restored.revision,
    };
  }
  return { restored: 'record', record: restored.record, revision: restored.revision };
}

/* 兼容旧的「按 arenaPath 直接取唯一档」旁路已移除：所有读取都走 recordId / legacy。 */
