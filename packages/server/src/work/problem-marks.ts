/**
 * 赛后题目标记的文件层（docs/contracts/30）：比赛目录根的 `problem-marks.json`、
 * revision（原文件字节 SHA-256）、原子写、宿主与 schema 核对、AC 预填。
 * 宿主查找、扫描汇总与写队列在 store.ts。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROBLEM_MARKS_FILE,
  PROBLEM_MARKS_FILE_MAX_BYTES,
  parseProblemMarksFile,
  parseProblemMarksInput,
  parseProblemSnapshot,
  prefillProblemMarks,
  problemMarkSummaryOf,
  problemMarksToJson,
  type ProblemMark,
  type ProblemMarkInput,
  type ProblemMarkSummary,
  type ProblemMarksDto,
  type ProblemMarksFile,
  type ProblemMarksProblem,
  type WorkArenaGhost,
} from '@anvil/shared';
import { writeFileAtomic } from '../atomic.ts';
import { WorkError } from './errors.ts';
import { assertNoSymlinkComponents, lstatOrNull } from './paths.ts';
import type { RecordHostInfo } from './records.ts';

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export function problemMarksAbsPath(host: RecordHostInfo): string {
  return join(host.contestAbs, PROBLEM_MARKS_FILE);
}

export type ProblemMarksRead =
  | { kind: 'missing' }
  | { kind: 'ok'; file: ProblemMarksFile; revision: string }
  | { kind: 'error'; message: string };

/** 读文件：不抛错，把损坏 / schema / 场次不一致收成 error，供详情与扫描各自处理 */
export function readProblemMarks(host: RecordHostInfo): ProblemMarksRead {
  assertNoSymlinkComponents(host.root, host.contestAbs);
  const abs = problemMarksAbsPath(host);
  const st = lstatOrNull(abs);
  if (st === null) return { kind: 'missing' };
  if (st.isSymbolicLink() || !st.isFile()) {
    return { kind: 'error', message: `${PROBLEM_MARKS_FILE} 必须是普通文件，不允许符号链接` };
  }
  if (st.size > PROBLEM_MARKS_FILE_MAX_BYTES) {
    return { kind: 'error', message: `${PROBLEM_MARKS_FILE} 超过 ${PROBLEM_MARKS_FILE_MAX_BYTES / 1024} KB，不能在 ANVIL 里读写` };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    return { kind: 'error', message: `${PROBLEM_MARKS_FILE} 读不出来：${asError(err).message}` };
  }
  const revision = createHash('sha256').update(bytes).digest('hex');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    return { kind: 'error', message: `${PROBLEM_MARKS_FILE} 不是合法 JSON：${asError(err).message}` };
  }
  const parsed = parseProblemMarksFile(raw, host.arenaPath);
  if (!parsed.ok) return { kind: 'error', message: parsed.message };
  return { kind: 'ok', file: parsed.file, revision };
}

/** 写接口用：文件损坏 / schema 过高 / 宿主不一致统一 409；安全边界仍是 unsafe-path */
function requireProblemMarks(host: RecordHostInfo): { file: ProblemMarksFile; revision: string } | null {
  const read = readProblemMarks(host);
  if (read.kind === 'missing') return null;
  if (read.kind === 'error') throw new WorkError('conflict', read.message);
  return { file: read.file, revision: read.revision };
}

function dtoOf(host: RecordHostInfo, file: ProblemMarksFile, revision: string): ProblemMarksDto {
  return {
    contestId: host.contestId,
    arenaPath: host.arenaPath,
    revision,
    problems: file.problems.map((p) => ({ ...p })),
    marks: cloneMarks(file.marks),
    ...(file.unreadableMarks > 0 ? { unreadableMarks: file.unreadableMarks } : {}),
  };
}

function cloneMarks(marks: Readonly<Record<string, ProblemMark>>): Record<string, ProblemMark> {
  const out: Record<string, ProblemMark> = {};
  for (const [alias, mark] of Object.entries(marks)) out[alias] = { ...mark, tags: [...mark.tags] };
  return out;
}

function sameMark(a: ProblemMarkInput, b: ProblemMark): boolean {
  return (
    a.progress === b.progress &&
    a.star === b.star &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, i) => tag === b.tags[i])
  );
}

function writeProblemMarks(host: RecordHostInfo, file: ProblemMarksFile): { file: ProblemMarksFile; revision: string } {
  assertNoSymlinkComponents(host.root, host.contestAbs);
  const abs = problemMarksAbsPath(host);
  const st = lstatOrNull(abs);
  if (st !== null && (st.isSymbolicLink() || !st.isFile())) {
    throw new WorkError('unsafe-path', `${PROBLEM_MARKS_FILE} 必须是普通文件`);
  }
  const text = `${JSON.stringify(problemMarksToJson(file), null, 2)}\n`;
  try {
    writeFileAtomic(abs, text);
  } catch (err) {
    throw new WorkError('internal', `标记文件写入失败：${asError(err).message}`);
  }
  return { file: { ...file, raw: JSON.parse(text) as Record<string, unknown> }, revision: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export interface ProblemMarksSyncInput {
  problems: unknown;
  recordId?: string;
}

export interface ProblemMarksSyncOutcome {
  dto: ProblemMarksDto;
  created: boolean;
}

/**
 * 建立 / 更新题目清单快照；带 recordId 时按该存档 ghost 做 AC 预填。
 * alias 集合变化一律 409 problem-set-mismatch，不静默丢标记。
 */
export function syncProblemMarks(
  host: RecordHostInfo,
  input: ProblemMarksSyncInput,
  opts: { now: Date; readGhost: (recordId: string) => WorkArenaGhost | null },
): ProblemMarksSyncOutcome {
  const snapshot = parseProblemSnapshot(input.problems);
  if (!snapshot.ok) throw new WorkError('invalid', snapshot.message);
  const problems: ProblemMarksProblem[] = snapshot.problems;

  const existing = requireProblemMarks(host);
  let file: ProblemMarksFile;
  let created = false;
  if (existing === null) {
    created = true;
    file = {
      schema: 1,
      arenaPath: host.arenaPath,
      problems,
      marks: {},
      foreignMarks: {},
      prefillApplied: [],
      raw: {},
      unreadableMarks: 0,
    };
  } else {
    const oldAliases = new Set(existing.file.problems.map((p) => p.alias));
    const sameSet = oldAliases.size === problems.length && problems.every((p) => oldAliases.has(p.alias));
    if (!sameSet) {
      throw new WorkError('problem-set-mismatch', '这场已有题目清单，alias 集合与本次同步不一致；不静默丢弃标记');
    }
    file = {
      ...existing.file,
      problems,
      marks: cloneMarks(existing.file.marks),
      prefillApplied: [...existing.file.prefillApplied],
    };
  }

  if (input.recordId !== undefined) {
    const ghost = opts.readGhost(input.recordId);
    if (ghost !== null) {
      const prefilled = prefillProblemMarks(file, ghost.subs, opts.now.toISOString());
      if (prefilled.changed) {
        file = { ...file, marks: prefilled.marks, prefillApplied: prefilled.prefillApplied };
      }
    }
  }

  const unchanged =
    !created &&
    existing !== null &&
    JSON.stringify(existing.file.problems) === JSON.stringify(file.problems) &&
    JSON.stringify(existing.file.marks) === JSON.stringify(file.marks) &&
    JSON.stringify(existing.file.prefillApplied) === JSON.stringify(file.prefillApplied);

  if (unchanged && existing !== null) {
    return { dto: dtoOf(host, existing.file, existing.revision), created: false };
  }

  const written = writeProblemMarks(host, file);
  return { dto: dtoOf(host, written.file, written.revision), created };
}

export interface ProblemMarksUpdateInput {
  expectedRevision: string;
  marks: unknown;
}

export function updateProblemMarks(
  host: RecordHostInfo,
  input: ProblemMarksUpdateInput,
  opts: { now: Date },
): ProblemMarksDto {
  const existing = requireProblemMarks(host);
  if (existing === null) throw new WorkError('not-found', '这场比赛还没有题目清单；先同步题目');
  if (existing.revision !== input.expectedRevision) {
    throw new WorkError('conflict', '标记在别处改过了，重新载入后再改');
  }
  const parsed = parseProblemMarksInput(input.marks, existing.file.problems);
  if (!parsed.ok) throw new WorkError('invalid', parsed.message);

  const nowIso = opts.now.toISOString();
  const marks: Record<string, ProblemMark> = {};
  for (const [alias, next] of Object.entries(parsed.marks)) {
    const previous = existing.file.marks[alias];
    marks[alias] = {
      progress: next.progress,
      star: next.star,
      tags: [...next.tags],
      updatedAt: previous !== undefined && sameMark(next, previous) ? previous.updatedAt : nowIso,
    };
  }

  const file: ProblemMarksFile = {
    ...existing.file,
    marks,
    prefillApplied: [...existing.file.prefillApplied],
  };
  const written = writeProblemMarks(host, file);
  return dtoOf(host, written.file, written.revision);
}

/** 详情用：坏文件返回原因，不抛；没有文件返回 null */
export function problemMarksDetailOf(host: RecordHostInfo): { dto: ProblemMarksDto | null; error?: string } {
  const read = readProblemMarks(host);
  if (read.kind === 'missing') return { dto: null };
  if (read.kind === 'error') return { dto: null, error: read.message };
  return { dto: dtoOf(host, read.file, read.revision) };
}

/** 列表徽章用：坏文件 / 无文件都返回 null（不阻塞其它对象） */
export function problemMarkSummaryOfHost(host: RecordHostInfo): ProblemMarkSummary | null {
  try {
    const read = readProblemMarks(host);
    if (read.kind !== 'ok') return null;
    return problemMarkSummaryOf(read.file);
  } catch {
    return null;
  }
}

