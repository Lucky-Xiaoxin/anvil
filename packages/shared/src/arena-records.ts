/**
 * 榜单多存档（docs/contracts/29）：schema 2 正式档、结束状态合法组合、旧 schema 1 兼容投影、
 * 单档回收条目与命名规则。服务端只做 IO，判据留在这里，前端不重复实现一套。
 */
import { contestPathOk } from './arena-path.ts';
import { civilDay, clockOf, formatDay } from './days.ts';
import {
  isIsoTime,
  parseWorkArenaGhost,
  workIdOk,
  type WorkArenaGhost,
  type WorkArenaRecordDto,
  type WorkObjectDto,
} from './work.ts';

export type ArenaRecordOrigin = 'timed' | 'manual' | 'legacy-review';
export type ArenaRecordFinish = 'time-limit' | 'stopped' | 'declared' | 'unknown';

/** 结束信息与成绩同属一份存档；合法组合见 parseArenaRecordResult */
export interface ArenaRecordResult {
  origin: ArenaRecordOrigin;
  finish: ArenaRecordFinish;
  /** 本场时长；新档必须是正安全整数，旧数据无法确定时为 null */
  durationMs: number | null;
  /** 模拟停止位置；补录与旧来源不伪造，填 null */
  stoppedAtMs: number | null;
}

export interface ArenaRecord {
  schema: 2;
  recordId: string;
  contestId: string;
  arenaPath: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  result: ArenaRecordResult;
  ghost: WorkArenaGhost;
}

export const LEGACY_RECORD_ID = 'legacy';
/** 新档 ID：rec_ + 32 位小写十六进制 */
export const ARENA_RECORD_ID_RE = /^rec_[0-9a-f]{32}$/;
/** 寻址（读 / 更新 / 改名 / 回收）额外接受旧根文件的保留 ID */
export const ARENA_RECORD_ADDRESS_RE = /^(rec_[0-9a-f]{32}|legacy)$/;
/** 回收条目 ID：tr_ + 32 位小写十六进制 */
export const ARENA_TRASH_ID_RE = /^tr_[0-9a-f]{32}$/;
export const ARENA_RECORD_NAME_MAX = 120;
/** 成绩写接口 bodyLimit：最多 5000 发的逐发清单要放得下 */
export const ARENA_RECORD_FILE_MAX_BYTES = 1024 * 1024;

export function arenaRecordIdOk(v: unknown): v is string {
  return typeof v === 'string' && ARENA_RECORD_ID_RE.test(v);
}

export function arenaRecordAddressOk(v: unknown): v is string {
  return typeof v === 'string' && ARENA_RECORD_ADDRESS_RE.test(v);
}

export function arenaTrashIdOk(v: unknown): v is string {
  return typeof v === 'string' && ARENA_TRASH_ID_RE.test(v);
}

const ORIGINS: readonly ArenaRecordOrigin[] = ['timed', 'manual', 'legacy-review'];
const FINISHES: readonly ArenaRecordFinish[] = ['time-limit', 'stopped', 'declared', 'unknown'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const isNonNegativeMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export type ArenaRecordResultParse =
  | { ok: true; result: ArenaRecordResult }
  | { ok: false; message: string };

/**
 * 结束状态合法组合（契约 §4.2）：timed 必须有时长；time-limit 的停止位置等于时长；
 * stopped 不超过时长；manual 只有 declared 且停止位置为 null；legacy-review 只有 unknown。
 * 新创建 / 修改不许使用 legacy-review（见 §4.2 与 §7.1 的显式转换）。
 */
export function parseArenaRecordResult(input: unknown): ArenaRecordResultParse {
  if (!isRecord(input)) return { ok: false, message: 'result 必须是对象' };
  const origin = input.origin;
  const finish = input.finish;
  if (typeof origin !== 'string' || !(ORIGINS as readonly string[]).includes(origin)) {
    return { ok: false, message: 'result.origin 不合法' };
  }
  if (typeof finish !== 'string' || !(FINISHES as readonly string[]).includes(finish)) {
    return { ok: false, message: 'result.finish 不合法' };
  }
  const durationMs = input.durationMs === undefined ? null : input.durationMs;
  const stoppedAtMs = input.stoppedAtMs === undefined ? null : input.stoppedAtMs;
  if (durationMs !== null && !isPositiveMs(durationMs)) {
    return { ok: false, message: 'result.durationMs 必须是正安全整数或 null' };
  }
  if (stoppedAtMs !== null && !isNonNegativeMs(stoppedAtMs)) {
    return { ok: false, message: 'result.stoppedAtMs 必须是非负安全整数或 null' };
  }

  const result = (): ArenaRecordResult => ({
    origin: origin as ArenaRecordOrigin,
    finish: finish as ArenaRecordFinish,
    durationMs,
    stoppedAtMs,
  });

  if (origin === 'timed') {
    if (finish !== 'time-limit' && finish !== 'stopped') {
      return { ok: false, message: 'timed 只能配 time-limit 或 stopped' };
    }
    if (durationMs === null) return { ok: false, message: 'timed 成绩缺少本场时长' };
    if (finish === 'time-limit' && stoppedAtMs !== durationMs) {
      return { ok: false, message: '到时候结束的停止位置必须等于本场时长' };
    }
    if (finish === 'stopped') {
      if (stoppedAtMs === null) return { ok: false, message: '提前结束缺少停止位置' };
      if (stoppedAtMs > durationMs) return { ok: false, message: '停止位置不能超过本场时长' };
    }
    return { ok: true, result: result() };
  }

  if (origin === 'manual') {
    if (finish !== 'declared') return { ok: false, message: '补录成绩只能是 declared' };
    if (durationMs === null) return { ok: false, message: '补录成绩缺少本场时长' };
    if (stoppedAtMs !== null) return { ok: false, message: '补录成绩不能伪造停止位置' };
    return { ok: true, result: result() };
  }

  if (finish !== 'unknown') return { ok: false, message: '旧回顾只能是 unknown 结束状态' };
  if (stoppedAtMs !== null) return { ok: false, message: '旧回顾不能伪造停止位置' };
  return { ok: true, result: result() };
}

/** 正式档写入前只允许 timed / manual；legacy-review 只能来自旧档只读投影或仅改名升级 */
export function arenaRecordWritableResult(result: ArenaRecordResult): boolean {
  return result.origin !== 'legacy-review';
}

export type ArenaRecordParseResult =
  | { ok: true; record: ArenaRecord }
  | { ok: false; message: string };

/** `.anvil-records/<recordId>.json` 与升级后的根 `record.json` 共用这一份校验 */
export function parseArenaRecordFile(input: unknown): ArenaRecordParseResult {
  if (!isRecord(input)) return { ok: false, message: '存档不是对象' };
  if (input.schema !== 2) return { ok: false, message: `不支持的存档 schema：${String(input.schema)}` };
  if (!arenaRecordAddressOk(input.recordId)) return { ok: false, message: 'recordId 形状不合法' };
  if (!workIdOk(input.contestId)) return { ok: false, message: 'contestId 形状不合法' };
  if (typeof input.arenaPath !== 'string' || !contestPathOk(input.arenaPath)) {
    return { ok: false, message: '存档 arenaPath 不合法' };
  }
  const name = normalizeArenaRecordName(input.name);
  if (!name.ok) return name;
  if (!isIsoTime(input.createdAt)) return { ok: false, message: 'createdAt 不是合法时间' };
  if (!isIsoTime(input.updatedAt)) return { ok: false, message: 'updatedAt 不是合法时间' };
  const result = parseArenaRecordResult(input.result);
  if (!result.ok) return result;
  const ghost = parseWorkArenaGhost(input.ghost);
  if (!ghost.ok) return ghost;
  return {
    ok: true,
    record: {
      schema: 2,
      recordId: input.recordId,
      contestId: input.contestId,
      arenaPath: input.arenaPath,
      name: name.name,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      result: result.result,
      ghost: ghost.ghost,
    },
  };
}

export type ArenaRecordNameParse =
  | { ok: true; name: string }
  | { ok: false; message: string };

/** 名称去首尾空白、1–120 字符；可重名，名称不参与文件路径 */
export function normalizeArenaRecordName(input: unknown): ArenaRecordNameParse {
  if (typeof input !== 'string') return { ok: false, message: '存档名称必须是字符串' };
  const name = input.trim();
  if (name.length < 1) return { ok: false, message: '存档名称不能为空' };
  if (name.length > ARENA_RECORD_NAME_MAX) {
    return { ok: false, message: `存档名称太长（${name.length} > ${ARENA_RECORD_NAME_MAX}）` };
  }
  return { ok: true, name };
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** 上海时钟读数（与全站时间口径一致）：`2026-10-29 21:30` */
export function arenaStampOf(date: Date): string {
  const { hour, minute } = clockOf(date);
  return `${formatDay(civilDay(date))} ${p2(hour)}:${p2(minute)}`;
}

/** 首次保存的默认名称：本地日期 时间 */
export function defaultArenaRecordName(date: Date): string {
  return arenaStampOf(date);
}

/** 旧 review 的默认名称：旧存档 + 原 savedAt */
export function legacyArenaRecordName(savedAt: string): string {
  const at = Date.parse(savedAt);
  return Number.isNaN(at) ? '旧存档' : `旧存档 ${arenaStampOf(new Date(at))}`;
}

/** 另存默认名称：原名称 副本；超长时截原名称而不是截后缀 */
export function copyArenaRecordName(name: string): string {
  const suffix = ' 副本';
  const head =
    name.length + suffix.length > ARENA_RECORD_NAME_MAX
      ? name.slice(0, ARENA_RECORD_NAME_MAX - suffix.length).trimEnd()
      : name;
  return `${head}${suffix}`;
}

export function arenaRecordResultEquals(a: ArenaRecordResult, b: ArenaRecordResult): boolean {
  return (
    a.origin === b.origin &&
    a.finish === b.finish &&
    a.durationMs === b.durationMs &&
    a.stoppedAtMs === b.stoppedAtMs
  );
}

/** 逐发比较：题序不参与，结果与时刻都算；show 属于 ghost，也参与比较 */
export function arenaGhostEquals(a: WorkArenaGhost, b: WorkArenaGhost): boolean {
  if (a.show !== b.show || a.subs.length !== b.subs.length) return false;
  const key = (g: WorkArenaGhost): string =>
    [...g.subs].sort((x, y) => x.p - y.p || x.t - y.t).map((s) => `${s.p}:${s.t}:${s.r}`).join(',');
  return key(a) === key(b);
}

export interface ArenaRecordContent {
  name: string;
  result: ArenaRecordResult;
  ghost: WorkArenaGhost;
}

/** 新建幂等内容：name / result / ghost 规范化后一致（时间戳与 contestTitle 不参与） */
export function arenaRecordContentEquals(a: ArenaRecordContent, b: ArenaRecordContent): boolean {
  return a.name === b.name && arenaRecordResultEquals(a.result, b.result) && arenaGhostEquals(a.ghost, b.ghost);
}

/* ---------- DTO ---------- */

export interface ArenaRecordSummaryDto {
  recordId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  result: ArenaRecordResult;
  submissionCount: number;
  revision: string;
}

/** 旧 schema 1 live 的列表摘要；review 走 records 的只读投影，不进这里 */
export interface ArenaLegacySummaryDto {
  mode: 'live';
  savedAt: string;
  submissionCount: number;
  revision: string;
}

export interface ArenaRecordErrorDto {
  /** 相对比赛目录的文件名（如 `rec_….json` / `record.json`） */
  file: string;
  message: string;
}

export interface ArenaRecordsListDto {
  contestId: string | null;
  records: ArenaRecordSummaryDto[];
  legacy: ArenaLegacySummaryDto | null;
  errors: ArenaRecordErrorDto[];
}

export interface ArenaRecordItemDto {
  record: ArenaRecord;
  revision: string;
}

/** 旧根文件的完整原格式（只读，不迁移、不续钟）；列表只披露 live，review 走 records 投影 */
export interface ArenaLegacyRecordDto {
  mode: 'review' | 'live';
  record: WorkArenaRecordDto;
  revision: string;
}

export interface ArenaRecordCreateInput {
  arenaPath: string;
  contestTitle?: string;
  recordId: string;
  name: string;
  result: ArenaRecordResult;
  ghost: WorkArenaGhost;
}

export interface ArenaRecordCreateResult {
  record: ArenaRecord;
  revision: string;
  object: WorkObjectDto;
}

export interface ArenaRecordUpdateInput {
  arenaPath: string;
  recordId: string;
  expectedRevision: string;
  result: ArenaRecordResult;
  ghost: WorkArenaGhost;
}

export interface ArenaRecordRenameInput {
  arenaPath: string;
  recordId: string;
  expectedRevision: string;
  name: string;
}

export interface ArenaRecordTrashInput {
  arenaPath: string;
  recordId: string;
  expectedRevision: string;
  confirm: true;
}

export interface ArenaRecordTrashResult {
  entryType: 'arena-record';
  trashId: string;
  recordId: string;
  trashName: string;
}

export interface ArenaRecordRestoreInput {
  trashId: string;
}

export type ArenaRecordRestoreResult =
  | { restored: 'record'; record: ArenaRecord; revision: string }
  | { restored: 'legacy-progress'; legacy: ArenaLegacyRecordDto };

/** 旧 review 的只读投影：identity 固定 legacy，两个时间沿用原 savedAt，结束状态 unknown */
export function projectLegacyReview(record: WorkArenaRecordDto, contestId: string): ArenaRecord {
  return {
    schema: 2,
    recordId: LEGACY_RECORD_ID,
    contestId,
    arenaPath: record.arenaPath,
    name: legacyArenaRecordName(record.savedAt),
    createdAt: record.savedAt,
    updatedAt: record.savedAt,
    result: { origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null },
    ghost: record.ghost,
  };
}

export function summaryOfArenaRecord(record: ArenaRecord, revision: string): ArenaRecordSummaryDto {
  return {
    recordId: record.recordId,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    result: record.result,
    submissionCount: record.ghost.subs.length,
    revision,
  };
}

/** 结束方式的界面读法（榜单 / 工坊共用一份） */
export function arenaResultLabel(result: ArenaRecordResult): string {
  if (result.origin === 'legacy-review') return '旧回顾 · 结束时间未知';
  if (result.origin === 'manual') return '补录 · 已结束';
  return result.finish === 'stopped' ? '模拟 · 提前结束' : '模拟 · 到时结束';
}
