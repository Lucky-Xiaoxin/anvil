/**
 * 工坊旧代码导入（切片 5a-2）的共享契约：DTO、候选识别纯判据、指纹组合与提交选择校验。
 * 口径见 docs/contracts/24-工坊-旧代码导入契约.md。
 * 这里不碰文件系统：扫描、hash、copy、rename 都留在 server；Web 只消费 DTO。
 */

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

/* ---------- 源码扩展名与题号形状 ---------- */

export const IMPORT_SOURCE_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.c', '.py', '.java', '.kt', '.go', '.rs'] as const;
export const IMPORT_ATTACHMENT_EXTENSIONS = ['.in', '.out', '.ans'] as const;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

export function stemOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** 主源码扩展名；大小写不敏感 */
export function isImportSourceName(name: string): boolean {
  return (IMPORT_SOURCE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export function isImportAttachmentName(name: string): boolean {
  return (IMPORT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/**
 * 题号形状：A / B1 / 1001 / CF1234A / ABC300F，以及用 `-` / `_` 分隔的等价写法。
 * 返回去掉分隔符后的规范名（大小写原样保留），不匹配返回 null。
 */
export function problemShapeOf(raw: string): string | null {
  const compact = raw.trim().replace(/[-_]+/g, '');
  if (compact === '' || !/^[A-Za-z0-9]+$/.test(compact)) return null;
  if (/^\d+$/.test(compact)) return compact;
  if (/^[A-Za-z]$/.test(compact)) return compact;
  if (/^[A-Za-z]\d+$/.test(compact)) return compact;
  if (/^[A-Za-z]{2,6}\d{1,6}[A-Za-z]$/.test(compact)) return compact;
  return null;
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

export type ImportScope = { kind: 'dir'; path: string } | { kind: 'file'; path: string; stem: string };

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
  childItemIds: string[];
  scope: ImportScope;
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

function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
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
  dirs: string[];
  filesByDir: Map<string, string[]>;
  dirsByParent: Map<string, string[]>;
}

function viewOf(tree: ImportTree): TreeView {
  const filesByDir = new Map<string, string[]>();
  const dirsByParent = new Map<string, string[]>();
  for (const file of tree.files) {
    const dir = parentDirOf(file.path);
    const list = filesByDir.get(dir);
    if (list === undefined) filesByDir.set(dir, [file.path]);
    else list.push(file.path);
  }
  for (const dir of tree.dirs) {
    if (dir === '') continue;
    const parent = parentDirOf(dir);
    const list = dirsByParent.get(parent);
    if (list === undefined) dirsByParent.set(parent, [dir]);
    else list.push(dir);
  }
  for (const list of filesByDir.values()) list.sort(byPosix);
  for (const list of dirsByParent.values()) list.sort(byPosix);
  return { files: [...tree.files].sort((a, b) => byPosix(a.path, b.path)), dirs: [...tree.dirs].sort(byPosix), filesByDir, dirsByParent };
}

function directFiles(view: TreeView, dir: string): string[] {
  return view.filesByDir.get(dir) ?? [];
}

function directDirs(view: TreeView, dir: string): string[] {
  return view.dirsByParent.get(dir) ?? [];
}

function sourceWithin(view: TreeView, dir: string, maxDepth: number): string[] {
  return view.files.filter((file) => isUnder(file.path, dir) && depthOf(file.path) - depthOf(dir) <= maxDepth && isImportSourceName(baseNameOf(file.path))).map((file) => file.path);
}

interface ProblemDirInfo {
  confidence: 'high' | 'low';
  reasons: string[];
}

function problemDirInfo(view: TreeView, dir: string, shape: string | null): ProblemDirInfo | null {
  const dirName = baseNameOf(dir);
  const direct = sourceWithin(view, dir, 1);
  if (direct.length > 0) {
    return {
      confidence: 'high',
      reasons: [`目录 ${dirName} 顶层有主源码 ${baseNameOf(direct[0]!)}`],
    };
  }
  if (shape !== null) {
    const nested = sourceWithin(view, dir, 2);
    if (nested.length > 0) {
      return {
        confidence: 'low',
        reasons: [`目录名 ${dirName} 符合题号形状；一层范围内找到主源码 ${baseNameOf(nested[0]!)}`],
      };
    }
  }
  return null;
}

function ownedFilesOfProblemDir(view: TreeView, dir: string): ImportOwnedFile[] {
  return view.files
    .filter((file) => isUnder(file.path, dir))
    .map((file) => ({ sourcePath: file.path, targetPath: file.path.slice(dir === '' ? 0 : dir.length + 1) }));
}

function sameStemAttachments(view: TreeView, sourcePath: string): string[] {
  const dir = parentDirOf(sourcePath);
  const stem = stemOf(baseNameOf(sourcePath)).toLowerCase();
  const picked = directFiles(view, dir).filter((path) => {
    const name = baseNameOf(path);
    return isImportAttachmentName(name) && stemOf(name).toLowerCase() === stem;
  });
  return picked.sort(byPosix);
}

function problemFilePlan(view: TreeView, sourcePath: string, id: number): ImportCandidatePlan {
  const name = baseNameOf(sourcePath);
  const sourceOwned = [{ sourcePath, targetPath: name }];
  for (const attachment of sameStemAttachments(view, sourcePath)) {
    sourceOwned.push({ sourcePath: attachment, targetPath: baseNameOf(attachment) });
  }
  sourceOwned.sort((a, b) => byPosix(a.targetPath, b.targetPath));
  const attachments = sourceOwned.length - 1;
  const reasons = [`单文件题：${name}`];
  if (attachments > 0) reasons.push(`同 stem 附件 ${attachments} 个（.in / .out / .ans）`);
  const title = stemOf(name).trim();
  return {
    itemId: `item_${id}`,
    unitId: `item_${id}`,
    sourceRelPath: sourcePath,
    shape: 'problem-file',
    role: 'problem',
    parentItemId: null,
    confidence: 'high',
    suggestedTitle: title.slice(0, 120),
    reasons,
    files: sourceOwned,
    childItemIds: [],
    scope: { kind: 'file', path: sourcePath, stem: stemOf(name) },
  };
}

function problemDirPlan(view: TreeView, dir: string, id: number, info: ProblemDirInfo): ImportCandidatePlan {
  const title = baseNameOf(dir).trim();
  return {
    itemId: `item_${id}`,
    unitId: `item_${id}`,
    sourceRelPath: dir,
    shape: 'problem-dir',
    role: 'problem',
    parentItemId: null,
    confidence: info.confidence,
    suggestedTitle: title.slice(0, 120),
    reasons: [...info.reasons, '目录题保留内部相对路径'],
    files: ownedFilesOfProblemDir(view, dir),
    childItemIds: [],
    scope: { kind: 'dir', path: dir },
  };
}

function undecidedPlan(view: TreeView, dir: string, id: number): ImportCandidatePlan {
  return {
    itemId: `item_${id}`,
    unitId: `item_${id}`,
    sourceRelPath: dir,
    shape: 'undecided',
    role: 'undecided',
    parentItemId: null,
    confidence: 'low',
    suggestedTitle: baseNameOf(dir).trim().slice(0, 120),
    reasons: ['目录里没有主源码，信息不足；确认后才能按题目导入'],
    files: ownedFilesOfProblemDir(view, dir),
    childItemIds: [],
    scope: { kind: 'dir', path: dir },
  };
}

/** 根目录是否是题号形态的 problem-file / problem-dir（比赛子题的判据） */
function numberedChild(view: TreeView, path: string, isDir: boolean): ImportCandidatePlan | null {
  if (isDir) {
    const shape = problemShapeOf(baseNameOf(path));
    if (shape === null) {
      // 非题号目录：只有顶层直接有主源码时才算问题候选（§5.4 第一条）
      const info = problemDirInfo(view, path, null);
      return info === null ? null : { ...problemDirPlan(view, path, 0, info), shape: 'problem-dir' };
    }
    const info = problemDirInfo(view, path, shape);
    return info === null ? null : problemDirPlan(view, path, 0, info);
  }
  if (!isImportSourceName(baseNameOf(path))) return null;
  const shape = problemShapeOf(stemOf(baseNameOf(path)));
  if (shape === null) return null;
  return problemFilePlan(view, path, 0);
}

/** 一个比赛题组：contest 种子 + 子题种子（id 稍后统一分配） */
interface ContestSeed {
  contest: ImportCandidatePlan;
  children: ImportCandidatePlan[];
  numberedCount: number;
}

/** 目录的直接内容是否够格成为比赛题组（≥2 个题号形态的 problem）。 */
function contestSeedOf(view: TreeView, dir: string, title: string): ContestSeed | null {
  const dirName = baseNameOf(dir);
  const childDirs = directDirs(view, dir);
  const childFiles = directFiles(view, dir);

  const numberedDirs = childDirs
    .filter((child) => problemShapeOf(baseNameOf(child)) !== null && problemDirInfo(view, child, problemShapeOf(baseNameOf(child))) !== null);
  const numberedFiles = childFiles.filter(
    (path) => isImportSourceName(baseNameOf(path)) && problemShapeOf(stemOf(baseNameOf(path))) !== null,
  );
  if (numberedDirs.length + numberedFiles.length < 2) return null;

  const children: ImportCandidatePlan[] = [];
  for (const child of childDirs) {
    const info = numberedChild(view, child, true);
    if (info !== null) children.push(info);
  }
  for (const file of childFiles) {
    const info = numberedChild(view, file, false);
    if (info !== null) children.push(info);
  }
  children.sort((a, b) => byPosix(a.sourceRelPath, b.sourceRelPath));

  const childDirsOfContest = new Set(children.filter((child) => child.scope.kind === 'dir').map((child) => child.sourceRelPath));
  const childFilesOfContest = new Set(children.flatMap((child) => child.files.map((file) => file.sourcePath)));
  const shared = view.files
    .filter((file) => isUnder(file.path, dir))
    .filter((file) => {
      for (const childDir of childDirsOfContest) if (isUnder(file.path, childDir)) return false;
      return !childFilesOfContest.has(file.path);
    })
    .map((file) => ({ sourcePath: file.path, targetPath: dir === '' ? file.path : file.path.slice(dir.length + 1) }));

  const contest: ImportCandidatePlan = {
    itemId: '',
    unitId: '',
    sourceRelPath: dir,
    shape: 'contest-group',
    role: 'contest',
    parentItemId: null,
    confidence: children.every((child) => child.confidence === 'high') ? 'high' : 'low',
    suggestedTitle: (dir === '' ? title : dirName).trim().slice(0, 120),
    reasons: [
      `直接内容识别出 ${numberedDirs.length + numberedFiles.length} 道题号形题目（≥2），建议作为比赛题组`,
      shared.length > 0 ? `比赛共享文件 ${shared.length} 个（说明 / 数据 / 公共脚本等）` : '没有比赛级共享文件',
    ],
    files: shared,
    childItemIds: [],
    scope: { kind: 'dir', path: dir },
  };
  return { contest, children, numberedCount: numberedDirs.length + numberedFiles.length };
}

interface ClassifiedSeed {
  contest: ContestSeed | null;
  plain: ImportCandidatePlan | null;
}

/**
 * 把扫描快照分类成扁平候选（契约 §5）。
 * - 源根自身直接内容里 ≥2 个题号形态题目 → 源根是 contest-group；
 * - 否则源根的直接子目录也可以各自成为 contest-group（比赛 = 题组，但不把比赛嵌套进比赛）；
 * - 其余直接文件 / 目录成为 problem-file / problem-dir / undecided。
 * itemId / unitId 按确定顺序分配，同一棵树重复分类结果稳定。
 */
export function classifyImportTree(tree: ImportTree, rootName: string): ImportCandidatePlan[] {
  const view = viewOf(tree);
  const rootContest = contestSeedOf(view, '', rootName);
  const seeds: ClassifiedSeed[] = [];

  if (rootContest !== null) {
    seeds.push({ contest: rootContest, plain: null });
  } else {
    for (const dir of directDirs(view, '')) {
      const contest = contestSeedOf(view, dir, baseNameOf(dir));
      if (contest !== null) {
        seeds.push({ contest, plain: null });
        continue;
      }
      const info = problemDirInfo(view, dir, problemShapeOf(baseNameOf(dir)));
      if (info !== null) {
        seeds.push({ contest: null, plain: problemDirPlan(view, dir, 0, info) });
      } else if (view.files.some((file) => isUnder(file.path, dir))) {
        seeds.push({ contest: null, plain: undecidedPlan(view, dir, 0) });
      }
    }
    for (const file of directFiles(view, '')) {
      if (!isImportSourceName(baseNameOf(file))) continue;
      seeds.push({ contest: null, plain: problemFilePlan(view, file, 0) });
    }
  }

  const out: ImportCandidatePlan[] = [];
  let nextItem = 1;
  let nextUnit = 1;
  for (const seed of seeds) {
    if (seed.contest === null) {
      const item = seed.plain;
      if (item === null) continue;
      const id = `item_${nextItem}`;
      nextItem += 1;
      out.push({ ...item, itemId: id, unitId: id, parentItemId: null });
      continue;
    }
    const contestId = `item_${nextItem}`;
    nextItem += 1;
    const unitId = `unit_${nextUnit}`;
    nextUnit += 1;
    const children: ImportCandidatePlan[] = [];
    for (const child of seed.contest.children) {
      const id = `item_${nextItem}`;
      nextItem += 1;
      children.push({
        ...child,
        itemId: id,
        unitId,
        parentItemId: contestId,
        reasons: [...child.reasons, `建议挂在比赛题组「${seed.contest.contest.suggestedTitle}」下`],
      });
    }
    out.push({ ...seed.contest.contest, itemId: contestId, unitId, childItemIds: children.map((child) => child.itemId) });
    out.push(...children);
  }
  return out;
}

/**
 * 新模型（2026-10-22 用户确认）：一个源目录 = 一个题组。
 * 整个目录的非忽略文件原样归入题组；题目就是其中的源码文件，不再拆 problem 对象。
 */
export function singleDirectoryImportCandidate(tree: ImportTree, rootName: string): ImportCandidatePlan | null {
  if (tree.files.length === 0) return null;
  const files = [...tree.files]
    .sort((a, b) => byPosix(a.path, b.path))
    .map((file) => ({ sourcePath: file.path, targetPath: file.path }));
  const sourceCount = files.filter((file) => isImportSourceName(baseNameOf(file.sourcePath))).length;
  return {
    itemId: 'item_1',
    unitId: 'unit_1',
    sourceRelPath: '',
    shape: 'contest-group',
    role: 'contest',
    parentItemId: null,
    confidence: 'high',
    suggestedTitle: rootName.trim().slice(0, 120),
    reasons: [
      `整目录导入：${files.length} 个文件`,
      `主源码 ${sourceCount} 个；题目就是题组里的源码文件，不单独建对象`,
    ],
    files,
    childItemIds: [],
    scope: { kind: 'dir', path: '' },
  };
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
      childItemIds: [],
      scope: { kind: 'dir', path: dir },
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
        childItemIds: [],
        scope: { kind: 'dir', path: dir },
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

/* ---------- 提交选择校验（契约 §10.2） ---------- */

export interface ImportSelectableCandidate {
  itemId: string;
  unitId: string;
  role: WorkImportRole;
  shape: WorkImportShape;
  parentItemId: string | null;
  suggestedTitle: string;
  duplicate: WorkImportDuplicateDto | null;
  /** contest 自己的共享文件数（不含子题）；用于空题组校验 */
  files: number;
}

export interface ResolvedImportItem<T extends ImportSelectableCandidate = ImportSelectableCandidate> {
  candidate: T;
  selected: boolean;
  title: string;
  finalParentItemId: string | null;
  confirmUndecidedAsProblem: boolean;
  keepDuplicate: boolean;
}

export interface ImportUnitPlan {
  unitId: string;
  /** plan 顺序：contest 在前，子题在后 */
  itemIds: string[];
  contestItemId: string | null;
}

export type ImportSelectionResult<T extends ImportSelectableCandidate> =
  | { ok: true; items: Array<ResolvedImportItem<T>>; units: ImportUnitPlan[] }
  | { ok: false; issues: string[] };

/** 选中项按原子单元分组；拆出的子题 unitId 重算为自己的 itemId */
export function planImportUnits<T extends ImportSelectableCandidate>(items: readonly ResolvedImportItem<T>[]): ImportUnitPlan[] {
  const units: ImportUnitPlan[] = [];
  const byId = new Map(items.map((item) => [item.candidate.itemId, item]));
  for (const item of items) {
    if (!item.selected) continue;
    if (item.candidate.role === 'contest') {
      const children = items.filter(
        (child) => child.selected && child.candidate.role === 'problem' && child.finalParentItemId === item.candidate.itemId,
      );
      units.push({
        unitId: item.candidate.unitId,
        itemIds: [item.candidate.itemId, ...children.map((child) => child.candidate.itemId)],
        contestItemId: item.candidate.itemId,
      });
      continue;
    }
    if ((item.candidate.role === 'problem' || item.candidate.role === 'undecided') && item.finalParentItemId === null) {
      units.push({ unitId: item.candidate.itemId, itemIds: [item.candidate.itemId], contestItemId: null });
      continue;
    }
    if (item.candidate.role === 'problem' && item.finalParentItemId !== null) {
      const parent = byId.get(item.finalParentItemId);
      // contest 已选中时由 contest 单元收走；这里只会遇到父未选的非法情况，交给校验
      if (parent === undefined || !parent.selected) continue;
    }
  }
  return units;
}

export function resolveImportSelection<T extends ImportSelectableCandidate>(
  candidates: readonly T[],
  input: readonly WorkImportCommitItemInput[],
): ImportSelectionResult<T> {
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

  const resolved: Array<ResolvedImportItem<T>> = [];
  for (const candidate of candidates) {
    const raw = provided.get(candidate.itemId);
    const selected = raw?.selected === true;

    let title = (raw?.title ?? candidate.suggestedTitle).trim();
    if (title === '') title = candidate.suggestedTitle.trim();
    if (selected && (title.length < 1 || title.length > 120)) {
      issues.push(`「${candidate.suggestedTitle || candidate.itemId}」的标题长度必须在 1–120 之间`);
    }

    let finalParent: string | null = candidate.parentItemId;
    if (selected) {
      if (candidate.role === 'contest') {
        if (raw?.parentItemId !== undefined && raw.parentItemId !== null) issues.push('contest 不能有父对象');
        finalParent = null;
      } else if (candidate.role === 'undecided') {
        if (raw?.parentItemId !== undefined && raw.parentItemId !== null) issues.push('未判定项只能确认为未分组题目');
        finalParent = null;
      } else {
        finalParent = raw?.parentItemId === undefined ? candidate.parentItemId : raw.parentItemId;
      }
    }

    if (selected && candidate.role === 'undecided' && raw?.confirmUndecidedAsProblem !== true) {
      issues.push(`未判定项「${candidate.suggestedTitle}」需要明确确认为题目才能选中`);
    }

    if (selected && candidate.role === 'problem' && finalParent !== null) {
      const parent = byId.get(finalParent);
      if (parent === undefined) {
        issues.push(`父候选不存在：${finalParent}`);
      } else if (parent.role !== 'contest') {
        issues.push(`题目「${title}」的父对象必须是比赛题组`);
      } else if (candidate.parentItemId !== finalParent) {
        issues.push(`题目「${title}」不能挂到另一个比赛题组的组头`);
      } else if (provided.get(parent.itemId)?.selected !== true) {
        issues.push(`题目「${title}」的父比赛未选中；请显式拆成未分组题目`);
      }
    }

    if (selected && candidate.duplicate?.kind === 'same-content' && raw?.keepDuplicate !== true) {
      issues.push(`「${title}」是潜在重复；仍需导入副本时要明确勾选`);
    }

    resolved.push({
      candidate,
      selected,
      title,
      finalParentItemId: selected ? finalParent : candidate.parentItemId,
      confirmUndecidedAsProblem: raw?.confirmUndecidedAsProblem === true,
      keepDuplicate: raw?.keepDuplicate === true,
    });
  }

  for (const item of resolved) {
    if (!item.selected || item.candidate.role !== 'contest') continue;
    const children = resolved.filter(
      (child) => child.selected && child.candidate.role === 'problem' && child.finalParentItemId === item.candidate.itemId,
    );
    if (children.length === 0 && item.candidate.files === 0) {
      issues.push(`比赛题组「${item.title}」没有任何子题或共享文件，不能创建空题组`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const selectedCount = resolved.filter((item) => item.selected).length;
  if (selectedCount === 0) return { ok: false, issues: ['没有选中任何候选项'] };

  return { ok: true, items: resolved, units: planImportUnits(resolved) };
}
