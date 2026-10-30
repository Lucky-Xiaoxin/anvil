/**
 * 赛后题目标记（docs/contracts/30）：比赛级 `problem-marks.json` 的解析、标记清洗、AC 预填与汇总。
 * 文件是唯一真相；这里只做纯函数判据，服务端负责 IO / revision / 宿主核对。
 */
import { contestPathOk } from './arena-path.ts';
import { isIsoTime } from './work.ts';

export const PROBLEM_MARKS_FILE = 'problem-marks.json';
export const PROBLEM_MARKS_SCHEMA = 1;
export const PROBLEM_MARKS_FILE_MAX_BYTES = 256 * 1024;

export const PROBLEM_ALIAS_RE = /^[A-Za-z0-9_-]{1,8}$/;
export const PROBLEMS_MAX = 40;
export const PROBLEM_TITLE_MAX = 200;
export const PROBLEM_TAGS_MAX = 8;
export const PROBLEM_TAG_LEN_MAX = 24;
export const PROBLEM_TAGS_SUGGEST_MAX = 200;

export const PROBLEM_MARK_PROGRESS = ['todo', 'post-solved', 'contest-ac'] as const;
export type ProblemMarkProgress = (typeof PROBLEM_MARK_PROGRESS)[number];

export function isProblemMarkProgress(v: unknown): v is ProblemMarkProgress {
  return typeof v === 'string' && (PROBLEM_MARK_PROGRESS as readonly string[]).includes(v);
}

export const PROBLEM_PROGRESS_NAME: Record<ProblemMarkProgress, string> = {
  todo: '待补题',
  'post-solved': '已补',
  'contest-ac': '已过',
};

export interface ProblemMarksProblem {
  alias: string;
  title: string;
}

export interface ProblemMark {
  progress: ProblemMarkProgress | null;
  star: boolean;
  tags: string[];
  updatedAt: string;
}

/** 客户端提交的标记：不含服务端字段 */
export interface ProblemMarkInput {
  progress: ProblemMarkProgress | null;
  star: boolean;
  tags: string[];
}

export interface ProblemMarksFile {
  schema: 1;
  arenaPath: string;
  problems: ProblemMarksProblem[];
  /** 已知 alias 的规范化条目；三者全空的条目在这里不存在 */
  marks: Record<string, ProblemMark>;
  /** 文件里 alias 不在快照内的条目：不进入 DTO，重写时原样保留 */
  foreignMarks: Record<string, unknown>;
  /** 服务端内部：曾经自动预填过的 alias，只增不减；不进入 DTO */
  prefillApplied: string[];
  /** 未知顶层字段：重写时保留 */
  raw: Record<string, unknown>;
  /** 未知 alias 的条目数（界面提示“有标记未能读取”） */
  unreadableMarks: number;
}

export interface ProblemMarksDto {
  contestId: string;
  arenaPath: string;
  /** 原文件字节 SHA-256 */
  revision: string;
  problems: ProblemMarksProblem[];
  marks: Record<string, ProblemMark>;
  /** 快照外的标记条目数；> 0 时界面提示，文件本身不丢 */
  unreadableMarks?: number;
}

export interface ProblemMarkSummary {
  total: number;
  marked: number;
  todo: number;
  starred: number;
}

export type ProblemMarksParseResult =
  | { ok: true; file: ProblemMarksFile }
  | { ok: false; code: 'invalid' | 'schema' | 'arena-path'; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 标签清洗：trim、去空、去重、1–24 字、最多 8 个；拒绝换行 / 控制字符 */
export function cleanProblemTags(input: unknown): { ok: true; tags: string[] } | { ok: false; message: string } {
  if (input === undefined) return { ok: true, tags: [] };
  if (!Array.isArray(input)) return { ok: false, message: '标签必须是数组' };
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, message: '标签必须是字符串' };
    if (CONTROL_RE.test(raw)) return { ok: false, message: '标签里不能有换行或控制字符' };
    const tag = raw.trim();
    if (tag === '') continue;
    if (tag.length > PROBLEM_TAG_LEN_MAX) {
      return { ok: false, message: `标签太长（${tag.length} > ${PROBLEM_TAG_LEN_MAX}）` };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > PROBLEM_TAGS_MAX) return { ok: false, message: `标签太多（${out.length} > ${PROBLEM_TAGS_MAX}）` };
  return { ok: true, tags: out };
}

function entryEmpty(mark: ProblemMark): boolean {
  return mark.progress === null && !mark.star && mark.tags.length === 0;
}

function parseMark(raw: unknown): { ok: true; mark: ProblemMark } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: '标记条目必须是对象' };
  let progress: ProblemMarkProgress | null = null;
  if (raw.progress !== undefined && raw.progress !== null) {
    if (!isProblemMarkProgress(raw.progress)) return { ok: false, message: `未知的进度：${String(raw.progress)}` };
    progress = raw.progress;
  }
  let star = false;
  if (raw.star !== undefined) {
    if (typeof raw.star !== 'boolean') return { ok: false, message: 'star 必须是布尔值' };
    star = raw.star;
  }
  const tags = cleanProblemTags(raw.tags);
  if (!tags.ok) return { ok: false, message: tags.message };
  if (!isIsoTime(raw.updatedAt)) return { ok: false, message: 'updatedAt 不是合法时间' };
  return { ok: true, mark: { progress, star, tags: tags.tags, updatedAt: raw.updatedAt } };
}

/** 题目清单快照校验：1–40 题、alias 唯一且合规、title 可空但不超过 200 字 */
export function parseProblemSnapshot(
  input: unknown,
): { ok: true; problems: ProblemMarksProblem[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length < 1) return { ok: false, message: 'problems 至少要有 1 题' };
  if (input.length > PROBLEMS_MAX) return { ok: false, message: `题目太多（${input.length} > ${PROBLEMS_MAX}）` };
  const problems: ProblemMarksProblem[] = [];
  const aliases = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw)) return { ok: false, message: 'problems 含非法项' };
    if (typeof raw.alias !== 'string' || !PROBLEM_ALIAS_RE.test(raw.alias)) {
      return { ok: false, message: '题目 alias 不合法' };
    }
    if (aliases.has(raw.alias)) return { ok: false, message: `题目 alias 重复：${raw.alias}` };
    if (raw.title !== undefined && typeof raw.title !== 'string') {
      return { ok: false, message: '题目 title 必须是字符串' };
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length > PROBLEM_TITLE_MAX) {
      return { ok: false, message: `题目 title 太长（${title.length} > ${PROBLEM_TITLE_MAX}）` };
    }
    aliases.add(raw.alias);
    problems.push({ alias: raw.alias, title });
  }
  return { ok: true, problems };
}

/**
 * `problem-marks.json` 校验。`expectedArenaPath` 由宿主传入：文件里的场次必须一致，
 * 手改 / 复制文件夹都会被判成 arena-path。
 */
export function parseProblemMarksFile(input: unknown, expectedArenaPath?: string): ProblemMarksParseResult {
  if (!isRecord(input)) return { ok: false, code: 'invalid', message: '标记文件不是对象' };
  if (typeof input.schema !== 'number' || !Number.isInteger(input.schema)) {
    return { ok: false, code: 'invalid', message: 'schema 必须是整数' };
  }
  if (input.schema > PROBLEM_MARKS_SCHEMA) {
    return { ok: false, code: 'schema', message: `不支持的标记 schema：${input.schema}` };
  }
  if (input.schema !== PROBLEM_MARKS_SCHEMA) return { ok: false, code: 'invalid', message: 'schema 必须是 1' };

  if (typeof input.arenaPath !== 'string' || !contestPathOk(input.arenaPath)) {
    return { ok: false, code: 'invalid', message: 'arenaPath 不合法' };
  }
  if (expectedArenaPath !== undefined && input.arenaPath !== expectedArenaPath) {
    return { ok: false, code: 'arena-path', message: '标记文件的场次与比赛不一致' };
  }

  const snapshot = parseProblemSnapshot(input.problems);
  if (!snapshot.ok) return { ok: false, code: 'invalid', message: snapshot.message };
  const { problems } = snapshot;
  const aliases = new Set(problems.map((p) => p.alias));

  const marks: Record<string, ProblemMark> = {};
  const foreignMarks: Record<string, unknown> = {};
  let unreadableMarks = 0;
  if (input.marks !== undefined) {
    if (!isRecord(input.marks)) return { ok: false, code: 'invalid', message: 'marks 必须是对象' };
    for (const [alias, raw] of Object.entries(input.marks)) {
      if (!aliases.has(alias)) {
        foreignMarks[alias] = raw;
        unreadableMarks += 1;
        continue;
      }
      const parsed = parseMark(raw);
      if (!parsed.ok) return { ok: false, code: 'invalid', message: `${alias}：${parsed.message}` };
      if (!entryEmpty(parsed.mark)) marks[alias] = parsed.mark;
    }
  }

  const prefillApplied: string[] = [];
  if (input.prefillApplied !== undefined) {
    if (!Array.isArray(input.prefillApplied)) return { ok: false, code: 'invalid', message: 'prefillApplied 必须是数组' };
    for (const raw of input.prefillApplied) {
      if (typeof raw !== 'string' || raw === '') return { ok: false, code: 'invalid', message: 'prefillApplied 含非法项' };
      if (!prefillApplied.includes(raw)) prefillApplied.push(raw);
    }
  }

  return {
    ok: true,
    file: {
      schema: 1,
      arenaPath: input.arenaPath,
      problems,
      marks,
      foreignMarks,
      prefillApplied,
      raw: input,
      unreadableMarks,
    },
  };
}

/** 写回文件：已知字段整组覆盖，未知顶层字段与快照外条目保留 */
export function problemMarksToJson(file: ProblemMarksFile): Record<string, unknown> {
  const marks: Record<string, unknown> = {};
  for (const problem of file.problems) {
    const mark = file.marks[problem.alias];
    if (mark !== undefined) marks[problem.alias] = { ...mark, tags: [...mark.tags] };
  }
  for (const [alias, raw] of Object.entries(file.foreignMarks)) marks[alias] = raw;
  return {
    ...file.raw,
    schema: 1,
    arenaPath: file.arenaPath,
    problems: file.problems.map((p) => ({ alias: p.alias, title: p.title })),
    marks,
    prefillApplied: [...file.prefillApplied],
  };
}

/** 客户端整份 marks 校验：键必须是快照里的 alias；全空条目丢弃 */
export function parseProblemMarksInput(
  input: unknown,
  problems: readonly ProblemMarksProblem[],
): { ok: true; marks: Record<string, ProblemMarkInput> } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'marks 必须是对象' };
  const known = new Set(problems.map((p) => p.alias));
  const entries = Object.entries(input);
  if (entries.length > PROBLEMS_MAX) return { ok: false, message: `marks 条目太多（${entries.length} > ${PROBLEMS_MAX}）` };

  const out: Record<string, ProblemMarkInput> = {};
  for (const [alias, raw] of entries) {
    if (!PROBLEM_ALIAS_RE.test(alias) || !known.has(alias)) {
      return { ok: false, message: `alias 不在题目快照里：${alias}` };
    }
    if (!isRecord(raw)) return { ok: false, message: `${alias} 的标记必须是对象` };
    let progress: ProblemMarkProgress | null = null;
    if (raw.progress !== undefined && raw.progress !== null) {
      if (!isProblemMarkProgress(raw.progress)) return { ok: false, message: `${alias}：未知的进度` };
      progress = raw.progress;
    }
    if (raw.star !== undefined && typeof raw.star !== 'boolean') {
      return { ok: false, message: `${alias}：star 必须是布尔值` };
    }
    const star = raw.star === true;
    const tags = cleanProblemTags(raw.tags);
    if (!tags.ok) return { ok: false, message: `${alias}：${tags.message}` };
    if (progress === null && !star && tags.tags.length === 0) continue;
    out[alias] = { progress, star, tags: tags.tags };
  }
  return { ok: true, marks: out };
}

export interface PrefillOutcome {
  marks: Record<string, ProblemMark>;
  prefillApplied: string[];
  changed: boolean;
}

/**
 * AC 预填：只填空进度、不覆盖手选、不反复填回已清空的自动标记。
 * `subs[].p` 是榜单题序（0-based），按 problems[p].alias 映射。
 */
export function prefillProblemMarks(
  file: Pick<ProblemMarksFile, 'problems' | 'marks' | 'prefillApplied'>,
  subs: readonly { p: number; r: string }[],
  nowIso: string,
): PrefillOutcome {
  const marks: Record<string, ProblemMark> = {};
  for (const [alias, mark] of Object.entries(file.marks)) marks[alias] = { ...mark, tags: [...mark.tags] };
  const prefillApplied = [...file.prefillApplied];
  let changed = false;

  for (const sub of subs) {
    if (sub.r !== 'AC') continue;
    const alias = file.problems[sub.p]?.alias;
    if (alias === undefined) continue;
    const existing = marks[alias];
    if (existing !== undefined && existing.progress !== null) continue;
    if (prefillApplied.includes(alias)) continue;
    marks[alias] = {
      progress: 'contest-ac',
      star: existing?.star ?? false,
      tags: existing === undefined ? [] : [...existing.tags],
      updatedAt: nowIso,
    };
    prefillApplied.push(alias);
    changed = true;
  }

  return { marks, prefillApplied, changed };
}

export function summarizeProblemMarks(
  marks: Readonly<Record<string, ProblemMark>>,
): Omit<ProblemMarkSummary, 'total'> {
  let marked = 0;
  let todo = 0;
  let starred = 0;
  for (const mark of Object.values(marks)) {
    marked += 1;
    if (mark.progress === 'todo') todo += 1;
    if (mark.star) starred += 1;
  }
  return { marked, todo, starred };
}

export function problemMarkSummaryOf(file: Pick<ProblemMarksFile, 'problems' | 'marks'>): ProblemMarkSummary {
  return { total: file.problems.length, ...summarizeProblemMarks(file.marks) };
}

/** 工作区题目标签补全：使用次数降序，同次数按字母序；最多 200 条 */
export function collectProblemTags(files: Iterable<Pick<ProblemMarksFile, 'marks'>>): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const mark of Object.values(file.marks)) {
      for (const tag of mark.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, PROBLEM_TAGS_SUGGEST_MAX)
    .map(([tag]) => tag);
}
