/**
 * 工坊的共享契约：对象 DTO、`.anvil.json` 校验、slug 与受管路径纯函数。
 * 对象口径见 docs/contracts/23 / 26 / 27；题目标记在 problem-marks.ts（docs/contracts/30）。
 */
import { contestPathOk } from './arena-path.ts';
import type { ProblemMarkSummary, ProblemMarksDto } from './problem-marks.ts';
import { cleanSourcePath } from './work-import.ts';

/**
 * 五类对象（docs/contracts/26）：contest 只表示比赛；problemset 是题组 / 散题代码集合；
 * problem 仅保留旧数据兼容，不再新建。
 */
export type WorkKind = 'contest' | 'problemset' | 'problem' | 'template' | 'note';

export const WORK_KINDS: readonly WorkKind[] = ['contest', 'problemset', 'problem', 'template', 'note'];

export function isWorkKind(v: unknown): v is WorkKind {
  return typeof v === 'string' && (WORK_KINDS as readonly string[]).includes(v);
}

export interface WorkLinks {
  problemKey?: string;
  arenaPath?: string;
}

export interface WorkObjectDto {
  id: string;
  kind: WorkKind;
  title: string;
  relPath: string;
  parentId: string | null;
  labels: string[];
  links: WorkLinks;
  archived: boolean;
  effectiveArchived: boolean;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  /** 主源码文件数；只用于展示（26 §2.4），不参与分类 */
  sourceCount: number;
  /** 导入来源（源根相对 POSIX 路径）；手动创建 / 旧对象没有 */
  sourcePath?: string;
  /** 仅带 arenaPath 的比赛：题目标记汇总（docs/contracts/30 §3.5）；无合法文件时不返回 */
  problemMarkSummary?: ProblemMarkSummary;
}

export interface WorkFileDto {
  path: string;
  size: number;
  mtime: number;
  ext: string;
}

export interface WorkObjectDetailDto extends WorkObjectDto {
  files: WorkFileDto[];
  filesTruncated: boolean;
  /** 仅比赛：题目标记；没有 arenaPath / 没有快照时为 null */
  problemMarks?: ProblemMarksDto | null;
  /** 标记文件损坏 / schema 过高 / 宿主不一致时的原因（成绩与对象不受影响） */
  problemMarksError?: string;
}

export interface WorkUnregisteredDto {
  relPath: string;
  kindHint: WorkKind | null;
}

export interface WorkScanErrorDto {
  relPath: string;
  kind: 'meta-invalid' | 'parent-missing' | 'symlink' | 'scan';
  message: string;
}

interface WorkTrashBaseDto {
  /** 对象条目 = 对象 id；成绩条目 = 本次回收生成的 trashId（`tr_` 开头） */
  id: string;
  /** 列表显示名：对象标题 / 存档名称 */
  title: string;
  trashedAt: string;
}

export interface WorkTrashObjectDto extends WorkTrashBaseDto {
  entryType: 'object';
  originalRelPath: string;
}

/** 单份成绩（docs/contracts/29 §4.5）：回收条目独立于比赛对象，恢复按 recordId 回原宿主 */
export interface WorkTrashRecordDto extends WorkTrashBaseDto {
  entryType: 'arena-record';
  recordId: string;
  contestId: string;
  arenaPath: string;
  /** `record.json`（旧根文件）或 `rec_<32 hex>.json` */
  fileName: string;
}

export type WorkTrashDto = WorkTrashObjectDto | WorkTrashRecordDto;

export interface WorkTrashPurgeResult {
  removed: number;
}

export interface WorkTreeDto {
  root: string;
  scannedAt: number;
  objects: WorkObjectDto[];
  unregistered: WorkUnregisteredDto[];
  errors: WorkScanErrorDto[];
  /** 本工作区所有合法题目标记里用过的标签（去重、最多 200，次数降序再字母序） */
  problemTags: string[];
  trash: WorkTrashDto[];
}

/* ---------- 模板文件（切片 5a.1：详情内联编辑） ---------- */

/** 模板详情只暴露一个主文件：显式 `template.cpp`，没有就取首个 `.cpp`，再没有就用 `template.cpp`（保存时新建） */
export interface WorkTemplateFileDto {
  /** 对象内相对路径（POSIX），例如 `template.cpp` */
  path: string;
  exists: boolean;
  content: string;
  /** 内容的 SHA-256；文件不存在时 null。保存时用它做冲突检测 */
  revision: string | null;
}

export interface WorkTemplateSaveInput {
  id: string;
  content: string;
  /** 客户端读取时的 revision；null 表示当时文件不存在 */
  baseRevision: string | null;
}

/** 与全局 64KB 请求体区分：模板正文按 UTF-8 字节计 */
export const WORK_TEMPLATE_CONTENT_MAX = 64 * 1024;

export interface WorkTemplateCandidate {
  kind: WorkKind;
  effectiveArchived: boolean;
  updatedAt: string;
  relPath: string;
}

/**
 * 新建题目时的默认模板：非归档模板里 updatedAt 最新的一件。
 * 服务端与创建对话框共用这一条判据，避免两边各挑各的。
 */
export function defaultTemplateOf<T extends WorkTemplateCandidate>(objects: readonly T[]): T | null {
  let best: T | null = null;
  for (const obj of objects) {
    if (obj.kind !== 'template' || obj.effectiveArchived) continue;
    if (best === null || obj.updatedAt > best.updatedAt || (obj.updatedAt === best.updatedAt && obj.relPath < best.relPath)) {
      best = obj;
    }
  }
  return best;
}

/* ---------- VP 成绩存档（docs/contracts/23 §15.3 的先行实现） ---------- */

export type WorkArenaGhostResult = 'AC' | 'WA' | 'TLE' | 'RE' | 'CE';

export const WORK_ARENA_GHOST_RESULTS: readonly WorkArenaGhostResult[] = ['AC', 'WA', 'TLE', 'RE', 'CE'];

export interface WorkArenaGhostSub {
  p: number;
  t: number;
  r: WorkArenaGhostResult;
}

export interface WorkArenaGhost {
  show: boolean;
  subs: WorkArenaGhostSub[];
}

/** 保存时的回放位置：live 续播 / review 定格；viewMs 是比赛内毫秒 */
export interface WorkArenaView {
  mode: 'live' | 'review';
  viewMs: number;
  paused: boolean;
  frozenView: boolean;
}

export interface WorkArenaRecordDto {
  schema: 1;
  arenaPath: string;
  title: string;
  savedAt: string;
  ghost: WorkArenaGhost;
  view: WorkArenaView;
}

export interface WorkArenaSaveResult {
  record: WorkArenaRecordDto;
  object: WorkObjectDto;
}

export type WorkArenaRecordParseResult =
  | { ok: true; record: WorkArenaRecordDto }
  | { ok: false; message: string };

export type WorkArenaGhostParseResult =
  | { ok: true; ghost: WorkArenaGhost }
  | { ok: false; message: string };

/** 逐发清单校验（schema 1 旧档与 schema 2 正式档共用）：非法输入整份拒绝，保存前排序 */
export function parseWorkArenaGhost(input: unknown): WorkArenaGhostParseResult {
  if (!isRecord(input)) return { ok: false, message: 'record.ghost 必须是对象' };
  if (typeof input.show !== 'boolean') return { ok: false, message: 'record.ghost.show 必须是布尔值' };
  if (!Array.isArray(input.subs)) return { ok: false, message: 'record.ghost.subs 必须是数组' };
  if (input.subs.length > 5000) return { ok: false, message: 'record.ghost.subs 太多' };
  const subs: WorkArenaGhostSub[] = [];
  for (const raw of input.subs) {
    if (!isRecord(raw)) return { ok: false, message: 'record.ghost.subs 含非法项' };
    const p = raw.p;
    const t = raw.t;
    const r = raw.r;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) return { ok: false, message: 'record 题序不合法' };
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) return { ok: false, message: 'record 提交时刻不合法' };
    if (typeof r !== 'string' || !(WORK_ARENA_GHOST_RESULTS as readonly string[]).includes(r)) {
      return { ok: false, message: 'record 判名不合法' };
    }
    subs.push({ p, t, r: r as WorkArenaGhostResult });
  }
  subs.sort((a, b) => a.p - b.p || a.t - b.t);
  return { ok: true, ghost: { show: input.show, subs } };
}

/** record.json 校验：savedAt / view / 逐发都在服务端收口一次，坏文件不静默喂给回放 */
export function parseWorkArenaRecord(input: unknown): WorkArenaRecordParseResult {
  if (!isRecord(input)) return { ok: false, message: 'record 不是对象' };
  if (input.schema !== 1) return { ok: false, message: `不支持的 record schema：${String(input.schema)}` };
  if (typeof input.arenaPath !== 'string' || !contestPathOk(input.arenaPath)) {
    return { ok: false, message: 'record.arenaPath 不合法' };
  }
  if (typeof input.title !== 'string') return { ok: false, message: 'record.title 必须是字符串' };
  const title = input.title.trim();
  if (title.length < 1 || title.length > 120) return { ok: false, message: 'record.title 长度必须在 1–120 之间' };
  if (!isIsoTime(input.savedAt)) return { ok: false, message: 'record.savedAt 不是合法时间' };

  const ghost = parseWorkArenaGhost(input.ghost);
  if (!ghost.ok) return ghost;

  if (!isRecord(input.view)) return { ok: false, message: 'record.view 必须是对象' };
  const mode = input.view.mode;
  if (mode !== 'live' && mode !== 'review') return { ok: false, message: 'record.view.mode 不合法' };
  const viewMs = input.view.viewMs;
  if (typeof viewMs !== 'number' || !Number.isFinite(viewMs) || viewMs < 0) return { ok: false, message: 'record.view.viewMs 不合法' };
  if (typeof input.view.paused !== 'boolean') return { ok: false, message: 'record.view.paused 必须是布尔值' };
  if (typeof input.view.frozenView !== 'boolean') return { ok: false, message: 'record.view.frozenView 必须是布尔值' };

  return {
    ok: true,
    record: {
      schema: 1,
      arenaPath: input.arenaPath,
      title,
      savedAt: input.savedAt,
      ghost: ghost.ghost,
      view: { mode, viewMs: Math.floor(viewMs), paused: input.view.paused, frozenView: input.view.frozenView },
    },
  };
}


/* ------------------------------------------------------------------ */
/* 身份与字段判据                                                       */
/* ------------------------------------------------------------------ */

export const WORK_ID_RE = /^obj_[0-9a-f]{10}$/;
export const SLUG_MAX = 40;
export const OBJ_REL_PATH_MAX = 160;

export function workIdOk(v: unknown): v is string {
  return typeof v === 'string' && WORK_ID_RE.test(v);
}

export function isIsoTime(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

export interface WorkMeta {
  schema: 1;
  id: string;
  kind: WorkKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  parentId: string | null;
  labels: string[];
  links: WorkLinks;
  archived: boolean;
  /** 导入来源（源根相对 POSIX 路径）；可选，手动创建没有 */
  sourcePath?: string;
}

export interface WorkMetaRecord {
  meta: WorkMeta;
  /** 原 JSON（含未知顶层字段）；更新时浅合并已知字段写回 */
  raw: Record<string, unknown>;
}

export type WorkMetaParseResult = { ok: true; record: WorkMetaRecord } | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** labels 清洗（§4.2）：trim、剥前导 `#`、去重、1–24 字、最多 20 个 */
export function cleanLabels(input: unknown): { ok: true; labels: string[] } | { ok: false; message: string } {
  if (input === undefined) return { ok: true, labels: [] };
  if (!Array.isArray(input)) return { ok: false, message: 'labels 必须是数组' };
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, message: 'label 必须是字符串' };
    const label = raw.trim().replace(/^#+/, '').trim();
    if (label.length < 1) return { ok: false, message: 'label 不能为空' };
    if (label.length > 24) return { ok: false, message: `label 太长（${label.length} > 24）` };
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > 20) return { ok: false, message: `label 太多（${out.length} > 20）` };
  return { ok: true, labels: out };
}

function parseLinks(input: unknown): { ok: true; links: WorkLinks } | { ok: false; message: string } {
  if (input === undefined) return { ok: true, links: {} };
  if (!isRecord(input)) return { ok: false, message: 'links 必须是对象' };
  const links: WorkLinks = {};
  if (input.problemKey !== undefined && input.problemKey !== null) {
    if (typeof input.problemKey !== 'string') return { ok: false, message: 'links.problemKey 必须是字符串' };
    const key = input.problemKey.trim();
    if (key.length > 80) return { ok: false, message: 'links.problemKey 太长' };
    if (key !== '') links.problemKey = key;
  }
  if (input.arenaPath !== undefined && input.arenaPath !== null) {
    if (typeof input.arenaPath !== 'string') return { ok: false, message: 'links.arenaPath 必须是字符串' };
    const path = input.arenaPath.trim();
    if (!contestPathOk(path)) return { ok: false, message: 'links.arenaPath 不在榜单路径白名单内' };
    links.arenaPath = path;
  }
  return { ok: true, links };
}

/** `.anvil.json` 校验（§4.2 / §4.5）；只判自身形状，父子与词表存在性由扫描补 */
export function parseWorkMeta(input: unknown): WorkMetaParseResult {
  if (!isRecord(input)) return { ok: false, message: 'meta 不是对象' };

  if (input.schema !== 1) {
    return { ok: false, message: `不支持的 meta schema：${String(input.schema)}` };
  }
  if (!workIdOk(input.id)) return { ok: false, message: 'id 形状不合法' };
  if (!isWorkKind(input.kind)) return { ok: false, message: 'kind 不合法' };
  if (typeof input.title !== 'string') return { ok: false, message: 'title 必须是字符串' };
  const title = input.title.trim();
  if (title.length < 1 || title.length > 120) return { ok: false, message: 'title 长度必须在 1–120 之间' };

  if (!isIsoTime(input.createdAt)) return { ok: false, message: 'createdAt 不是合法时间' };
  const updatedAt = input.updatedAt === undefined ? input.createdAt : input.updatedAt;
  if (!isIsoTime(updatedAt)) return { ok: false, message: 'updatedAt 不是合法时间' };

  let parentId: string | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (!workIdOk(input.parentId)) return { ok: false, message: 'parentId 形状不合法' };
    parentId = input.parentId;
  }
  // parentId 是逻辑关联：problemset 关联一个比赛（比赛侧 0..n，27 §2.1）；旧 problem 是物理父子。
  // 「父必须是 contest」这一条要等扫描拿到父对象，见 WorkService
  if (parentId !== null && input.kind !== 'problem' && input.kind !== 'problemset') {
    return { ok: false, message: '只有 problemset / problem 可以有 parentId' };
  }

  // 对象级主题标签已退役（30 §3.6）：旧文件里的 tags 字段原样保留，不读、不校验、不重写
  const labels = cleanLabels(input.labels);
  if (!labels.ok) return labels;

  const links = parseLinks(input.links);
  if (!links.ok) return links;
  // 字段职责（26 §2.4）：arenaPath 只属于比赛；sourcePath 不限定 kind（旧 contest 数据迁移已执行完毕，不限制解析是兼容口径）
  if (links.links.arenaPath !== undefined && input.kind !== 'contest') {
    return { ok: false, message: 'arenaPath 只属于 contest' };
  }

  let archived = false;
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') return { ok: false, message: 'archived 必须是布尔值' };
    archived = input.archived;
  }

  let sourcePath: string | undefined;
  if (input.sourcePath !== undefined) {
    if (typeof input.sourcePath !== 'string') return { ok: false, message: 'sourcePath 必须是字符串' };
    const cleaned = cleanSourcePath(input.sourcePath);
    if (cleaned === null) return { ok: false, message: 'sourcePath 不是合法的源根相对路径' };
    sourcePath = cleaned;
  }

  return {
    ok: true,
    record: {
      meta: {
        schema: 1,
        id: input.id,
        kind: input.kind,
        title,
        createdAt: input.createdAt,
        updatedAt,
        parentId,
        labels: labels.labels,
        links: links.links,
        archived,
        ...(sourcePath === undefined ? {} : { sourcePath }),
      },
      raw: input,
    },
  };
}

/** 写回时保留未知顶层字段，已知字段整组覆盖（§4.2） */
export function workMetaToJson(record: WorkMetaRecord): Record<string, unknown> {
  const { meta } = record;
  return {
    ...record.raw,
    schema: 1,
    id: meta.id,
    kind: meta.kind,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    parentId: meta.parentId,
    labels: [...meta.labels],
    links: { ...meta.links },
    archived: meta.archived,
    ...(meta.sourcePath === undefined ? {} : { sourcePath: meta.sourcePath }),
  };
}

/* ------------------------------------------------------------------ */
/* slug 与受管路径                                                      */
/* ------------------------------------------------------------------ */

/** 标题转 slug：小写、去变音、非 [a-z0-9] 折 `-`、压缩/去首尾、最多 40 字 */
export function slugify(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // 契约的例子 CF2184F → cf-2184-f：大写与数字的交界要断开（全小写的 cf2184f 不动）
    .replace(/([A-Z])([0-9])/g, '$1-$2')
    .replace(/([0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (folded.length <= SLUG_MAX) return folded;
  return folded.slice(0, SLUG_MAX).replace(/-+$/g, '');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function applySlugRules(raw: string): string {
  let slug = raw.replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED.test(slug)) slug = `${slug}-obj`;
  return slug;
}

/** 冲突重试：第 1 次 base，2–50 次 `-2`…`-50`；再冲突交给调用方加 4hex */
export function slugForAttempt(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  const head = base.slice(0, Math.max(0, SLUG_MAX - suffix.length)).replace(/-+$/g, '');
  return `${head}${suffix}`;
}

export function slugWithRandomSuffix(base: string, hex: string): string {
  const suffix = `-${hex}`;
  const head = base.slice(0, Math.max(0, SLUG_MAX - suffix.length)).replace(/-+$/g, '');
  return `${head}${suffix}`;
}

export interface LocalDateParts {
  date: string;
  month: string;
  year: string;
  monthNum: string;
}

export function localDateParts(date: Date): LocalDateParts {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return { date: `${y}-${m}-${d}`, month: `${y}-${m}`, year: y, monthNum: m };
}

function arenaStem(path: string): string {
  const name = path.split('/').pop() ?? '';
  return name.endsWith('.srk.json') ? name.slice(0, -'.srk.json'.length) : name;
}

export interface WorkPathInput {
  kind?: WorkKind;
  title: string;
  problemKey?: string | null;
  arenaPath?: string | null;
  parentRelPath?: string | null;
  /** 服务端分配冲突后缀时直接给 slug，跳过 title 来源 */
  slugOverride?: string;
  date: Date;
}

export interface WorkPathResult {
  slug: string;
  relPath: string;
}

function slugSource(input: WorkPathInput): string {
  const candidates = [input.title, input.problemKey ?? '', input.arenaPath === null || input.arenaPath === undefined ? '' : arenaStem(input.arenaPath)];
  for (const candidate of candidates) {
    const slug = applySlugRules(slugify(candidate));
    if (slug !== '') return slug;
  }
  return `${input.kind ?? 'work'}-${localDateParts(input.date).date}`;
}

/** 按契约 §5.1 生成对象相对路径（POSIX 分隔符）；只做形状判据，磁盘冲突由服务端处理 */
export function buildWorkRelPath(
  kind: WorkKind,
  input: WorkPathInput,
): { ok: true; value: WorkPathResult } | { ok: false; message: string } {
  const parts = localDateParts(input.date);
  const source = input.slugOverride !== undefined ? input.slugOverride : slugSource({ ...input, kind });
  const slug = applySlugRules(source);
  if (slug === '') return { ok: false, message: '无法从标题生成目录名' };

  let relPath: string;
  if (kind === 'contest') {
    relPath = `contests/${parts.date}_${slug}`;
  } else if (kind === 'problemset') {
    // 题组（26 §2.1）：practice/<YYYY-MM>/<slug>/；parentId 只是逻辑关联，不落进路径
    relPath = `practice/${parts.month}/${slug}`;
  } else if (kind === 'problem') {
    if (input.parentRelPath !== undefined && input.parentRelPath !== null && input.parentRelPath !== '') {
      const parent = input.parentRelPath.replace(/\\/g, '/').replace(/\/+$/g, '');
      if (parent.startsWith('/') || parent.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        return { ok: false, message: '父对象路径不合法' };
      }
      relPath = `${parent}/${slug}`;
    } else {
      relPath = `practice/${parts.month}/${slug}`;
    }
  } else if (kind === 'template') {
    // 词表退役（30 §3.6）：新建模板统一落 _unsorted；旧模板已在别的分类目录里的不搬
    relPath = `templates/_unsorted/${slug}`;
  } else {
    relPath = `notes/${parts.year}/${parts.monthNum}/${parts.date}_${slug}`;
  }

  if (relPath.length > OBJ_REL_PATH_MAX) return { ok: false, message: `对象路径太长（${relPath.length} > ${OBJ_REL_PATH_MAX}）` };
  const depth = relPath.split('/').length;
  if (depth > 4) return { ok: false, message: '对象路径超过 4 层' };
  return { ok: true, value: { slug, relPath } };
}

/** 候选位置 → kindHint（§8.3；practice 桶自 5a-4 起默认提议题组，problem 仅旧数据兼容） */
export function unregisteredKindHint(relPath: string): WorkKind | null {
  const parts = relPath.split('/');
  if (parts.length === 2 && parts[0] === 'contests') return 'contest';
  if (parts.length === 3 && parts[0] === 'practice' && /^\d{4}-\d{2}$/.test(parts[1] ?? '')) return 'problemset';
  if (parts.length === 3 && parts[0] === 'templates') return 'template';
  if (parts.length === 4 && parts[0] === 'notes' && /^\d{4}$/.test(parts[1] ?? '') && /^\d{2}$/.test(parts[2] ?? '')) return 'note';
  return null;
}
