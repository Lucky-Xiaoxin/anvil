/**
 * 工坊旧代码导入（docs/contracts/24）：只读扫描、内存 plan、staging 原子发布与 manifest journal。
 * 纯判据在 shared/work-import.ts；这里只做 IO、hash、去重与写队列内的发布。
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  buildWorkRelPath,
  classifyBatchImportTree,
  cleanSourcePath,
  importFingerprintInput,
  isImportSourceName,
  resolveBatchImportSelection,
  slugForAttempt,
  slugWithRandomSuffix,
  workMetaToJson,
  WORK_IMPORT_FILE_PREVIEW,
  WORK_IMPORT_LIMITS,
  WORK_IMPORT_PLAN_KEEP,
  WORK_IMPORT_PLAN_TTL_MS,
  type BatchImportCandidatePlan,
  type BatchImportSelectableCandidate,
  type ResolvedBatchImportItem,
  type ImportFingerprintEntry,
  type ImportTree,
  type WorkImportCandidateDto,
  type WorkImportCommitInput,
  type WorkImportDuplicateDto,
  type WorkImportPlanDto,
  type WorkImportResultDto,
  type WorkImportResultUnitDto,
  type WorkImportRole,
  type WorkImportScanInput,
  type WorkImportScope,
  type WorkImportShape,
  type WorkImportSkippedDto,
  type WorkImportTotals,
  type WorkMeta,
  type WorkMetaRecord,
} from '@anvil/shared';
import { writeFileAtomic } from '../atomic.ts';
import { WorkError } from './errors.ts';
import {
  assertNoSymlinkComponents,
  isIgnoredName,
  lstatOrNull,
  localTrashStamp,
  relPosix,
  resolveInside,
  toPosix,
  validateImportSource,
  within,
} from './paths.ts';

/* ------------------------------------------------------------------ */
/* 内部结构                                                            */
/* ------------------------------------------------------------------ */

interface ScannedFile {
  sourcePath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface ImportFile extends ScannedFile {
  /** 复制到对象文件夹后的相对路径 */
  targetPath: string;
}

interface PlanItem {
  itemId: string;
  unitId: string;
  role: WorkImportRole;
  shape: WorkImportShape;
  sourceRelPath: string;
  suggestedTitle: string;
  confidence: 'high' | 'low';
  reasons: string[];
  parentItemId: string | null;
  importScope: WorkImportScope;
  sourceParentRelPath: string | null;
  isContainer: boolean;
  sourceCount: number;
  ownedFiles: ImportFile[];
  /** 扫描时的对象指纹（按 scope 的文件范围计算） */
  fingerprint: string;
  duplicate: WorkImportDuplicateDto | null;
  selectedByDefault: boolean;
}

interface ImportPlan {
  planId: string;
  sourceRootAbs: string;
  sourceRootReal: string;
  root: string;
  rootReal: string;
  rootCreatedAt: string;
  expiresAt: number;
  items: PlanItem[];
  byId: Map<string, PlanItem>;
  totals: WorkImportTotals;
  warnings: string[];
  result: WorkImportResultDto | null;
  commit: Promise<WorkImportResultDto> | null;
}

interface PreparedObject {
  itemId: string;
  objectId: string;
  title: string;
  /** 导入来源（源根相对 POSIX）；源根自身 / 手动对象没有 */
  sourcePath?: string;
  targetRelPath: string;
  ownedFiles: ImportFile[];
}

interface PreparedUnit {
  unitId: string;
  items: PlanItem[];
  objects: PreparedObject[];
  /** 单个对象的目标相对路径 */
  targetRelPath: string;
  skip: { objectId?: string; reason: string } | null;
}

type ManifestStatus = 'running' | 'completed' | 'partial' | 'failed';
type ManifestUnitState = 'planned' | 'staged' | 'published' | 'success' | 'failed';
type ManifestItemStatus = 'pending' | 'success' | 'skipped' | 'failed';

interface ManifestUnit {
  unitId: string;
  state: ManifestUnitState;
  objectIds: string[];
  targetRelPaths: string[];
  itemIds: string[];
  errorKind?: string;
  message?: string;
}

interface ManifestItem {
  itemId: string;
  unitId: string;
  sourceRelPath: string;
  scope: WorkImportScope;
  sourceMtime: number;
  fingerprint: string;
  action: 'import' | 'skip-user' | 'skip-duplicate';
  kind: 'contest' | 'problemset' | 'problem';
  title: string;
  parentItemId: string | null;
  objectId?: string;
  targetRelPath?: string;
  status: ManifestItemStatus;
  errorKind?: string;
  message?: string;
}

interface ImportManifest {
  schema: 1;
  batchId: string;
  sourceRoot: string;
  workspace: { realPath: string; rootCreatedAt: string };
  createdAt: string;
  finishedAt: string | null;
  status: ManifestStatus;
  units: ManifestUnit[];
  items: ManifestItem[];
}

interface HistoryEntry {
  /** sourceKey + scope 的组合键 */
  key: string;
  sourcePath: string;
  scope: WorkImportScope;
  fingerprint: string;
  objectId: string;
  targetRelPath: string;
}

export interface WorkImportDeps {
  /** 已校验的受管根绝对路径；未配置 / 未初始化时抛 WorkError */
  getManagedRoot: () => string;
  /** 重建内存索引（在写队列内调用） */
  refreshIndex: () => void;
  lookupObject: (id: string) => { id: string; relPath: string } | null;
  now: () => Date;
  /** 仅测试注入；生产固定用契约上限 */
  limits?: Partial<Record<keyof typeof WORK_IMPORT_LIMITS, number>>;
}

type Limits = { [K in keyof typeof WORK_IMPORT_LIMITS]: number };

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const byPosix = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashFile(abs: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sourceKey(sourceReal: string, sourceRelPath: string): string {
  const base = toPosix(sourceReal).replace(/\/+$/, '');
  const key = sourceRelPath === '' ? base : `${base}/${sourceRelPath}`;
  // Windows 路径大小写不敏感；历史 manifest 可能来自不同大小写的输入，统一折叠后才算「同一真实源路径」
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** 5a-3 去重键：同一真实源路径 + sourceRelPath + scope；旧 manifest 没有 scope 时按 subtree */
function historyKey(sourceReal: string, sourceRelPath: string, scope: WorkImportScope): string {
  return `${sourceKey(sourceReal, sourceRelPath)}\0${scope}`;
}

function sourcePathOf(sourceRelPath: string): string | undefined {
  if (sourceRelPath === '') return undefined;
  const cleaned = cleanSourcePath(sourceRelPath);
  if (cleaned === null) throw new WorkError('import-conflict', `来源路径不合法：${sourceRelPath}`);
  return cleaned;
}

function isBatchId(v: unknown): v is string {
  return typeof v === 'string' && /^imp_[0-9a-f]{10}$/.test(v);
}

function isUnitId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
}

function isSafeRelRelPath(rel: string): boolean {
  if (rel === '' || rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parentDirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export class WorkImportService {
  private readonly deps: WorkImportDeps;
  private readonly limits: Limits;
  private readonly plans = new Map<string, ImportPlan>();

  constructor(deps: WorkImportDeps) {
    this.deps = deps;
    this.limits = { ...WORK_IMPORT_LIMITS, ...(deps.limits ?? {}) };
  }

  /* ---------- 扫描（只读） ---------- */

  async scan(input: WorkImportScanInput): Promise<WorkImportPlanDto> {
    const root = this.deps.getManagedRoot();
    const rootReal = realpathSync(root);
    const rootCreatedAt = this.readRootCreatedAt(root);
    const source = validateImportSource(input.sourceRoot, root);
    this.deps.refreshIndex();

    const scanned = await this.scanSource(source.abs);
    const tree: ImportTree = {
      files: scanned.files.map((file) => ({ path: file.sourcePath, size: file.size, sha256: file.sha256 })),
      dirs: scanned.dirs,
    };
    // 5a-3：一个含源码目录 = 一个候选；容器 / 叶子 / 散题分开，提交时每项独立成题组（5a-4 起为 problemset）
    const candidates = classifyBatchImportTree(tree, basename(source.abs));
    if (candidates.length > this.limits.maxCandidates) {
      throw new WorkError('import-limit', `候选对象超过上限（${candidates.length} > ${this.limits.maxCandidates}）`);
    }

    const items = this.buildPlanItems(candidates, scanned.files);
    const history = this.readHistory(root);
    this.applyDuplicates(items, history.entries, source.real, root);

    const warnings: string[] = [];
    if (scanned.ignored > 0) warnings.push(`已忽略 ${scanned.ignored} 项（依赖目录 / 编译产物 / 符号链接等）`);
    if (items.length === 0) warnings.push('没有识别出可导入的候选：源目录里没有主源码文件（.cpp / .py 等）');
    for (const warning of history.warnings) warnings.push(warning);

    const plan: ImportPlan = {
      planId: randomBytes(16).toString('hex'),
      sourceRootAbs: source.abs,
      sourceRootReal: source.real,
      root,
      rootReal,
      rootCreatedAt,
      expiresAt: this.deps.now().getTime() + WORK_IMPORT_PLAN_TTL_MS,
      items,
      byId: new Map(items.map((item) => [item.itemId, item])),
      totals: {
        files: scanned.files.length,
        bytes: scanned.files.reduce((sum, file) => sum + file.size, 0),
        candidates: items.length,
        ignored: scanned.ignored,
      },
      warnings,
      result: null,
      commit: null,
    };

    this.rememberPlan(plan);
    return this.toPlanDto(plan);
  }

  private rememberPlan(plan: ImportPlan): void {
    const now = this.deps.now().getTime();
    for (const [id, existing] of this.plans) {
      if (existing.expiresAt <= now) this.plans.delete(id);
    }
    this.plans.set(plan.planId, plan);
    while (this.plans.size > WORK_IMPORT_PLAN_KEEP) {
      const oldest = this.plans.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
  }

  private buildPlanItems(candidates: BatchImportCandidatePlan[], scanned: ScannedFile[]): PlanItem[] {
    const bySource = new Map(scanned.map((file) => [file.sourcePath, file]));
    return candidates.map((candidate) => {
      const ownedFiles: ImportFile[] = [];
      for (const file of candidate.files) {
        const scannedFile = bySource.get(file.sourcePath);
        if (scannedFile === undefined) throw new WorkError('internal', '扫描结果缺少候选文件');
        ownedFiles.push({ ...scannedFile, targetPath: file.targetPath });
      }
      const entries: ImportFingerprintEntry[] = ownedFiles.map((file) => ({
        path: file.targetPath,
        size: file.size,
        sha256: file.sha256,
      }));
      return {
        itemId: candidate.itemId,
        unitId: candidate.unitId,
        role: candidate.role,
        shape: candidate.shape,
        sourceRelPath: candidate.sourceRelPath,
        suggestedTitle: candidate.suggestedTitle,
        confidence: candidate.confidence,
        reasons: [...candidate.reasons],
        parentItemId: candidate.parentItemId,
        importScope: candidate.importScope,
        sourceParentRelPath: candidate.sourceParentRelPath,
        isContainer: candidate.isContainer,
        sourceCount: candidate.sourceCount,
        ownedFiles,
        fingerprint: sha256Text(importFingerprintInput(entries)),
        duplicate: null,
        selectedByDefault: false,
      };
    });
  }

  private applyDuplicates(items: PlanItem[], history: HistoryEntry[], sourceReal: string, root: string): void {
    const bySource = new Map(history.map((entry) => [entry.key, entry]));
    const byFingerprint = new Map<string, HistoryEntry>();
    for (const entry of history) {
      if (!byFingerprint.has(entry.fingerprint)) byFingerprint.set(entry.fingerprint, entry);
    }

    for (const item of items) {
      const key = historyKey(sourceReal, item.sourceRelPath, item.importScope);
      const sameSource = bySource.get(key);
      if (sameSource !== undefined) {
        if (sameSource.fingerprint === item.fingerprint) {
          const target = lstatOrNull(join(root, ...sameSource.targetRelPath.split('/')));
          const object = this.deps.lookupObject(sameSource.objectId);
          if (target !== null && target.isDirectory() && object !== null) {
            item.duplicate = {
              kind: 'same-source',
              state: 'same',
              objectId: sameSource.objectId,
              targetRelPath: sameSource.targetRelPath,
            };
            item.reasons.push('同一来源与内容已经导入过，提交时自动跳过');
          } else {
            item.reasons.push('历史导入目标已不存在，可重新导入');
          }
        } else {
          item.duplicate = {
            kind: 'same-source',
            state: 'new-version',
            objectId: sameSource.objectId,
            targetRelPath: sameSource.targetRelPath,
          };
          item.reasons.push('来源有新版本（内容指纹变化），默认不选');
        }
        continue;
      }

      const sameContent = byFingerprint.get(item.fingerprint);
      if (sameContent !== undefined && sameContent.key !== key) {
        item.duplicate = {
          kind: 'same-content',
          objectId: sameContent.objectId,
          targetRelPath: sameContent.targetRelPath,
        };
        item.reasons.push('与已有对象内容相同（不同源路径或不同范围），默认不选');
      }
    }

    // 同批内不同来源 / 范围 + 同指纹：标潜在重复，不自动合并
    const groups = new Map<string, PlanItem[]>();
    for (const item of items) {
      if (item.duplicate !== null) continue;
      const list = groups.get(item.fingerprint);
      if (list === undefined) groups.set(item.fingerprint, [item]);
      else list.push(item);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keys = new Set(group.map((item) => historyKey(sourceReal, item.sourceRelPath, item.importScope)));
      if (keys.size < 2) continue;
      // 同批同内容没有「第一个」可默认可信：全部标潜在重复，选中必须明确保留副本
      for (const item of group) {
        item.duplicate = { kind: 'same-content' };
        item.reasons.push('同一批里存在内容相同的其它候选，默认不选');
      }
    }

    for (const item of items) {
      const exactDuplicate = item.duplicate?.kind === 'same-source' && item.duplicate.state === 'same';
      if (exactDuplicate) {
        item.selectedByDefault = true;
        continue;
      }
      item.selectedByDefault =
        item.importScope === 'subtree' && item.confidence === 'high' && !item.isContainer && item.duplicate === null;
    }
    this.resolveDefaultConflicts(items);
  }

  /**
   * 默认勾选不能父子重叠。
   * - 混合目录（自身有直接主源码、又只有一个下级源码目录）是叶子，祖先优先：它默认选中时后代让位，
   *   否则父目录里的直接源码会被静默漏掉；
   * - 纯包装目录（自身没有直接源码）仍是更深的叶子优先：一串 2026/10/7.XX 里默认选真正的比赛目录；
   * - 容器（直接下级含源码目录 ≥2）本身不默认选中，所以其下级叶子不受影响。
   */
  private resolveDefaultConflicts(items: PlanItem[]): void {
    const selected = items.filter((item) => item.selectedByDefault && item.importScope === 'subtree');
    const isMixed = (item: PlanItem): boolean =>
      item.ownedFiles.some((file) => !file.targetPath.includes('/') && isImportSourceName(file.targetPath));

    // 1) 混合目录接管整棵子树
    for (const ancestor of selected.filter(isMixed)) {
      for (const other of items) {
        if (other === ancestor || !other.selectedByDefault) continue;
        const underAncestor =
          ancestor.sourceRelPath === '' ? other.sourceRelPath !== '' : other.sourceRelPath.startsWith(`${ancestor.sourceRelPath}/`);
        const sameDirScatter = other.importScope === 'direct' && other.sourceRelPath === ancestor.sourceRelPath;
        if (underAncestor || sameDirScatter) other.selectedByDefault = false;
      }
    }

    // 2) 纯包装目录让位给仍被选中的后代
    for (const wrapper of selected.filter((item) => !isMixed(item))) {
      if (!wrapper.selectedByDefault) continue;
      const hasSelectedDescendant = items.some(
        (other) =>
          other !== wrapper &&
          other.selectedByDefault &&
          (wrapper.sourceRelPath === '' ? other.sourceRelPath !== '' : other.sourceRelPath.startsWith(`${wrapper.sourceRelPath}/`)),
      );
      if (hasSelectedDescendant) wrapper.selectedByDefault = false;
    }

    // 3) 散题让位给同目录的整目录候选
    for (const item of items) {
      if (!item.selectedByDefault || item.importScope !== 'direct') continue;
      const sameDirSubtree = items.some(
        (other) => other !== item && other.selectedByDefault && other.importScope === 'subtree' && other.sourceRelPath === item.sourceRelPath,
      );
      if (sameDirSubtree) item.selectedByDefault = false;
    }
  }

  /** 历史 / 扫描重复项是否仍指向一个可用的已导入对象（路径 + 索引都要对得上） */
  private importedObjectUsable(root: string, objectId: string, targetRelPath: string): boolean {
    if (!isSafeRelRelPath(targetRelPath)) return false;
    const st = lstatOrNull(join(root, ...targetRelPath.split('/')));
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return false;
    const found = this.deps.lookupObject(objectId);
    return found !== null && found.relPath === targetRelPath;
  }

  private toPlanDto(plan: ImportPlan): WorkImportPlanDto {
    const items: WorkImportCandidateDto[] = plan.items.map((item) => {
      const preview = [...item.ownedFiles].map((file) => file.targetPath).sort(byPosix);
      return {
        itemId: item.itemId,
        unitId: item.unitId,
        sourceRelPath: item.sourceRelPath,
        shape: item.shape,
        role: item.role,
        parentItemId: item.parentItemId,
        confidence: item.confidence,
        suggestedTitle: item.suggestedTitle,
        reasons: [...item.reasons],
        files: item.ownedFiles.length,
        bytes: item.ownedFiles.reduce((sum, file) => sum + file.size, 0),
        filePreview: preview.slice(0, WORK_IMPORT_FILE_PREVIEW),
        filesTruncated: preview.length > WORK_IMPORT_FILE_PREVIEW,
        fingerprint: item.fingerprint,
        duplicate: item.duplicate === null ? null : { ...item.duplicate },
        selectedByDefault: item.selectedByDefault,
        sourceParentRelPath: item.sourceParentRelPath,
        scope: item.importScope,
        isContainer: item.isContainer,
        sourceCount: item.sourceCount,
      };
    });
    return {
      planId: plan.planId,
      sourceRoot: plan.sourceRootAbs,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      totals: { ...plan.totals },
      items,
      warnings: [...plan.warnings],
    };
  }

  /* ---------- 提交 ---------- */

  async commit(input: WorkImportCommitInput): Promise<WorkImportResultDto> {
    const root = this.deps.getManagedRoot();
    const plan = this.plans.get(input.planId);
    if (plan === undefined || plan.expiresAt <= this.deps.now().getTime()) {
      if (plan !== undefined) this.plans.delete(plan.planId);
      throw new WorkError('import-plan-expired', '导入计划不存在或已过期，请重新扫描');
    }
    const rootReal = realpathSync(root);
    if (root !== plan.root || rootReal !== plan.rootReal || this.readRootCreatedAt(root) !== plan.rootCreatedAt) {
      throw new WorkError('import-root-changed', '扫描后受管根变了，请重新扫描');
    }
    if (plan.result !== null) return plan.result;
    if (plan.commit !== null) return plan.commit;

    const run = (async (): Promise<WorkImportResultDto> => {
      await this.recoverNow(root);
      return this.commitNow(plan, input);
    })();
    plan.commit = run;
    try {
      const result = await run;
      plan.result = result;
      return result;
    } catch (err) {
      plan.commit = null;
      throw err;
    }
  }

  private async commitNow(plan: ImportPlan, input: WorkImportCommitInput): Promise<WorkImportResultDto> {
    const selectable: BatchImportSelectableCandidate[] = plan.items.map((item) => ({
      itemId: item.itemId,
      unitId: item.unitId,
      sourceRelPath: item.sourceRelPath,
      importScope: item.importScope,
      suggestedTitle: item.suggestedTitle,
      duplicate: item.duplicate,
      files: item.ownedFiles.length,
    }));
    const resolved = resolveBatchImportSelection(selectable, input.items);
    if (!resolved.ok) throw new WorkError('import-conflict', resolved.issues.join('；'));

    const resolvedById = new Map(resolved.items.map((item) => [item.candidate.itemId, item]));
    const now = this.deps.now();
    const nowIso = now.toISOString();
    const batchId = `imp_${randomBytes(5).toString('hex')}`;
    const manifestRelPath = `.anvil/imports/${localTrashStamp(now)}_${batchId}.json`;
    const manifestAbs = join(plan.root, ...manifestRelPath.split('/'));

    const unitPlans = resolved.units;
    const prepared: PreparedUnit[] = [];
    const usedTargets = new Set<string>();
    const usedObjectIds = new Set<string>();
    // 提交前在写队列里重查一次历史：扫描后可能有别的 plan 已经导入同一来源
    const historyBySource = new Map(this.readHistory(plan.root).entries.map((entry) => [entry.key, entry]));

    for (const unitPlan of unitPlans) {
      const itemId = unitPlan.itemIds[0];
      if (itemId === undefined) throw new WorkError('internal', '空导入单元');
      const planItem = plan.byId.get(itemId);
      if (planItem === undefined) throw new WorkError('internal', '选择结果引用了不存在的候选');
      const resolvedItem = resolvedById.get(itemId);
      if (resolvedItem === undefined) throw new WorkError('internal', '选择结果缺少单元头');

      const committed = historyBySource.get(historyKey(plan.sourceRootReal, planItem.sourceRelPath, planItem.importScope));
      const committedSame =
        committed !== undefined &&
        committed.fingerprint === planItem.fingerprint &&
        this.importedObjectUsable(plan.root, committed.objectId, committed.targetRelPath)
          ? committed
          : null;
      const scanSame =
        planItem.duplicate?.kind === 'same-source' &&
        planItem.duplicate.state === 'same' &&
        planItem.duplicate.objectId !== undefined &&
        planItem.duplicate.targetRelPath !== undefined &&
        this.importedObjectUsable(plan.root, planItem.duplicate.objectId, planItem.duplicate.targetRelPath);
      if (committedSame !== null || scanSame) {
        const objectId = committedSame?.objectId ?? planItem.duplicate?.objectId;
        prepared.push({
          unitId: unitPlan.unitId,
          items: [planItem],
          objects: [],
          targetRelPath: '',
          skip: { reason: '同一来源与内容已经导入过，自动跳过', ...(objectId === undefined ? {} : { objectId }) },
        });
        continue;
      }

      const rel = this.allocateTarget(plan.root, usedTargets, { title: resolvedItem.title, date: now });
      const sourcePath = sourcePathOf(planItem.sourceRelPath);
      prepared.push({
        unitId: unitPlan.unitId,
        items: [planItem],
        objects: [
          {
            itemId: planItem.itemId,
            objectId: this.newObjectId(usedObjectIds),
            title: resolvedItem.title,
            ...(sourcePath === undefined ? {} : { sourcePath }),
            targetRelPath: rel,
            ownedFiles: planItem.ownedFiles,
          },
        ],
        targetRelPath: rel,
        skip: null,
      });
    }

    const manifest = this.buildManifest(plan, resolved.items, prepared, batchId, nowIso);
    this.writeManifest(plan.root, manifestAbs, manifest);

    const resultUnits: WorkImportResultUnitDto[] = [];
    for (const unit of prepared) {
      if (unit.skip !== null) continue;
      try {
        await this.verifyUnit(plan, unit);
        await this.stageUnit(plan, unit, batchId, nowIso);
        this.setManifestUnitState(manifest, unit.unitId, 'staged');
        this.writeManifest(plan.root, manifestAbs, manifest);

        this.publishUnit(plan, unit, batchId);
        this.setManifestUnitState(manifest, unit.unitId, 'published');
        this.writeManifest(plan.root, manifestAbs, manifest);

        this.deps.refreshIndex();
        const missing = unit.objects.filter((object) => {
          const found = this.deps.lookupObject(object.objectId);
          return found === null || found.relPath !== object.targetRelPath;
        });
        if (missing.length > 0) {
          throw new WorkError('import-conflict', `发布后索引找不到对象：${missing.map((o) => o.targetRelPath).join('、')}`);
        }
        this.setManifestUnitState(manifest, unit.unitId, 'success');
        this.writeManifest(plan.root, manifestAbs, manifest);
        resultUnits.push({
          unitId: unit.unitId,
          status: 'success',
          objects: unit.objects.map((object) => ({
            itemId: object.itemId,
            objectId: object.objectId,
            relPath: object.targetRelPath,
          })),
          itemIds: unit.items.map((item) => item.itemId),
        });
      } catch (err) {
        this.cleanupFailedStaging(plan.root, batchId, unit.unitId);
        const error = asError(err);
        const kind = err instanceof WorkError ? err.kind : 'internal';
        const message = err instanceof WorkError ? err.message : `导入失败：${error.message}`;
        this.setManifestUnitState(manifest, unit.unitId, 'failed', kind, message);
        this.writeManifest(plan.root, manifestAbs, manifest);
        resultUnits.push({
          unitId: unit.unitId,
          status: 'failed',
          objects: [],
          itemIds: unit.items.map((item) => item.itemId),
          error: { kind, message },
        });
      }
    }

    this.deps.refreshIndex();
    manifest.finishedAt = this.deps.now().toISOString();
    manifest.status = batchStatus(manifest.units);
    this.writeManifest(plan.root, manifestAbs, manifest);
    this.cleanupStagingBatch(plan.root, batchId);

    const skipped = this.buildSkipped(resolved.items, prepared);
    return { batchId, manifestRelPath: toPosix(manifestRelPath), units: resultUnits, skipped };
  }

  private buildSkipped(
    resolved: Array<ResolvedBatchImportItem<BatchImportSelectableCandidate>>,
    prepared: PreparedUnit[],
  ): WorkImportSkippedDto[] {
    const skipUnits = new Map<string, PreparedUnit>();
    for (const unit of prepared) if (unit.skip !== null) skipUnits.set(unit.unitId, unit);
    const skipped: WorkImportSkippedDto[] = [];
    for (const item of resolved) {
      if (item.selected) {
        const skipUnit = skipUnits.get(item.candidate.unitId);
        if (skipUnit === undefined) continue;
        if (!skipUnit.items.some((unitItem) => unitItem.itemId === item.candidate.itemId)) continue;
        const head = skipUnit.items[0];
        const objectId = head?.itemId === item.candidate.itemId ? skipUnit.skip?.objectId : undefined;
        skipped.push({
          itemId: item.candidate.itemId,
          reason: skipUnit.skip?.reason ?? '自动跳过',
          kind: 'duplicate',
          ...(objectId === undefined ? {} : { objectId }),
        });
        continue;
      }
      skipped.push({ itemId: item.candidate.itemId, reason: '未选中', kind: 'user' });
    }
    return skipped;
  }

  private buildManifest(
    plan: ImportPlan,
    resolved: Array<ResolvedBatchImportItem<BatchImportSelectableCandidate>>,
    prepared: PreparedUnit[],
    batchId: string,
    createdAt: string,
  ): ImportManifest {
    const unitByItem = new Map<string, PreparedUnit>();
    const objectByItem = new Map<string, PreparedObject>();
    for (const unit of prepared) {
      for (const item of unit.items) unitByItem.set(item.itemId, unit);
      for (const object of unit.objects) objectByItem.set(object.itemId, object);
    }
    const resolvedById = new Map(resolved.map((item) => [item.candidate.itemId, item]));

    const units: ManifestUnit[] = prepared
      .filter((unit) => unit.skip === null)
      .map((unit) => ({
        unitId: unit.unitId,
        state: 'planned' as const,
        objectIds: unit.objects.map((object) => object.objectId),
        targetRelPaths: unit.objects.map((object) => object.targetRelPath),
        itemIds: unit.objects.map((object) => object.itemId),
      }));

    const items: ManifestItem[] = plan.items.map((item) => {
      const resolvedItem = resolvedById.get(item.itemId);
      const unit = unitByItem.get(item.itemId);
      const object = objectByItem.get(item.itemId);
      const selected = resolvedItem?.selected === true;
      const inSkippedUnit = unit !== undefined && unit.skip !== null;
      const action: ManifestItem['action'] = selected ? (inSkippedUnit ? 'skip-duplicate' : 'import') : 'skip-user';
      const title = selected ? (resolvedItem?.title ?? item.suggestedTitle) : item.suggestedTitle;
      const parentItemId = item.parentItemId;
      return {
        itemId: item.itemId,
        unitId: unit?.unitId ?? item.unitId,
        sourceRelPath: item.sourceRelPath,
        scope: item.importScope,
        sourceMtime: item.ownedFiles.reduce((max, file) => Math.max(max, file.mtimeMs), 0),
        fingerprint: item.fingerprint,
        action,
        // manifest 是历史事实：5a-4 起批量导入创建的是 problemset；旧 manifest 的 kind 不重写
        kind: 'problemset',
        title,
        parentItemId,
        ...(object === undefined ? {} : { objectId: object.objectId, targetRelPath: object.targetRelPath }),
        status: action === 'import' ? 'pending' : 'skipped',
      };
    });

    return {
      schema: 1,
      batchId,
      sourceRoot: plan.sourceRootReal,
      workspace: { realPath: plan.rootReal, rootCreatedAt: plan.rootCreatedAt },
      createdAt,
      finishedAt: null,
      status: 'running',
      units,
      items,
    };
  }

  /* ---------- 校验 / 暂存 / 发布 ---------- */

  private async verifyUnit(plan: ImportPlan, unit: PreparedUnit): Promise<void> {
    this.assertSourceRootUnchanged(plan);
    const itemById = new Map(plan.items.map((item) => [item.itemId, item]));

    for (const object of unit.objects) {
      const item = itemById.get(object.itemId);
      if (item === undefined) throw new WorkError('internal', '导入单元缺少 plan 项');
      const current =
        item.importScope === 'subtree'
          ? await this.walkDir(plan.sourceRootAbs, item.sourceRelPath, new Set(), new Set())
          : await this.directFilesAt(plan.sourceRootAbs, item.sourceRelPath);
      if (!sameFileSet(item.ownedFiles, current)) {
        throw new WorkError('import-source-changed', `源内容在扫描后发生变化：${displaySource(item.sourceRelPath)}`);
      }
      const currentEntries: ImportFingerprintEntry[] = current.map((file) => {
        const planned = item.ownedFiles.find((owned) => owned.sourcePath === file.sourcePath);
        if (planned === undefined) throw new WorkError('import-source-changed', `源文件集合变化：${file.sourcePath}`);
        return { path: planned.targetPath, size: file.size, sha256: file.sha256 };
      });
      if (sha256Text(importFingerprintInput(currentEntries)) !== item.fingerprint) {
        throw new WorkError('import-source-changed', '源内容在扫描后发生变化，指纹不一致');
      }
    }
  }

  private assertSourceRootUnchanged(plan: ImportPlan): void {
    const st = lstatOrNull(plan.sourceRootAbs);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorkError('import-source-changed', '源目录已不存在或不再是普通目录');
    }
    let real: string;
    try {
      // native realpath 在 Windows 上返回磁盘上的规范大小写，和扫描时一致
      real = realpathSync.native(plan.sourceRootAbs);
    } catch {
      throw new WorkError('import-source-changed', '源目录无法解析');
    }
    if (real !== plan.sourceRootReal) throw new WorkError('import-source-changed', '源目录的真实路径变了');
    for (const item of plan.items) {
      for (const file of item.ownedFiles) {
        if (!within(plan.sourceRootReal, file.absPath, false)) {
          throw new WorkError('import-source-changed', '源文件跑出了扫描时的真实源根');
        }
      }
    }
  }

  private async stageUnit(plan: ImportPlan, unit: PreparedUnit, batchId: string, createdIso: string): Promise<void> {
    // 暂存根也走受管根路径校验：.anvil/import-staging 若是 junction，不能把文件写去根外
    const batchDir = resolveInside(plan.root, `.anvil/import-staging/${batchId}`, { allowMissing: true });
    const unitDir = resolveInside(plan.root, `.anvil/import-staging/${batchId}/${unit.unitId}`, { allowMissing: true });
    if (lstatOrNull(unitDir) !== null) throw new WorkError('import-conflict', '暂存目录已存在，拒绝覆盖');
    mkdirSync(unitDir, { recursive: true });
    assertNoSymlinkComponents(plan.root, unitDir);
    writeFileAtomic(
      join(batchDir, `${unit.unitId}.staging.json`),
      `${JSON.stringify({ schema: 1, batchId, unitId: unit.unitId, startedAt: this.deps.now().toISOString() }, null, 2)}\n`,
    );

    for (const object of unit.objects) {
      if (!isSafeRelRelPath(object.targetRelPath)) throw new WorkError('import-conflict', '目标路径不合法');
      const objectDir = unitDir;
      mkdirSync(objectDir, { recursive: true });
      for (const file of object.ownedFiles) {
        if (!isSafeRelRelPath(file.targetPath)) throw new WorkError('import-conflict', '文件相对路径不合法');
        const dest = join(objectDir, ...file.targetPath.split('/'));
        mkdirSync(dirname(dest), { recursive: true });
        try {
          copyFileSync(file.absPath, dest);
        } catch (err) {
          throw new WorkError('internal', `复制源文件失败：${file.sourcePath}`);
        }
        const st = lstatOrNull(dest);
        if (st === null || !st.isFile() || st.size !== file.size) {
          throw new WorkError('import-source-changed', `暂存校验失败：${file.sourcePath}`);
        }
        const stagedHash = await hashFile(dest);
        if (stagedHash !== file.sha256) {
          throw new WorkError('import-source-changed', `暂存校验失败：${file.sourcePath}`);
        }
      }
    }

    for (const object of unit.objects) {
      const objectDir = unitDir;
      const meta = this.metaOf(object, createdIso);
      writeFileAtomic(join(objectDir, '.anvil.json'), `${JSON.stringify(workMetaToJson(meta), null, 2)}\n`);
    }
  }

  private metaOf(object: PreparedObject, iso: string): WorkMetaRecord {
    const meta: WorkMeta = {
      schema: 1,
      id: object.objectId,
      kind: 'problemset',
      title: object.title,
      createdAt: iso,
      updatedAt: iso,
      parentId: null,
      labels: [],
      links: {},
      archived: false,
      ...(object.sourcePath === undefined ? {} : { sourcePath: object.sourcePath }),
    };
    return { meta, raw: { ...meta } as unknown as Record<string, unknown> };
  }

  private publishUnit(plan: ImportPlan, unit: PreparedUnit, batchId: string): void {
    // 目标路径与暂存路径都逐级拒绝符号链接：桶（contests 等）若是 junction，不能在根外发布
    const finalAbs = resolveInside(plan.root, unit.targetRelPath, { allowMissing: true });
    if (lstatOrNull(finalAbs) !== null) throw new WorkError('import-conflict', '目标路径已被占用，未覆盖');
    const stagingRoot = join(plan.root, '.anvil', 'import-staging');
    const unitDir = resolveInside(plan.root, `.anvil/import-staging/${batchId}/${unit.unitId}`, { allowMissing: true });
    assertWithin(stagingRoot, unitDir, '暂存目录越界');
    if (lstatOrNull(unitDir) === null) throw new WorkError('internal', '暂存目录不存在');
    mkdirSync(dirname(finalAbs), { recursive: true });
    assertNoSymlinkComponents(plan.root, finalAbs);
    renameSync(unitDir, finalAbs);
  }

  private setManifestUnitState(
    manifest: ImportManifest,
    unitId: string,
    state: ManifestUnitState,
    errorKind?: string,
    message?: string,
  ): void {
    const unit = manifest.units.find((item) => item.unitId === unitId);
    if (unit === undefined) return;
    unit.state = state;
    if (errorKind !== undefined) unit.errorKind = errorKind;
    if (message !== undefined) unit.message = message;
    if (state === 'success' || state === 'failed') {
      for (const item of manifest.items) {
        if (item.unitId !== unitId || item.action !== 'import') continue;
        item.status = state === 'success' ? 'success' : 'failed';
        if (state === 'failed') {
          if (errorKind !== undefined) item.errorKind = errorKind;
          if (message !== undefined) item.message = message;
        }
      }
    }
  }

  private writeManifest(root: string, abs: string, manifest: ImportManifest): void {
    if (!within(root, abs, false)) throw new WorkError('unsafe-path', 'manifest 不在受管根内');
    assertNoSymlinkComponents(root, abs);
    writeFileAtomic(abs, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private cleanupFailedStaging(root: string, batchId: string, unitId: string): void {
    try {
      this.cleanupStagingUnit(root, batchId, unitId);
    } catch {
      /* 清理失败不覆盖原始错误；恢复流程会再核对 */
    }
  }

  private cleanupStagingBatch(root: string, batchId: string): void {
    const batchDir = join(root, '.anvil', 'import-staging', batchId);
    try {
      assertNoSymlinkComponents(root, batchDir);
    } catch {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(batchDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.staging.json')) continue;
      const marker = join(batchDir, entry.name);
      const unitId = entry.name.slice(0, -'.staging.json'.length);
      try {
        this.cleanupStagingUnit(root, batchId, unitId);
      } catch {
        /* 保留现场 */
      }
    }
    try {
      rmdirSync(batchDir);
    } catch {
      /* 非空就留着 */
    }
  }

  private cleanupStagingUnit(root: string, batchId: string, unitId: string): boolean {
    if (!isBatchId(batchId) || !isUnitId(unitId)) return false;
    const stagingRoot = join(root, '.anvil', 'import-staging');
    const batchDir = join(stagingRoot, batchId);
    const unitDir = join(batchDir, unitId);
    const markerPath = join(batchDir, `${unitId}.staging.json`);
    if (!within(stagingRoot, unitDir, false) || !within(stagingRoot, markerPath, false)) return false;
    try {
      assertNoSymlinkComponents(root, unitDir);
      assertNoSymlinkComponents(root, markerPath);
    } catch {
      return false;
    }
    const markerStat = lstatOrNull(markerPath);
    if (markerStat === null || markerStat.isSymbolicLink() || !markerStat.isFile()) return false;
    let marker: unknown;
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    } catch {
      return false;
    }
    if (!isRecord(marker) || marker.schema !== 1 || marker.batchId !== batchId || marker.unitId !== unitId) return false;
    const unitStat = lstatOrNull(unitDir);
    if (unitStat !== null) {
      if (unitStat.isSymbolicLink() || !unitStat.isDirectory()) return false;
      rmSync(unitDir, { recursive: true, force: true });
    }
    try {
      unlinkSync(markerPath);
    } catch {
      /* 已删 */
    }
    return true;
  }

  /* ---------- 恢复 ---------- */

  async recover(): Promise<{ warnings: string[] }> {
    const root = this.deps.getManagedRoot();
    return this.recoverNow(root);
  }

  private async recoverNow(root: string): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    this.deps.refreshIndex();
    for (const manifestAbs of this.manifestFiles(root)) {
      const parsed = this.readManifest(manifestAbs);
      if (!parsed.ok) {
        warnings.push(`manifest 损坏，已忽略：${basename(manifestAbs)}（${parsed.message}）`);
        continue;
      }
      const manifest = parsed.manifest;
      if (manifest.status !== 'running') continue;
      for (const unit of manifest.units) {
        if (unit.state === 'success' || unit.state === 'failed') continue;
        const targetExists =
          unit.targetRelPaths.length > 0 &&
          unit.targetRelPaths.every((rel) => {
            if (!isSafeRelRelPath(rel)) return false;
            const st = lstatOrNull(join(root, ...rel.split('/')));
            return st !== null && st.isDirectory() && !st.isSymbolicLink();
          });
        const allObjects = unit.objectIds.every((id) => {
          const found = this.deps.lookupObject(id);
          if (found === null) return false;
          const index = unit.objectIds.indexOf(id);
          return unit.targetRelPaths[index] === undefined || found.relPath === unit.targetRelPaths[index];
        });

        if (unit.state === 'planned' || unit.state === 'staged') {
          if (targetExists) {
            if (allObjects) {
              unit.state = 'success';
              this.markRecoveredItems(manifest, unit, 'success');
            } else {
              unit.state = 'failed';
              unit.errorKind = 'import-conflict';
              unit.message = '恢复对账失败：目标已存在但找不到全部对象';
              this.markRecoveredItems(manifest, unit, 'failed', unit.errorKind, unit.message);
            }
          } else if (this.cleanupStagingUnit(root, manifest.batchId, unit.unitId)) {
            unit.state = 'failed';
            unit.errorKind = 'import-source-changed';
            unit.message = '恢复：未发布的暂存已清理，请重新扫描导入';
            this.markRecoveredItems(manifest, unit, 'failed', unit.errorKind, unit.message);
          } else {
            unit.state = 'failed';
            unit.errorKind = 'import-conflict';
            unit.message = '恢复：暂存目录没有合法标记，保留现场未删除';
            this.markRecoveredItems(manifest, unit, 'failed', unit.errorKind, unit.message);
          }
          continue;
        }

        if (unit.state === 'published') {
          if (allObjects && targetExists) {
            unit.state = 'success';
            this.markRecoveredItems(manifest, unit, 'success');
          } else {
            unit.state = 'failed';
            unit.errorKind = 'import-conflict';
            unit.message = '恢复对账失败：已发布的对象不完整，保留现场';
            this.markRecoveredItems(manifest, unit, 'failed', unit.errorKind, unit.message);
          }
        }
      }
      manifest.finishedAt = this.deps.now().toISOString();
      manifest.status = batchStatus(manifest.units);
      this.writeManifest(root, manifestAbs, manifest);
      if (manifest.units.some((unit) => unit.state === 'failed')) {
        warnings.push(`恢复导入批次 ${manifest.batchId}：存在失败单元，现场已保留`);
      }
    }
    return { warnings };
  }

  private markRecoveredItems(
    manifest: ImportManifest,
    unit: ManifestUnit,
    status: 'success' | 'failed',
    errorKind?: string,
    message?: string,
  ): void {
    for (const item of manifest.items) {
      if (item.unitId !== unit.unitId || item.action !== 'import') continue;
      item.status = status;
      if (status === 'failed') {
        if (errorKind !== undefined) item.errorKind = errorKind;
        if (message !== undefined) item.message = message;
      }
    }
  }

  /* ---------- manifest / history ---------- */

  private manifestFiles(root: string): string[] {
    const dir = join(root, '.anvil', 'imports');
    const st = lstatOrNull(dir);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return [];
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => byPosix(toPosix(a), toPosix(b)));
  }

  private readHistory(root: string): { entries: HistoryEntry[]; warnings: string[] } {
    const entries = new Map<string, HistoryEntry>();
    const warnings: string[] = [];
    for (const abs of this.manifestFiles(root)) {
      const parsed = this.readManifest(abs);
      if (!parsed.ok) {
        warnings.push(`manifest 损坏，已忽略：${basename(abs)}（${parsed.message}）`);
        continue;
      }
      const manifest = parsed.manifest;
      if (manifest.status === 'running') {
        warnings.push(`导入批次 ${manifest.batchId} 还没收尾；下次提交会自动对账`);
      } else if (manifest.units.some((unit) => unit.state === 'failed')) {
        warnings.push(`导入批次 ${manifest.batchId} 有失败单元，现场已保留`);
      }
      const successUnits = new Set(manifest.units.filter((unit) => unit.state === 'success').map((unit) => unit.unitId));
      for (const item of manifest.items) {
        if (item.action !== 'import' || item.status !== 'success') continue;
        if (!successUnits.has(item.unitId)) continue;
        if (item.sourceRelPath !== '' && !isSafeRelRelPath(item.sourceRelPath)) continue;
        const targetRelPath = item.targetRelPath;
        if (targetRelPath === undefined || !isSafeRelRelPath(targetRelPath) || item.objectId === undefined) continue;
        if (typeof item.fingerprint !== 'string' || item.fingerprint === '') continue;
        const key = historyKey(manifest.sourceRoot, item.sourceRelPath, item.scope);
        entries.set(key, {
          key,
          sourcePath: sourceKey(manifest.sourceRoot, item.sourceRelPath),
          scope: item.scope,
          fingerprint: item.fingerprint,
          objectId: item.objectId,
          targetRelPath,
        });
      }
    }
    return { entries: [...entries.values()], warnings };
  }

  private readManifest(abs: string): { ok: true; manifest: ImportManifest } | { ok: false; message: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      return { ok: false, message: asError(err).message };
    }
    return parseManifest(raw);
  }

  /* ---------- 源目录 IO ---------- */

  private async scanSource(sourceAbs: string): Promise<{ files: ScannedFile[]; dirs: string[]; ignored: number }> {
    const files: ScannedFile[] = [];
    const dirs: string[] = [];
    let ignored = 0;
    let bytes = 0;

    const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        throw new WorkError('import-source-invalid', `源目录读取失败：${displaySource(relDir)}`);
      }
      entries.sort((a, b) => byPosix(a.name, b.name));
      for (const entry of entries) {
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (isIgnoredName(entry.name, entry.isDirectory())) {
          ignored += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          ignored += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (depth + 1 > this.limits.maxDepth) {
            throw new WorkError('import-limit', `源目录深度超过上限（${this.limits.maxDepth} 层）`);
          }
          dirs.push(rel);
          await walk(join(absDir, entry.name), rel, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          ignored += 1;
          continue;
        }
        const abs = join(absDir, entry.name);
        let st;
        try {
          st = lstatSync(abs);
        } catch (err) {
          throw new WorkError('import-source-invalid', `源文件读取失败：${displaySource(rel)}`);
        }
        if (st.isSymbolicLink() || !st.isFile()) {
          ignored += 1;
          continue;
        }
        if (st.size > this.limits.maxFileBytes) {
          throw new WorkError('import-limit', `单文件超过上限（${displaySource(rel)} > ${this.limits.maxFileBytes} 字节）`);
        }
        if (files.length >= this.limits.maxFiles) {
          throw new WorkError('import-limit', `源文件数超过上限（${this.limits.maxFiles}）`);
        }
        bytes += st.size;
        if (bytes > this.limits.maxBytes) {
          throw new WorkError('import-limit', `源文件总字节超过上限（${this.limits.maxBytes}）`);
        }
        let sha256: string;
        try {
          sha256 = await hashFile(abs);
        } catch (err) {
          throw new WorkError('import-source-invalid', `源文件读取失败：${displaySource(rel)}`);
        }
        files.push({ sourcePath: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, sha256 });
      }
    };

    await walk(sourceAbs, '', 0);
    return { files, dirs, ignored };
  }

  private async walkDir(
    sourceRootAbs: string,
    relDir: string,
    excludeDirs: Set<string>,
    excludeFiles: Set<string>,
  ): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    let bytes = 0;
    const startAbs = join(sourceRootAbs, ...relDir.split('/').filter((part) => part !== ''));
    const startStat = lstatOrNull(startAbs);
    if (startStat === null || startStat.isSymbolicLink() || !startStat.isDirectory()) {
      throw new WorkError('import-source-changed', `源目录不可用：${displaySource(relDir)}`);
    }

    const walk = async (absDir: string, currentRel: string, depth: number): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        throw new WorkError('import-source-changed', `源目录读取失败：${displaySource(currentRel)}`);
      }
      entries.sort((a, b) => byPosix(a.name, b.name));
      for (const entry of entries) {
        const rel = currentRel === '' ? entry.name : `${currentRel}/${entry.name}`;
        if (isIgnoredName(entry.name, entry.isDirectory()) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (excludeDirs.has(rel)) continue;
          if (depth + 1 > this.limits.maxDepth) {
            throw new WorkError('import-source-changed', '源目录深度超过扫描上限，按变化处理');
          }
          await walk(join(absDir, entry.name), rel, depth + 1);
          continue;
        }
        if (!entry.isFile() || excludeFiles.has(rel)) continue;
        const abs = join(absDir, entry.name);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          throw new WorkError('import-source-changed', `源文件不可读：${displaySource(rel)}`);
        }
        if (st.isSymbolicLink() || !st.isFile()) continue;
        if (st.size > this.limits.maxFileBytes || files.length >= this.limits.maxFiles) {
          throw new WorkError('import-source-changed', '源文件集合超过扫描上限，按变化处理');
        }
        bytes += st.size;
        if (bytes > this.limits.maxBytes) {
          throw new WorkError('import-source-changed', '源文件总字节超过扫描上限，按变化处理');
        }
        let sha256: string;
        try {
          sha256 = await hashFile(abs);
        } catch {
          throw new WorkError('import-source-changed', `源文件不可读：${displaySource(rel)}`);
        }
        files.push({ sourcePath: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, sha256 });
      }
    };

    await walk(startAbs, relDir, relDir === '' ? 0 : relDir.split('/').length);
    return files.sort((a, b) => byPosix(a.sourcePath, b.sourcePath));
  }

  /** 散题 scope：只读取目录的直接文件，不进入下级目录 */
  private async directFilesAt(sourceRootAbs: string, dirRel: string): Promise<ScannedFile[]> {
    const dirAbs = join(sourceRootAbs, ...dirRel.split('/').filter((part) => part !== ''));
    const dirStat = lstatOrNull(dirAbs);
    if (dirStat === null || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new WorkError('import-source-changed', `源目录不可用：${displaySource(dirRel)}`);
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      throw new WorkError('import-source-changed', `源目录读取失败：${displaySource(dirRel)}`);
    }
    entries.sort((a, b) => byPosix(a.name, b.name));
    const files: ScannedFile[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (isIgnoredName(entry.name, false)) continue;
      const abs = join(dirAbs, entry.name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        throw new WorkError('import-source-changed', `源文件不可读：${displaySource(entry.name)}`);
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (st.size > this.limits.maxFileBytes || files.length >= this.limits.maxFiles) {
        throw new WorkError('import-source-changed', '源文件集合超过扫描上限，按变化处理');
      }
      bytes += st.size;
      if (bytes > this.limits.maxBytes) {
        throw new WorkError('import-source-changed', '源文件总字节超过扫描上限，按变化处理');
      }
      let sha256: string;
      try {
        sha256 = await hashFile(abs);
      } catch {
        throw new WorkError('import-source-changed', `源文件不可读：${displaySource(entry.name)}`);
      }
      files.push({
        sourcePath: dirRel === '' ? entry.name : `${dirRel}/${entry.name}`,
        absPath: abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha256,
      });
    }
    return files;
  }

  /* ---------- 路径分配 ---------- */

  private allocateTarget(
    root: string,
    used: Set<string>,
    input: { title: string; date: Date },
  ): string {
    const base = buildWorkRelPath('problemset', input);
    if (!base.ok) throw new WorkError('import-conflict', base.message);
    const trySlug = (slug: string): string | null => {
      const built = buildWorkRelPath('problemset', { ...input, slugOverride: slug });
      if (!built.ok) return null;
      const rel = built.value.relPath;
      if (used.has(rel)) return null;
      // 逐级拒绝符号链接 / junction；父桶若是链接，直接报 unsafe-path，不换后缀重试
      const abs = resolveInside(root, rel, { allowMissing: true });
      if (lstatOrNull(abs) !== null) return null;
      return rel;
    };
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const rel = trySlug(attempt === 1 ? base.value.slug : slugForAttempt(base.value.slug, attempt));
      if (rel !== null) {
        used.add(rel);
        return rel;
      }
    }
    for (let i = 0; i < 10; i += 1) {
      const rel = trySlug(slugWithRandomSuffix(base.value.slug, randomBytes(2).toString('hex')));
      if (rel !== null) {
        used.add(rel);
        return rel;
      }
    }
    throw new WorkError('import-conflict', '分配目标目录失败：同名目录太多');
  }

  private newObjectId(used: Set<string>): string {
    for (;;) {
      const id = `obj_${randomBytes(5).toString('hex')}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  }

  /* ---------- 根 ---------- */

  private readRootCreatedAt(root: string): string {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(root, '.anvil', 'root.json'), 'utf8'));
    } catch {
      throw new WorkError('root-version', '.anvil/root.json 读不出来');
    }
    const createdAt = isRecord(raw) ? raw.createdAt : undefined;
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
      throw new WorkError('root-version', '.anvil/root.json 缺少合法 createdAt');
    }
    return createdAt;
  }
}

/* ------------------------------------------------------------------ */
/* 纯辅助                                                              */
/* ------------------------------------------------------------------ */

function displaySource(rel: string): string {
  return rel === '' ? '（源根）' : rel;
}

function sameFileSet(expected: ImportFile[], current: ScannedFile[]): boolean {
  const a = [...expected].sort((x, y) => byPosix(x.sourcePath, y.sourcePath));
  const b = [...current].sort((x, y) => byPosix(x.sourcePath, y.sourcePath));
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) return false;
    if (left.sourcePath !== right.sourcePath || left.size !== right.size || left.mtimeMs !== right.mtimeMs || left.sha256 !== right.sha256) {
      return false;
    }
  }
  return true;
}

function batchStatus(units: ManifestUnit[]): ManifestStatus {
  if (units.length === 0) return 'completed';
  const success = units.filter((unit) => unit.state === 'success').length;
  const failed = units.filter((unit) => unit.state === 'failed').length;
  if (success === units.length) return 'completed';
  if (failed === units.length) return 'failed';
  return 'partial';
}

function assertWithin(base: string, target: string, message: string): void {
  if (!within(base, target, false)) throw new WorkError('unsafe-path', message);
}


function parseManifest(raw: unknown): { ok: true; manifest: ImportManifest } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'manifest 不是对象' };
  if (raw.schema !== 1) return { ok: false, message: `不支持的 schema：${String(raw.schema)}` };
  if (!isBatchId(raw.batchId)) return { ok: false, message: 'batchId 不合法' };
  if (typeof raw.sourceRoot !== 'string' || raw.sourceRoot === '') return { ok: false, message: 'sourceRoot 不合法' };
  const workspace = raw.workspace;
  if (!isRecord(workspace) || typeof workspace.realPath !== 'string' || typeof workspace.rootCreatedAt !== 'string') {
    return { ok: false, message: 'workspace 不完整' };
  }
  if (typeof raw.createdAt !== 'string' || (raw.finishedAt !== null && typeof raw.finishedAt !== 'string')) {
    return { ok: false, message: '时间字段不合法' };
  }
  if (raw.status !== 'running' && raw.status !== 'completed' && raw.status !== 'partial' && raw.status !== 'failed') {
    return { ok: false, message: 'status 不合法' };
  }
  if (!Array.isArray(raw.units) || !Array.isArray(raw.items)) return { ok: false, message: 'units / items 必须是数组' };
  const units: ManifestUnit[] = [];
  for (const value of raw.units) {
    if (!isRecord(value)) return { ok: false, message: 'unit 不是对象' };
    if (!isUnitId(value.unitId)) return { ok: false, message: 'unitId 不合法' };
    if (!['planned', 'staged', 'published', 'success', 'failed'].includes(String(value.state))) {
      return { ok: false, message: 'unit.state 不合法' };
    }
    if (!Array.isArray(value.objectIds) || !Array.isArray(value.targetRelPaths) || !Array.isArray(value.itemIds)) {
      return { ok: false, message: 'unit 数组字段不完整' };
    }
    units.push({
      unitId: value.unitId,
      state: value.state as ManifestUnitState,
      objectIds: value.objectIds.filter((x): x is string => typeof x === 'string'),
      targetRelPaths: value.targetRelPaths.filter((x): x is string => typeof x === 'string'),
      itemIds: value.itemIds.filter((x): x is string => typeof x === 'string'),
      ...(typeof value.errorKind === 'string' ? { errorKind: value.errorKind } : {}),
      ...(typeof value.message === 'string' ? { message: value.message } : {}),
    });
  }
  const items: ManifestItem[] = [];
  for (const value of raw.items) {
    if (!isRecord(value)) return { ok: false, message: 'item 不是对象' };
    if (typeof value.itemId !== 'string' || typeof value.unitId !== 'string') return { ok: false, message: 'item 身份不完整' };
    if (typeof value.sourceRelPath !== 'string') return { ok: false, message: 'item.sourceRelPath 不合法' };
    if (value.action !== 'import' && value.action !== 'skip-user' && value.action !== 'skip-duplicate') {
      return { ok: false, message: 'item.action 不合法' };
    }
    if (value.status !== 'pending' && value.status !== 'success' && value.status !== 'skipped' && value.status !== 'failed') {
      return { ok: false, message: 'item.status 不合法' };
    }
    items.push({
      itemId: value.itemId,
      unitId: value.unitId,
      sourceRelPath: value.sourceRelPath,
      scope: value.scope === 'direct' ? 'direct' : 'subtree',
      sourceMtime: typeof value.sourceMtime === 'number' ? value.sourceMtime : 0,
      fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : '',
      action: value.action,
      kind: value.kind === 'contest' ? 'contest' : value.kind === 'problemset' ? 'problemset' : 'problem',
      title: typeof value.title === 'string' ? value.title : '',
      parentItemId: typeof value.parentItemId === 'string' ? value.parentItemId : null,
      ...(typeof value.objectId === 'string' ? { objectId: value.objectId } : {}),
      ...(typeof value.targetRelPath === 'string' ? { targetRelPath: value.targetRelPath } : {}),
      status: value.status,
      ...(typeof value.errorKind === 'string' ? { errorKind: value.errorKind } : {}),
      ...(typeof value.message === 'string' ? { message: value.message } : {}),
    });
  }
  return {
    ok: true,
    manifest: {
      schema: 1,
      batchId: raw.batchId,
      sourceRoot: raw.sourceRoot,
      workspace: { realPath: workspace.realPath, rootCreatedAt: workspace.rootCreatedAt },
      createdAt: raw.createdAt,
      finishedAt: raw.finishedAt as string | null,
      status: raw.status,
      units,
      items,
    },
  };
}
