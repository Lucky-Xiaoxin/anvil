/**
 * 工坊旧代码导入（5a-3 批量 / 5a-4 problemset）的共享契约：DTO、候选识别纯判据、指纹组合与批量提交校验。
 * 口径见 docs/contracts/24-工坊-旧代码导入契约.md 与 docs/contracts/25-工坊-批量题组导入契约.md。
 * 这里不碰文件系统：扫描、hash、copy、rename 都留在 server；Web 只消费 DTO。
 */

/** 历史 plan DTO 字段（契约 24 §10.1）；当前扫描固定 contest-group / contest */
export type WorkImportShape = 'contest-group' | 'problem-dir' | 'problem-file' | 'undecided';
export type WorkImportRole = 'contest' | 'problem' | 'undecided';
/** 5a-3：subtree = 整个目录；direct = 只含该目录的直接文件（散题） */
export type WorkImportScope = 'subtree' | 'direct';

/* ---------- 打开方式（契约 §11） ---------- */

export type WorkOpenApp = 'auto' | 'vscode' | 'explorer';

export interface WorkOpenInput {
  id: string;
  relPath?: string;
  app?: WorkOpenApp;
}

/* ---------- 扫描 / 提交 DTO（契约 §10） ---------- */

export interface WorkImportScanInput {
  sourceRoot: string;
}

export interface WorkImportTotals {
  files: number;
  bytes: number;
  candidates: number;
  ignored: number;
}

export interface WorkImportDuplicateDto {
  kind: 'same-source' | 'same-content';
  /** same-source：same = 指纹一致、历史目标仍可用；new-version = 来源有新版本 */
  state?: 'same' | 'new-version';
  objectId?: string;
  targetRelPath?: string;
}

export interface WorkImportCandidateDto {
  itemId: string;
  unitId: string;
  sourceRelPath: string;
  shape: WorkImportShape;
  role: WorkImportRole;
  parentItemId: string | null;
  confidence: 'high' | 'low';
  suggestedTitle: string;
  reasons: string[];
  files: number;
  bytes: number;
  filePreview: string[];
  filesTruncated: boolean;
  fingerprint: string;
  duplicate: WorkImportDuplicateDto | null;
  selectedByDefault: boolean;
  /** 预览树父目录；源根为 null */
  sourceParentRelPath: string | null;
  scope: WorkImportScope;
  isContainer: boolean;
  /** 该候选复制范围内的主源码数量 */
  sourceCount: number;
}

export interface WorkImportPlanDto {
  planId: string;
  sourceRoot: string;
  expiresAt: string;
  totals: WorkImportTotals;
  items: WorkImportCandidateDto[];
  warnings: string[];
}

export interface WorkImportCommitItemInput {
  itemId: string;
  selected: boolean;
  title?: string;
  parentItemId?: string | null;
  confirmUndecidedAsProblem?: boolean;
  keepDuplicate?: boolean;
}

export interface WorkImportCommitInput {
  planId: string;
  items: WorkImportCommitItemInput[];
}

export interface WorkImportResultObjectDto {
  itemId: string;
  objectId: string;
  relPath: string;
}

export interface WorkImportResultUnitDto {
  unitId: string;
  status: 'success' | 'failed';
  objects: WorkImportResultObjectDto[];
  /** 该单元的 plan 项（失败时也保留，供结果页显示标题） */
  itemIds: string[];
  error?: { kind: string; message: string };
}

export interface WorkImportSkippedDto {
  itemId: string;
  reason: string;
  objectId?: string;
  /** duplicate = 自动跳过 / user = 用户未选；老客户端可只看 reason */
  kind?: 'duplicate' | 'user';
}

export interface WorkImportResultDto {
  batchId: string;
  manifestRelPath: string;
  units: WorkImportResultUnitDto[];
  skipped: WorkImportSkippedDto[];
}

/* ---------- 固定上限与常量（契约 §4.4 / §6.4） ---------- */

export const WORK_IMPORT_LIMITS = {
  maxDepth: 16,
  maxFiles: 10_000,
  maxBytes: 1024 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxCandidates: 2_000,
} as const;

export const WORK_IMPORT_FILE_PREVIEW = 20;
export const WORK_IMPORT_PLAN_TTL_MS = 30 * 60 * 1000;
export const WORK_IMPORT_PLAN_KEEP = 3;

/* ---------- 源码扩展名 ---------- */

export const IMPORT_SOURCE_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.c', '.py', '.java', '.kt', '.go', '.rs'] as const;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** 主源码扩展名；大小写不敏感 */
export function isImportSourceName(name: string): boolean {
  return (IMPORT_SOURCE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/* ---------- 候选识别（纯函数） ---------- */

export interface ImportTreeFile {
  /** 源根相对 POSIX 路径 */
  path: string;
  size: number;
  sha256: string;
}

export interface ImportTree {
  files: ImportTreeFile[];
  /** 源根相对 POSIX 路径；不含源根本身 */
  dirs: string[];
}

export interface ImportOwnedFile {
  sourcePath: string;
  /** 复制到新对象文件夹后的相对 POSIX 路径 */
  targetPath: string;
}

export interface ImportCandidatePlan {
  itemId: string;
  unitId: string;
  sourceRelPath: string;
  shape: WorkImportShape;
  role: WorkImportRole;
  parentItemId: string | null;
  confidence: 'high' | 'low';
  suggestedTitle: string;
  reasons: string[];
  files: ImportOwnedFile[];
}

/** 5a-3 的目录候选：每个候选自己就是一个原子单元（contest） */
export interface BatchImportCandidatePlan extends ImportCandidatePlan {
  sourceParentRelPath: string | null;
  importScope: WorkImportScope;
  isContainer: boolean;
  sourceCount: number;
  selectedByDefault: boolean;
}

const byPosix = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function parentDirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function baseNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function isUnder(path: string, dir: string): boolean {
  if (dir === '') return true;
  return path.startsWith(`${dir}/`);
}

function depthOf(path: string): number {
  return path.split('/').filter((p) => p !== '').length;
}

interface TreeView {
  files: ImportTreeFile[];
  filesByDir: Map<string, string[]>;
}

function viewOf(tree: ImportTree): TreeView {
  const filesByDir = new Map<string, string[]>();
  for (const file of tree.files) {
    const dir = parentDirOf(file.path);
    const list = filesByDir.get(dir);
    if (list === undefined) filesByDir.set(dir, [file.path]);
    else list.push(file.path);
  }
  for (const list of filesByDir.values()) list.sort(byPosix);
  return { files: [...tree.files].sort((a, b) => byPosix(a.path, b.path)), filesByDir };
}

function directFiles(view: TreeView, dir: string): string[] {
  return view.filesByDir.get(dir) ?? [];
}

/* ---------- 批量目录分类（切片 5a-3 契约 §4） ---------- */

/**
 * 一次扫描把一个旧根下的所有「含源码目录」分类成独立候选：
 * - subtree：整个目录（含下级）作为一个题组；
 * - direct：只含该目录直接文件（散题），仅当该目录存在下级源码目录时有意义；
 * - isContainer：直接下级含源码目录 >= 2。
 * 不做自动合并 / 拆分；容器默认不选，叶子默认选中。
 */
export function classifyBatchImportTree(tree: ImportTree, rootName: string): BatchImportCandidatePlan[] {
  const view = viewOf(tree);
  const dirs = new Set<string>(['', ...tree.dirs]);
  for (const file of tree.files) dirs.add(parentDirOf(file.path));
  for (const dir of [...dirs]) {
    // 保证中间目录都在（扫描结果通常已经完整，这里防御损坏的 ImportTree）
    let parent = parentDirOf(dir);
    while (parent !== '') {
      dirs.add(parent);
      parent = parentDirOf(parent);
    }
  }

  const sourceCount = new Map<string, number>();
  const directSourceCount = new Map<string, number>();
  for (const dir of dirs) {
    sourceCount.set(dir, 0);
    directSourceCount.set(dir, 0);
  }
  for (const file of tree.files) {
    if (!isImportSourceName(baseNameOf(file.path))) continue;
    const dir = parentDirOf(file.path);
    sourceCount.set(dir, (sourceCount.get(dir) ?? 0) + 1);
    directSourceCount.set(dir, (directSourceCount.get(dir) ?? 0) + 1);
  }
  const ordered = [...dirs].sort((a, b) => depthOf(a) - depthOf(b) || byPosix(a, b));
  for (const dir of [...ordered].reverse()) {
    if (dir === '') continue;
    const parent = parentDirOf(dir);
    sourceCount.set(parent, (sourceCount.get(parent) ?? 0) + (sourceCount.get(dir) ?? 0));
  }

  const childSourceCount = new Map<string, number>();
  for (const dir of ordered) {
    if (dir === '') continue;
    if ((sourceCount.get(dir) ?? 0) === 0) continue;
    const parent = parentDirOf(dir);
    childSourceCount.set(parent, (childSourceCount.get(parent) ?? 0) + 1);
  }

  const filesUnder = (dir: string): ImportOwnedFile[] =>
    view.files
      .filter((file) => isUnder(file.path, dir))
      .map((file) => ({ sourcePath: file.path, targetPath: file.path.slice(dir === '' ? 0 : dir.length + 1) }));

  const out: BatchImportCandidatePlan[] = [];
  let next = 0;
  for (const dir of ordered) {
    if ((sourceCount.get(dir) ?? 0) === 0) continue;
    const childCount = childSourceCount.get(dir) ?? 0;
    const isContainer = childCount >= 2;
    const dirLabel = dir === '' ? rootName : baseNameOf(dir);
    const subtreeFiles = filesUnder(dir);
    const subtreeSources = sourceCount.get(dir) ?? 0;
    const reasons = [
      `整目录导入：${subtreeFiles.length} 个文件`,
      `主源码 ${subtreeSources} 个；题目就是题组里的源码文件，不单独建对象`,
    ];
    if (childCount >= 2) {
      reasons.push(`容器：直接下级有 ${childCount} 个含源码目录；默认不选，可改选下级叶子，或明确整目录导入`);
    } else if (childCount === 1) {
      reasons.push('存在 1 个下级源码目录；默认选下级叶子，整目录导入会把它一并纳入');
    } else {
      reasons.push('叶子：直接下级没有含源码目录');
    }
    next += 1;
    const id = `item_${next}`;
    out.push({
      itemId: id,
      unitId: `unit_${next}`,
      sourceRelPath: dir,
      shape: 'contest-group',
      role: 'contest',
      parentItemId: null,
      confidence: 'high',
      suggestedTitle: (dirLabel === '' ? rootName : dirLabel).trim().slice(0, 120),
      reasons,
      files: subtreeFiles,
      sourceParentRelPath: dir === '' ? null : parentDirOf(dir),
      importScope: 'subtree',
      isContainer,
      sourceCount: subtreeSources,
      selectedByDefault: !isContainer,
    });

    const direct = directFiles(view, dir);
    if (childCount >= 1 && direct.length > 0) {
      const directSources = direct.filter((path) => isImportSourceName(baseNameOf(path))).length;
      next += 1;
      const scatterId = `item_${next}`;
      out.push({
        itemId: scatterId,
        unitId: `unit_${next}`,
        sourceRelPath: dir,
        shape: 'contest-group',
        role: 'contest',
        parentItemId: null,
        confidence: 'high',
        suggestedTitle: `${dirLabel || rootName} 散题`.trim().slice(0, 120),
        reasons: [
          '散题：只复制该目录的直接文件，不含下级目录',
          `直接文件 ${direct.length} 个，其中主源码 ${directSources} 个`,
          `判定：散题（存在 ${childCount} 个下级源码目录）`,
        ],
        files: direct.map((path) => ({ sourcePath: path, targetPath: baseNameOf(path) })),
        sourceParentRelPath: dir === '' ? null : parentDirOf(dir),
        importScope: 'direct',
        isContainer: false,
        sourceCount: directSources,
        selectedByDefault: false,
      });
    }
  }
  return out;
}

/* ---------- sourcePath（契约 §3.3 / §9） ---------- */

/** 源根相对 POSIX 路径；非法返回 null。不用于文件系统解析。 */
export function cleanSourcePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (input.length < 1 || input.length > 300) return null;
  if (input.includes('\0') || input.includes('\\')) return null;
  if (input.startsWith('/')) return null;
  const parts = input.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return input;
}

/** 来源分组键：sourcePath 的父路径；根级来源返回 ''，无来源返回 null */
export function sourceParentPath(sourcePath: string | undefined): string | null {
  if (sourcePath === undefined) return null;
  return parentDirOf(sourcePath);
}

/** 路径段自然排序：年月数字按数值比较，同段再按中文名称 */
export function compareSourcePathNatural(a: string, b: string): number {
  const left = a.split('/').filter((part) => part !== '');
  const right = b.split('/').filter((part) => part !== '');
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const compared = collator.compare(x, y);
    if (compared !== 0) return compared;
  }
  return 0;
}

/* ---------- 批量提交选择（契约 §5） ---------- */

export interface BatchImportSelectableCandidate {
  itemId: string;
  unitId: string;
  sourceRelPath: string;
  importScope: WorkImportScope;
  suggestedTitle: string;
  duplicate: WorkImportDuplicateDto | null;
  files: number;
}

export interface ResolvedBatchImportItem<T extends BatchImportSelectableCandidate = BatchImportSelectableCandidate> {
  candidate: T;
  selected: boolean;
  title: string;
  keepDuplicate: boolean;
}

export interface BatchImportUnitPlan {
  unitId: string;
  itemIds: string[];
}

export type BatchImportSelectionResult<T extends BatchImportSelectableCandidate> =
  | { ok: true; items: Array<ResolvedBatchImportItem<T>>; units: BatchImportUnitPlan[] }
  | { ok: false; issues: string[] };

function pathContains(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (parent === '') return child !== '';
  return child.startsWith(`${parent}/`);
}

/** 两个候选是否会复制同一批文件（父子互斥；散题只与祖先整目录 / 同目录整目录冲突） */
export function batchCandidatesConflict(
  a: Pick<BatchImportSelectableCandidate, 'sourceRelPath' | 'importScope'>,
  b: Pick<BatchImportSelectableCandidate, 'sourceRelPath' | 'importScope'>,
): boolean {
  if (a.importScope === 'subtree' && pathContains(a.sourceRelPath, b.sourceRelPath)) return true;
  if (b.importScope === 'subtree' && pathContains(b.sourceRelPath, a.sourceRelPath)) return true;
  return false;
}

export function resolveBatchImportSelection<T extends BatchImportSelectableCandidate>(
  candidates: readonly T[],
  input: readonly WorkImportCommitItemInput[],
): BatchImportSelectionResult<T> {
  const issues: string[] = [];
  const byId = new Map(candidates.map((candidate) => [candidate.itemId, candidate]));
  const provided = new Map<string, WorkImportCommitItemInput>();
  for (const item of input) {
    if (provided.has(item.itemId)) {
      issues.push(`itemId 重复回传：${item.itemId}`);
      continue;
    }
    if (!byId.has(item.itemId)) {
      issues.push(`itemId 不属于当前 plan：${item.itemId}`);
      continue;
    }
    provided.set(item.itemId, item);
  }

  const resolved: Array<ResolvedBatchImportItem<T>> = candidates.map((candidate) => {
    const raw = provided.get(candidate.itemId);
    const selected = raw?.selected === true;
    let title = (raw?.title ?? candidate.suggestedTitle).trim();
    if (title === '') title = candidate.suggestedTitle.trim();
    if (selected && (title.length < 1 || title.length > 120)) {
      issues.push(`「${candidate.suggestedTitle || candidate.itemId}」的标题长度必须在 1–120 之间`);
    }
    if (selected && candidate.files === 0) {
      issues.push(`「${title}」没有可复制的文件，不能导入`);
    }
    if (selected && candidate.duplicate?.kind === 'same-content' && raw?.keepDuplicate !== true) {
      issues.push(`「${title}」是潜在重复；仍需导入副本时要明确勾选`);
    }
    return {
      candidate,
      selected,
      title,
      keepDuplicate: raw?.keepDuplicate === true,
    };
  });

  const selected = resolved.filter((item) => item.selected);
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const a = selected[i]!;
      const b = selected[j]!;
      if (batchCandidatesConflict(a.candidate, b.candidate)) {
        issues.push(
          `父子目录不能同时选中：「${a.candidate.sourceRelPath || '（源根）'}」与「${b.candidate.sourceRelPath || '（源根）'}」`,
        );
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  if (selected.length === 0) return { ok: false, issues: ['没有选中任何候选项'] };

  return {
    ok: true,
    items: resolved,
    units: selected.map((item) => ({ unitId: item.candidate.unitId, itemIds: [item.candidate.itemId] })),
  };
}

/* ---------- 指纹组合（契约 §7.2） ---------- */

export interface ImportFingerprintEntry {
  /** 对象内稳定相对路径（不随标题 / 目标 slug 变化） */
  path: string;
  size: number;
  sha256: string;
}

/** `<path> NUL <size> NUL <sha256> LF` 按路径排序拼接；调用方再对结果做 SHA-256 */
export function importFingerprintInput(entries: readonly ImportFingerprintEntry[]): string {
  return [...entries]
    .sort((a, b) => byPosix(a.path, b.path))
    .map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
}
