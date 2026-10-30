/**
 * 工坊服务（docs/contracts/23）：`.anvil.json` 是权威，内存索引只是缓存。
 * 所有写操作走单 Promise 队列；所有元数据写入走 writeFileAtomic；不新增 SQLite 表。
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, type Dirent } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  arenaTrashIdOk,
  buildWorkRelPath,
  cleanLabels,
  collectProblemTags,
  contestPathOk,
  defaultTemplateOf,
  isImportSourceName,
  isWorkKind,
  parseWorkMeta,
  problemMarkSummaryOf,
  projectLegacyReview,
  slugForAttempt,
  slugWithRandomSuffix,
  unregisteredKindHint,
  workIdOk,
  workMetaToJson,
  WORK_TEMPLATE_CONTENT_MAX,
  type ArenaRecord,
  type ArenaRecordCreateInput,
  type ArenaRecordCreateResult,
  type ArenaRecordItemDto,
  type ArenaRecordRenameInput,
  type ArenaRecordsListDto,
  type ArenaRecordRestoreResult,
  type ArenaRecordTrashInput,
  type ArenaRecordTrashResult,
  type ArenaRecordUpdateInput,
  type ArenaLegacyRecordDto,
  type WorkFileDto,
  type WorkImportCommitInput,
  type WorkImportPlanDto,
  type WorkImportResultDto,
  type WorkImportScanInput,
  type WorkKind,
  type WorkOpenApp,
  type WorkMeta,
  type WorkMetaRecord,
  type ProblemMarkSummary,
  type ProblemMarksDto,
  type ProblemMarksFile,
  type WorkArenaGhost,
  type WorkObjectDetailDto,
  type WorkObjectDto,
  type WorkScanErrorDto,
  type WorkTemplateFileDto,
  type WorkTemplateSaveInput,
  type WorkTreeDto,
  type WorkTrashDto,
  type WorkTrashObjectDto,
  type WorkTrashPurgeResult,
  type WorkUnregisteredDto,
} from '@anvil/shared';
import { writeFileAtomic } from '../atomic.ts';
import { vaultDir as defaultVaultDir } from '../config.ts';
import { WorkError } from './errors.ts';
import { WorkImportService } from './import.ts';
import { defaultFindCode, nodeSpawn, openTargetWithApp, type SpawnFn } from './open.ts';
import {
  TOP_BUCKETS,
  assertNoSymlinkComponents,
  isIgnoredName,
  lstatOrNull,
  localTrashStamp,
  relPosix,
  resolveInside,
  toPosix,
  validateRootPath,
  within,
} from './paths.ts';
import {
  createRecordFile,
  parseRecordTrashManifest,
  readRecordFile,
  renameRecordFile,
  restoreRecordFile,
  scanContestRecords,
  trashRecordFile,
  updateRecordFile,
  type RecordHostInfo,
  type RecordTrashManifest,
} from './records.ts';
import {
  problemMarksDetailOf,
  readProblemMarks,
  syncProblemMarks,
  updateProblemMarks,
} from './problem-marks.ts';

export interface WorkServiceDeps {
  db: DatabaseSync;
  getRoot: () => string;
  setRoot: (root: string) => void;
  spawn?: SpawnFn;
  findCode?: () => string | null;
  now?: () => Date;
  repoRoot?: string;
  vaultDir?: string;
  /** 榜单快照缓存目录（默认 vault/arena）；成绩保存只读这里，不发起上游请求 */
  arenaDir?: string;
  /** 仅测试注入导入上限；生产固定用契约 §4.4 */
  importLimits?: Partial<Record<'maxDepth' | 'maxFiles' | 'maxBytes' | 'maxFileBytes' | 'maxCandidates', number>>;
}

export interface WorkCreateInput {
  kind: WorkKind;
  title?: string;
  parentId?: string;
  problemKey?: string;
  arenaPath?: string;
  /** 省略 = 用默认模板；null / '' = 明确不复制模板；字符串 = 指定模板 */
  templateId?: string | null;
}

export interface WorkAdoptInput {
  relPath: string;
  kind: WorkKind;
  title?: string;
  /** 仅 problemset：可选关联的比赛（逻辑 parentId，不搬目录） */
  parentId?: string | null;
}

export interface WorkUpdateInput {
  id: string;
  title?: string;
  labels?: unknown;
  archived?: boolean;
  /** 仅 problemset：null = 清除关联 */
  parentId?: string | null;
}

export interface ProblemMarksSyncServiceInput {
  arenaPath: string;
  problems: unknown;
  recordId?: string;
}

export interface ProblemMarksUpdateServiceInput {
  arenaPath: string;
  expectedRevision: string;
  marks: unknown;
}

export interface WorkInitInput {
  path: string;
  confirmExisting?: boolean;
}

/** 服务层多带一个 created：路由据此回 201 / 200，响应正文仍按契约只给 record / revision / object */
export interface ArenaRecordCreateServiceResult extends ArenaRecordCreateResult {
  created: boolean;
}

export interface WorkRescanSummary {
  scannedAt: number;
  objects: number;
  added: number;
  removed: number;
  unregistered: number;
  errors: number;
}

interface IndexedObject {
  record: WorkMetaRecord;
  relPath: string;
  absPath: string;
  root: string;
  files: WorkFileDto[];
  fileCount: number;
  sourceCount: number;
  filesTruncated: boolean;
  effectiveArchived: boolean;
  /** 仅带 arenaPath 的比赛且标记文件合法时有值 */
  problemMarkSummary?: ProblemMarkSummary;
}

interface WorkIndex {
  root: string;
  scannedAt: number;
  objects: IndexedObject[];
  byId: Map<string, IndexedObject>;
  byRel: Map<string, IndexedObject>;
  trash: WorkTrashDto[];
  trashDirs: Map<string, string>;
  unregistered: WorkUnregisteredDto[];
  errors: WorkScanErrorDto[];
  /** 扫描时读到的合法标记文件（用于标签补全汇总） */
  problemMarkFiles: ProblemMarksFile[];
}

interface CollectedObject {
  record: WorkMetaRecord;
  relPath: string;
  absPath: string;
  files: WorkFileDto[];
  fileCount: number;
  sourceCount: number;
  filesTruncated: boolean;
}

interface TemplateFileState {
  path: string;
  absPath: string;
  exists: boolean;
  content: string;
  revision: string | null;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

function joinRel(relDir: string, name: string): string {
  return relDir === '' ? name : `${relDir}/${name}`;
}

function comparePosix(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 服务端本地日期（与全站时区口径一致，不是比赛日期） */
function localStamp(date: Date): string {
  return localTrashStamp(date);
}

export class WorkService {
  private readonly deps: WorkServiceDeps;
  private index: WorkIndex | null = null;
  /** 写操作串行化；rescan 也排进同一条队列 */
  private tail: Promise<unknown> = Promise.resolve();
  /** 旧代码导入（切片 5a-2）：plan 在内存，发布与恢复共用同一条写队列 */
  private readonly imports: WorkImportService;

  constructor(deps: WorkServiceDeps) {
    this.deps = deps;
    this.imports = new WorkImportService({
      getManagedRoot: () => this.readRootState(),
      refreshIndex: () => {
        this.refreshIndex();
      },
      lookupObject: (id) => {
        const obj = this.ensureIndex().byId.get(id);
        return obj === undefined ? null : { id: obj.record.meta.id, relPath: obj.relPath };
      },
      now: () => this.nowDate(),
      ...(deps.importLimits === undefined ? {} : { limits: deps.importLimits }),
    });
  }

  /** 只读扫描：plan 在内存，扫描阶段不写受管根 */
  importScan(input: WorkImportScanInput): Promise<WorkImportPlanDto> {
    return this.enqueue(() => this.imports.scan(input));
  }

  importCommit(input: WorkImportCommitInput): Promise<WorkImportResultDto> {
    return this.enqueue(() => this.imports.commit(input));
  }

  /** journal 对账入口；commit 前也会自动跑一次 */
  recoverImports(): Promise<{ warnings: string[] }> {
    return this.enqueue(() => this.imports.recover());
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private nowDate(): Date {
    return this.deps.now === undefined ? new Date() : this.deps.now();
  }

  /* ------------------------------------------------------------------ */
  /* 根与索引                                                            */
  /* ------------------------------------------------------------------ */

  private readRootState(): string {
    const raw = this.deps.getRoot().trim();
    if (raw === '') throw new WorkError('workspace-unconfigured', '还没有配置工坊受管根');
    const abs = validateRootPath(raw, { repoRoot: this.deps.repoRoot, vaultDir: this.deps.vaultDir });
    const st = lstatOrNull(abs);
    if (st === null) throw new WorkError('root-missing', `受管根不存在：${abs}`);
    if (st.isSymbolicLink()) throw new WorkError('root-invalid', '受管根不能是符号链接');
    if (!st.isDirectory()) throw new WorkError('root-missing', `受管根不是目录：${abs}`);
    const anvil = lstatOrNull(join(abs, '.anvil'));
    if (anvil !== null && (anvil.isSymbolicLink() || !anvil.isDirectory())) {
      throw new WorkError('root-invalid', '.anvil 必须是受管根内的普通目录');
    }
    const rootJson = join(abs, '.anvil', 'root.json');
    const rootJsonStat = lstatOrNull(rootJson);
    if (rootJsonStat === null) throw new WorkError('workspace-uninitialized', '受管根还没有初始化');
    if (rootJsonStat.isSymbolicLink() || !rootJsonStat.isFile()) {
      throw new WorkError('root-version', '.anvil/root.json 必须是普通文件，不允许符号链接');
    }
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(rootJson, 'utf8'));
    } catch {
      throw new WorkError('root-version', '.anvil/root.json 读不懂，拒绝按当前版本处理');
    }
    const schema = (data as { schema?: unknown } | null)?.schema;
    if (schema !== 1) throw new WorkError('root-version', `不支持的 root.json schema：${String(schema)}`);
    return abs;
  }

  private ensureIndex(): WorkIndex {
    const root = this.readRootState();
    if (this.index === null || this.index.root !== root) this.index = this.buildIndex(root);
    return this.index;
  }

  private refreshIndex(): WorkIndex {
    const root = this.readRootState();
    this.index = this.buildIndex(root);
    return this.index;
  }

  /* ------------------------------------------------------------------ */
  /* 对外读                                                              */
  /* ------------------------------------------------------------------ */

  async tree(opts: { archived?: boolean; rescan?: boolean } = {}): Promise<WorkTreeDto> {
    if (opts.rescan === true) await this.enqueue(() => this.rescanNow(false));
    const idx = this.ensureIndex();
    return this.toTree(idx, opts.archived === true);
  }

  object(id: string): WorkObjectDetailDto {
    const idx = this.ensureIndex();
    const obj = idx.byId.get(id);
    if (obj === undefined) throw new WorkError('not-found', '找不到这个对象');
    return this.detailOf(obj);
  }

  rescan(): Promise<WorkRescanSummary> {
    return this.enqueue(() => this.rescanNow(true));
  }

  /** 模板详情的内联编辑只读写一个主文件（切片 5a.1） */
  getTemplate(id: string): WorkTemplateFileDto {
    const idx = this.ensureIndex();
    const obj = idx.byId.get(id);
    if (obj === undefined) throw new WorkError('not-found', '找不到这个对象');
    if (obj.record.meta.kind !== 'template') throw new WorkError('invalid', '只有模板对象有可编辑的模板文件');
    const state = this.templateStateOf(idx.root, obj);
    return { path: state.path, exists: state.exists, content: state.content, revision: state.revision };
  }

  saveTemplate(input: WorkTemplateSaveInput): Promise<WorkTemplateFileDto> {
    return this.enqueue(() => this.saveTemplateNow(input));
  }

  /* ------------------------------------------------------------------ */
  /* 榜单多存档（docs/contracts/29）                                     */
  /* ------------------------------------------------------------------ */

  private arenaDirPath(): string {
    return this.deps.arenaDir ?? join(this.deps.vaultDir ?? defaultVaultDir, 'arena');
  }

  private hostOf(idx: WorkIndex, obj: IndexedObject): RecordHostInfo {
    const arenaPath = obj.record.meta.links.arenaPath;
    if (obj.record.meta.kind !== 'contest' || arenaPath === undefined) {
      throw new WorkError('invalid', '只有带榜单路径的比赛可以管理成绩存档');
    }
    return {
      root: idx.root,
      contestId: obj.record.meta.id,
      contestRelPath: obj.relPath,
      contestAbs: obj.absPath,
      arenaPath,
      effectiveArchived: obj.effectiveArchived,
    };
  }

  /** 按 arenaPath 找唯一宿主；重复 / 在回收站都是 409，完全没有宿主才返回 null（仅列表允许空） */
  private contestForArena(idx: WorkIndex, arenaPath: string): IndexedObject | null {
    if (!contestPathOk(arenaPath)) throw new WorkError('invalid', 'arenaPath 不在榜单路径白名单内');
    const matches = idx.objects.filter(
      (obj) => obj.record.meta.kind === 'contest' && obj.record.meta.links.arenaPath === arenaPath,
    );
    if (matches.length > 1) throw new WorkError('conflict', `有 ${matches.length} 个 contest 指向同一场，先清理重复对象`);
    if (matches.length === 1) return matches[0]!;
    const trashed = this.trashedContestForArena(idx, arenaPath);
    if (trashed !== null) {
      throw new WorkError('conflict', `这场比赛在回收站里（${trashed.title}）；先恢复它再操作成绩`);
    }
    return null;
  }

  private requireContestForArena(idx: WorkIndex, arenaPath: string): IndexedObject {
    const obj = this.contestForArena(idx, arenaPath);
    if (obj === null) throw new WorkError('not-found', '工坊里还没有这场比赛');
    return obj;
  }

  private trashedRecordIdsFor(idx: WorkIndex, contestId: string): Set<string> {
    const out = new Set<string>();
    for (const item of idx.trash) {
      if (item.entryType === 'arena-record' && item.contestId === contestId) out.add(item.recordId);
    }
    return out;
  }

  listArenaRecords(arenaPath: string): ArenaRecordsListDto {
    const idx = this.ensureIndex();
    const obj = this.contestForArena(idx, arenaPath);
    if (obj === null) return { contestId: null, records: [], legacy: null, errors: [] };
    return scanContestRecords(this.hostOf(idx, obj));
  }

  getArenaRecordItem(arenaPath: string, recordId: string): ArenaRecordItemDto {
    const idx = this.ensureIndex();
    const obj = this.requireContestForArena(idx, arenaPath);
    const read = readRecordFile(this.hostOf(idx, obj), recordId);
    if (read.kind === 'missing') throw new WorkError('not-found', '找不到这份存档');
    if (read.kind === 'legacy-live') {
      throw new WorkError('not-found', '旧进度不在正式成绩里；用旧进度接口读取');
    }
    if (read.kind === 'legacy-review') {
      return { record: projectLegacyReview(read.record, obj.record.meta.id), revision: read.revision };
    }
    return { record: read.record, revision: read.revision };
  }

  /** 旧根文件原格式（只读）：review 已在 records 里投影，这里主要给旧 live 的“恢复为当前练习” */
  getArenaLegacy(arenaPath: string): ArenaLegacyRecordDto {
    const idx = this.ensureIndex();
    const obj = this.requireContestForArena(idx, arenaPath);
    const read = readRecordFile(this.hostOf(idx, obj), 'legacy');
    if (read.kind === 'missing') throw new WorkError('not-found', '这场没有旧根记录');
    if (read.kind === 'record') throw new WorkError('not-found', '旧根记录已经升级为正式存档');
    return { mode: read.kind === 'legacy-review' ? 'review' : 'live', record: read.record, revision: read.revision };
  }

  createArenaRecord(input: ArenaRecordCreateInput): Promise<ArenaRecordCreateServiceResult> {
    return this.enqueue(() => this.createArenaRecordNow(input));
  }

  private createArenaRecordNow(input: ArenaRecordCreateInput): ArenaRecordCreateServiceResult {
    if (!contestPathOk(input.arenaPath)) throw new WorkError('invalid', 'arenaPath 不在榜单路径白名单内');
    let idx = this.ensureIndex();
    let obj = this.contestForArena(idx, input.arenaPath);
    if (obj === null) {
      const stem = input.arenaPath.split('/').pop()?.replace(/\.srk\.json$/, '') ?? input.arenaPath;
      const title = (input.contestTitle ?? '').trim() || stem;
      const made = this.createNow({ kind: 'contest', title, arenaPath: input.arenaPath });
      idx = this.ensureIndex();
      const created = idx.byId.get(made.id);
      if (created === undefined) throw new WorkError('internal', '保存成绩时创建的比赛对象没有进入索引');
      obj = created;
    }
    const outcome = createRecordFile(this.hostOf(idx, obj), input, {
      now: this.nowDate(),
      arenaDir: this.arenaDirPath(),
      trashedRecordIds: this.trashedRecordIdsFor(idx, obj.record.meta.id),
    });
    const fresh = this.refreshIndex();
    const updated = fresh.byId.get(obj.record.meta.id);
    if (updated === undefined) throw new WorkError('internal', '保存成绩后对象没有进入索引');
    return { ...outcome, object: this.dtoOf(updated) };
  }

  updateArenaRecord(input: ArenaRecordUpdateInput): Promise<{ record: ArenaRecord; revision: string }> {
    return this.enqueue(() => {
      const idx = this.ensureIndex();
      const obj = this.requireContestForArena(idx, input.arenaPath);
      return updateRecordFile(this.hostOf(idx, obj), input, {
        now: this.nowDate(),
        arenaDir: this.arenaDirPath(),
      });
    });
  }

  renameArenaRecord(input: ArenaRecordRenameInput): Promise<{ record: ArenaRecord; revision: string }> {
    return this.enqueue(() => {
      const idx = this.ensureIndex();
      const obj = this.requireContestForArena(idx, input.arenaPath);
      return renameRecordFile(this.hostOf(idx, obj), input, { now: this.nowDate() });
    });
  }

  trashArenaRecord(input: ArenaRecordTrashInput): Promise<ArenaRecordTrashResult> {
    return this.enqueue(() => this.trashArenaRecordNow(input));
  }

  private trashArenaRecordNow(input: ArenaRecordTrashInput): ArenaRecordTrashResult {
    if (input.confirm !== true) throw new WorkError('invalid', '删除存档需要显式确认');
    const idx = this.ensureIndex();
    const obj = this.requireContestForArena(idx, input.arenaPath);
    const trashId = `tr_${randomBytes(16).toString('hex')}`;
    const moved = trashRecordFile(this.hostOf(idx, obj), input, {
      now: this.nowDate(),
      trashRoot: join(idx.root, '.anvil', 'trash'),
      trashId,
    });
    this.index = null;
    return { entryType: 'arena-record', trashId: moved.trashId, recordId: input.recordId, trashName: moved.trashName };
  }

  restoreArenaRecord(trashId: string): Promise<ArenaRecordRestoreResult> {
    return this.enqueue(() => this.restoreArenaRecordNow(trashId));
  }

  private restoreArenaRecordNow(trashId: string): ArenaRecordRestoreResult {
    if (!arenaTrashIdOk(trashId)) throw new WorkError('invalid', 'trashId 形状不合法');
    const idx = this.ensureIndex();
    const trashAbs = idx.trashDirs.get(trashId);
    if (trashAbs === undefined) throw new WorkError('not-found', '回收站里没有这份存档');
    const manifestPath = join(trashAbs, 'trash.json');
    const manifestStat = lstatOrNull(manifestPath);
    if (manifestStat === null) throw new WorkError('not-found', '回收清单不存在');
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new WorkError('unsafe-path', 'trash.json 必须是普通文件，不允许符号链接');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new WorkError('not-found', '回收清单读不出来');
    }
    const parsed = parseRecordTrashManifest(raw);
    if (!parsed.ok) {
      if ((raw as { schema?: unknown } | null)?.schema === 1) {
        throw new WorkError('invalid', '这是对象回收条目，请用对象恢复接口');
      }
      throw new WorkError('invalid', parsed.message);
    }
    const manifest: RecordTrashManifest = parsed.manifest;
    const host = idx.byId.get(manifest.contestId);
    if (host === undefined) {
      const contestTrashed = idx.trash.some((entry) => entry.entryType === 'object' && entry.id === manifest.contestId);
      if (contestTrashed) {
        throw new WorkError('conflict', '原比赛还在回收站里；先恢复比赛再恢复这份存档');
      }
      throw new WorkError('parent-missing', '原比赛不存在；不能恢复这份存档');
    }
    if (host.record.meta.kind !== 'contest' || host.record.meta.links.arenaPath !== manifest.arenaPath) {
      throw new WorkError('conflict', '回收清单与宿主比赛不一致');
    }
    const out = restoreRecordFile(this.hostOf(idx, host), trashAbs, manifest);
    this.index = null;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 赛后题目标记（docs/contracts/30）                                   */
  /* ------------------------------------------------------------------ */

  syncProblemMarks(input: ProblemMarksSyncServiceInput): Promise<ProblemMarksDto> {
    return this.enqueue(() => {
      const idx = this.ensureIndex();
      const obj = this.requireContestForArena(idx, input.arenaPath);
      const host = this.hostOf(idx, obj);
      const outcome = syncProblemMarks(host, input, {
        now: this.nowDate(),
        readGhost: (recordId) => this.readGhostOf(host, recordId),
      });
      this.index = null;
      return outcome.dto;
    });
  }

  updateProblemMarks(input: ProblemMarksUpdateServiceInput): Promise<ProblemMarksDto> {
    return this.enqueue(() => {
      const idx = this.ensureIndex();
      const obj = this.requireContestForArena(idx, input.arenaPath);
      const dto = updateProblemMarks(this.hostOf(idx, obj), input, { now: this.nowDate() });
      this.index = null;
      return dto;
    });
  }

  /** 预填只读存档 ghost；recordId 不存在 / 不属于这场比赛一律 404（30 §4.2） */
  private readGhostOf(host: RecordHostInfo, recordId: string): WorkArenaGhost | null {
    try {
      const read = readRecordFile(host, recordId);
      if (read.kind === 'missing') throw new WorkError('not-found', '找不到这份存档');
      // 每条可读存档（含旧 review / 旧 live）都有 ghost；预填只认 ghost，不信任客户端 AC 列表
      return read.record.ghost;
    } catch (err) {
      if (err instanceof WorkError && (err.kind === 'not-found' || err.kind === 'conflict')) {
        throw new WorkError('not-found', '这份存档不属于这场比赛');
      }
      throw err;
    }
  }

  /* ------------------------------------------------------------------ */
  /* init                                                               */
  /* ------------------------------------------------------------------ */

  init(input: WorkInitInput): Promise<WorkTreeDto> {
    return this.enqueue(() => this.initNow(input));
  }

  private initNow(input: WorkInitInput): WorkTreeDto {
    const abs = validateRootPath(input.path, { repoRoot: this.deps.repoRoot, vaultDir: this.deps.vaultDir });
    const existed = lstatOrNull(abs) !== null;
    const rootJson = join(abs, '.anvil', 'root.json');
    const rootJsonStat = lstatOrNull(rootJson);
    if (rootJsonStat !== null) {
      if (rootJsonStat.isSymbolicLink() || !rootJsonStat.isFile()) {
        throw new WorkError('root-version', '.anvil/root.json 必须是普通文件，不允许符号链接');
      }
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(rootJson, 'utf8'));
      } catch {
        throw new WorkError('root-version', '.anvil/root.json 读不懂，拒绝覆盖');
      }
      const schema = (data as { schema?: unknown } | null)?.schema;
      if (schema !== 1) throw new WorkError('root-version', `不支持的 root.json schema：${String(schema)}`);
    } else if (existed) {
      let entries = 0;
      for (const name of readdirSync(abs)) {
        const st = lstatOrNull(join(abs, name));
        if (st === null) continue;
        if (isIgnoredName(name, st.isDirectory())) continue;
        entries += 1;
      }
      if (entries > 0 && input.confirmExisting !== true) {
        throw new WorkError('root-not-empty', `根目录已有 ${entries} 项；初始化只会创建 .anvil/，不会搬动已有文件`, entries);
      }
    }

    if (lstatOrNull(abs) === null) mkdirSync(abs, { recursive: true });
    const anvil = join(abs, '.anvil');
    const anvilStat = lstatOrNull(anvil);
    if (anvilStat !== null) {
      if (anvilStat.isSymbolicLink() || !anvilStat.isDirectory()) {
        throw new WorkError('root-invalid', '.anvil 必须是受管根内的普通目录');
      }
    } else {
      mkdirSync(anvil, { recursive: true });
    }
    for (const bucket of ['contests', 'practice', 'templates', 'notes']) {
      const dir = join(abs, bucket);
      const st = lstatOrNull(dir);
      if (st === null) mkdirSync(dir, { recursive: true });
      else if (st.isSymbolicLink() || !st.isDirectory()) throw new WorkError('root-invalid', `${bucket}/ 必须是普通目录`);
    }
    if (lstatOrNull(rootJson) === null) {
      writeFileAtomic(rootJson, `${JSON.stringify({ schema: 1, app: 'anvil', createdAt: this.nowDate().toISOString() }, null, 2)}\n`);
    }
    // 词表已退役（30 §3.6）：新建工作区不再生成 taxonomy.json；旧文件原样保留、不读取

    this.deps.setRoot(abs);
    return this.toTree(this.refreshIndex(), false);
  }

  /* ------------------------------------------------------------------ */
  /* 写入                                                                */
  /* ------------------------------------------------------------------ */

  create(input: WorkCreateInput): Promise<WorkObjectDetailDto> {
    return this.enqueue(() => this.createNow(input));
  }

  adopt(input: WorkAdoptInput): Promise<WorkObjectDetailDto> {
    return this.enqueue(() => this.adoptNow(input));
  }

  update(input: WorkUpdateInput): Promise<WorkObjectDetailDto> {
    return this.enqueue(() => this.updateNow(input));
  }

  trash(id: string): Promise<{ id: string; trashName: string }> {
    return this.enqueue(() => this.trashNow(id));
  }

  /** 清空回收站：只删带 `trash.json` 的应用条目，不碰受管根里其它文件 */
  purgeTrash(): Promise<WorkTrashPurgeResult> {
    return this.enqueue(() => this.purgeTrashNow());
  }

  restore(id: string): Promise<WorkObjectDetailDto> {
    return this.enqueue(() => this.restoreNow(id));
  }

  async open(id: string, relPath?: string, app?: WorkOpenApp): Promise<void> {
    const idx = this.ensureIndex();
    const obj = idx.byId.get(id);
    if (obj === undefined) throw new WorkError('not-found', '找不到这个对象');
    let target = obj.absPath;
    let isDir = true;
    if (relPath !== undefined && relPath.trim() !== '') {
      target = resolveInside(obj.absPath, relPath);
      const st = lstatOrNull(target);
      if (st === null) throw new WorkError('not-found', '对象内找不到这个路径');
      if (st.isSymbolicLink()) throw new WorkError('unsafe-path', '不允许打开符号链接');
      isDir = st.isDirectory();
    } else {
      const st = lstatOrNull(target);
      if (st === null) throw new WorkError('not-found', '对象文件夹已不存在，请重新扫描');
      if (st.isSymbolicLink()) throw new WorkError('unsafe-path', '不允许打开符号链接');
    }
    assertNoSymlinkComponents(idx.root, target);
    await openTargetWithApp({
      target,
      isDir,
      app: app ?? 'auto',
      spawn: this.deps.spawn ?? nodeSpawn,
      findCode: this.deps.findCode ?? defaultFindCode,
    });
  }

  private createNow(input: WorkCreateInput): WorkObjectDetailDto {
    const idx = this.ensureIndex();
    const root = idx.root;
    const kind = input.kind;
    if (!isWorkKind(kind)) throw new WorkError('invalid', 'kind 不合法');
    if (kind !== 'problem' && kind !== 'problemset' && input.parentId !== undefined) {
      throw new WorkError('invalid', '只有 problemset / problem 可以指定 parentId');
    }
    if (kind !== 'problem' && input.problemKey !== undefined) {
      throw new WorkError('invalid', 'problemKey 只属于 problem');
    }
    if (kind !== 'problem' && kind !== 'problemset' && input.templateId !== undefined) {
      throw new WorkError('invalid', 'templateId 只属于 problem / problemset');
    }
    if (kind !== 'contest' && input.arenaPath !== undefined) throw new WorkError('invalid', 'arenaPath 只属于 contest');

    const problemKey = input.problemKey === undefined ? '' : input.problemKey.trim();
    if (problemKey.length > 80) throw new WorkError('invalid', 'problemKey 太长');
    const arenaPath = input.arenaPath === undefined ? '' : input.arenaPath.trim();
    if (arenaPath !== '' && !contestPathOk(arenaPath)) throw new WorkError('invalid', 'arenaPath 不在榜单路径白名单内');

    let parent: IndexedObject | null = null;
    if (input.parentId !== undefined && input.parentId !== '') {
      parent = idx.byId.get(input.parentId) ?? null;
      if (parent === null) {
        throw new WorkError('parent-missing', kind === 'problemset' ? '关联的比赛不存在' : '父比赛不存在');
      }
      if (parent.record.meta.kind !== 'contest') {
        throw new WorkError('invalid', kind === 'problemset' ? '关联对象必须是 contest' : '父对象必须是 contest');
      }
      // 归档类拒绝统一用 conflict（409）：请求本身合法，是「当前状态挡路」，取消归档后重试即可
      if (kind === 'problem' && parent.effectiveArchived) throw new WorkError('conflict', '父比赛已归档，不能往里建题');
      // 0..n（27 §2.1）：一个比赛可以被任意多个题组关联；只挡「目标已归档」（27 §1.7）
      if (kind === 'problemset' && parent.effectiveArchived) {
        throw new WorkError('conflict', '关联的比赛已归档，先取消归档再关联');
      }
    }

    let title = input.title === undefined ? '' : input.title.trim();
    if (title === '') {
      if (kind !== 'problem' || problemKey === '') throw new WorkError('invalid', 'title 不能为空');
      title = this.lookupProblemName(problemKey) ?? problemKey;
    }
    if (title.length > 120) throw new WorkError('invalid', 'title 太长');

    let templateSource: IndexedObject | null = null;
    const explicitTemplate = typeof input.templateId === 'string' ? input.templateId.trim() : '';
    if (explicitTemplate !== '') {
      templateSource = idx.byId.get(explicitTemplate) ?? null;
      if (templateSource === null) throw new WorkError('not-found', '来源模板不存在');
      if (templateSource.record.meta.kind !== 'template') throw new WorkError('invalid', 'templateId 必须指向模板对象');
    } else if ((kind === 'problem' || kind === 'problemset') && input.templateId === undefined) {
      // 省略模板 = 用默认模板（非归档里 updatedAt 最新的那件）；题组与旧 problem 同一判据
      templateSource = this.defaultTemplateOf(idx);
    }

    const date = this.nowDate();
    const pathInput = {
      title,
      problemKey,
      arenaPath,
      parentRelPath: parent === null ? null : parent.relPath,
      date,
    };
    const base = buildWorkRelPath(kind, pathInput);
    if (!base.ok) throw new WorkError('invalid', base.message);

    let chosen: { relPath: string; absPath: string } | null = null;
    const trySlug = (slug: string): boolean => {
      const built = buildWorkRelPath(kind, { ...pathInput, slugOverride: slug });
      if (!built.ok) throw new WorkError('invalid', built.message);
      let abs: string;
      try {
        abs = resolveInside(root, built.value.relPath, { allowMissing: true });
      } catch (err) {
        if (err instanceof WorkError && err.kind === 'unsafe-path') return false;
        throw err;
      }
      if (lstatOrNull(abs) !== null) return false;
      chosen = { relPath: built.value.relPath, absPath: abs };
      return true;
    };

    for (let attempt = 1; attempt <= 50 && chosen === null; attempt += 1) {
      trySlug(attempt === 1 ? base.value.slug : slugForAttempt(base.value.slug, attempt));
    }
    for (let i = 0; i < 10 && chosen === null; i += 1) {
      trySlug(slugWithRandomSuffix(base.value.slug, randomBytes(2).toString('hex')));
    }
    if (chosen === null) throw new WorkError('conflict', '分配对象目录失败：同名目录太多');
    const target: { relPath: string; absPath: string } = chosen;

    mkdirSync(target.absPath, { recursive: true });
    try {
      if (kind === 'note') {
        writeFileAtomic(join(target.absPath, 'note.md'), `# ${title}\n`);
      }
      if (templateSource !== null) this.copyTemplate(templateSource.absPath, target.absPath);
      const now = this.nowDate().toISOString();
      const id = `obj_${randomBytes(5).toString('hex')}`;
      const links: WorkMeta['links'] = {};
      if (kind === 'problem' && problemKey !== '') links.problemKey = problemKey;
      if (kind === 'contest' && arenaPath !== '') links.arenaPath = arenaPath;
      const meta: WorkMeta = {
        schema: 1,
        id,
        kind,
        title,
        createdAt: now,
        updatedAt: now,
        parentId: parent === null ? null : parent.record.meta.id,
        labels: [],
        links,
        archived: false,
      };
      const record: WorkMetaRecord = { meta, raw: { ...meta } as unknown as Record<string, unknown> };
      writeFileAtomic(join(target.absPath, '.anvil.json'), `${JSON.stringify(workMetaToJson(record), null, 2)}\n`);
      const fresh = this.refreshIndex();
      const created = fresh.byId.get(id);
      if (created === undefined) throw new WorkError('internal', '对象写入后没有进入索引');
      return this.detailOf(created);
    } catch (err) {
      // 契约：meta 写失败只删本次新建且仍为空的目录
      try {
        rmdirSync(target.absPath);
      } catch {
        /* 已有内容就留着 */
      }
      if (err instanceof WorkError) throw err;
      throw new WorkError('internal', `创建对象失败：${asError(err).message}`);
    }
  }

  /** 默认模板：非归档模板里 updatedAt 最新的一件；旧 problem 与题组共用 */
  private defaultTemplateOf(idx: WorkIndex): IndexedObject | null {
    const picked = defaultTemplateOf(
      idx.objects.map((obj) => ({
        kind: obj.record.meta.kind,
        effectiveArchived: obj.effectiveArchived,
        updatedAt: obj.record.meta.updatedAt,
        relPath: obj.relPath,
        obj,
      })),
    );
    return picked?.obj ?? null;
  }

  private lookupProblemName(problemKey: string): string | null {
    try {
      const row = this.deps.db
        .prepare("SELECT problem_name AS name FROM submissions WHERE problem_key = ? AND problem_name IS NOT NULL AND problem_name <> '' LIMIT 1")
        .get(problemKey) as { name?: unknown } | undefined;
      const name = row?.name;
      return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * 模板主文件解析：显式 `template.cpp` → 首个 `.cpp` → 缺省的 `template.cpp`（保存时新建）。
   * 与 copyTemplate 保持同一优先级，编辑的和复制到 solution.cpp 的始终是同一份。
   */
  private templateFileOf(obj: IndexedObject): { path: string; absPath: string } {
    const explicit = join(obj.absPath, 'template.cpp');
    const explicitStat = lstatOrNull(explicit);
    if (explicitStat !== null) {
      if (explicitStat.isSymbolicLink() || !explicitStat.isFile()) {
        throw new WorkError('unsafe-path', 'template.cpp 必须是普通文件，不允许符号链接');
      }
      return { path: 'template.cpp', absPath: explicit };
    }
    const names = readdirSync(obj.absPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.isSymbolicLink() && !isIgnoredName(e.name, false))
      .map((e) => e.name)
      .sort(comparePosix);
    const firstCpp = names.find((name) => name.toLowerCase().endsWith('.cpp'));
    if (firstCpp !== undefined) return { path: firstCpp, absPath: join(obj.absPath, firstCpp) };
    return { path: 'template.cpp', absPath: explicit };
  }

  private templateStateOf(root: string, obj: IndexedObject): TemplateFileState {
    const dirStat = lstatOrNull(obj.absPath);
    if (dirStat === null) throw new WorkError('not-found', '模板文件夹已不存在，请重新扫描');
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new WorkError('unsafe-path', '模板文件夹必须是普通目录');
    }
    const file = this.templateFileOf(obj);
    assertNoSymlinkComponents(root, file.absPath);
    const st = lstatOrNull(file.absPath);
    if (st === null) return { ...file, exists: false, content: '', revision: null };
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new WorkError('unsafe-path', '模板文件必须是普通文件，不允许符号链接');
    }
    if (st.size > WORK_TEMPLATE_CONTENT_MAX) {
      throw new WorkError('invalid', `模板文件超过 ${WORK_TEMPLATE_CONTENT_MAX / 1024}KB，不在工作台内编辑`);
    }
    let content: string;
    try {
      content = readFileSync(file.absPath, 'utf8');
    } catch (err) {
      throw new WorkError('internal', `模板文件读不出来：${asError(err).message}`);
    }
    return { ...file, exists: true, content, revision: hashText(content) };
  }

  private saveTemplateNow(input: WorkTemplateSaveInput): WorkTemplateFileDto {
    const idx = this.ensureIndex();
    const obj = idx.byId.get(input.id);
    if (obj === undefined) throw new WorkError('not-found', '找不到这个对象');
    if (obj.record.meta.kind !== 'template') throw new WorkError('invalid', '只有模板对象有可编辑的模板文件');
    if (typeof input.content !== 'string') throw new WorkError('invalid', '模板内容必须是字符串');
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > WORK_TEMPLATE_CONTENT_MAX) {
      throw new WorkError('invalid', `模板内容超过 ${WORK_TEMPLATE_CONTENT_MAX / 1024}KB`);
    }
    if (input.content.includes('\0')) throw new WorkError('invalid', '模板内容含 NUL，不能按文本保存');

    const current = this.templateStateOf(idx.root, obj);
    if (current.revision !== input.baseRevision) {
      throw new WorkError('conflict', '模板文件在别处改过了，重新载入后再保存');
    }
    if (current.exists && current.content === input.content) {
      return { path: current.path, exists: true, content: current.content, revision: current.revision };
    }
    try {
      writeFileAtomic(current.absPath, input.content);
    } catch (err) {
      throw new WorkError('internal', `模板文件写入失败：${asError(err).message}`);
    }
    const fresh = this.refreshIndex();
    const updated = fresh.byId.get(input.id);
    if (updated === undefined) throw new WorkError('internal', '模板文件写入后对象没有进入索引');
    const state = this.templateStateOf(fresh.root, updated);
    return { path: state.path, exists: state.exists, content: state.content, revision: state.revision };
  }

  private copyTemplate(sourceAbs: string, targetAbs: string): void {
    const entries = readdirSync(sourceAbs, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.isSymbolicLink() && !isIgnoredName(e.name, false))
      .map((e) => e.name)
      .sort(comparePosix);
    const explicit = entries.find((name) => name === 'template.cpp');
    const firstCpp = entries.find((name) => name.toLowerCase().endsWith('.cpp'));
    const solution = explicit ?? firstCpp ?? null;
    if (solution !== null) {
      copyFileSync(join(sourceAbs, solution), join(targetAbs, 'solution.cpp'));
    }
  }

  private adoptNow(input: WorkAdoptInput): WorkObjectDetailDto {
    const idx = this.ensureIndex();
    const root = idx.root;
    if (!isWorkKind(input.kind)) throw new WorkError('invalid', 'kind 不合法');
    // 关联比赛是显式选择（26 §4.2），不根据目标目录位置推断
    if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '' && input.kind !== 'problemset') {
      throw new WorkError('invalid', '只有 problemset 可以指定关联比赛');
    }
    let linkParentId: string | null = null;
    if (input.kind === 'problemset' && input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
      const linked = idx.byId.get(input.parentId) ?? null;
      if (linked === null) throw new WorkError('parent-missing', '关联的比赛不存在');
      if (linked.record.meta.kind !== 'contest') throw new WorkError('invalid', '关联对象必须是 contest');
      // 0..n（27 §2.1）：不再检查占用；目标已归档则拒绝（27 §1.7）
      if (linked.effectiveArchived) throw new WorkError('conflict', '关联的比赛已归档，先取消归档再关联');
      linkParentId = linked.record.meta.id;
    }
    const abs = resolveInside(root, input.relPath);
    const st = lstatOrNull(abs);
    if (st === null) throw new WorkError('not-found', '要登记的目标不存在');
    if (st.isSymbolicLink()) throw new WorkError('unsafe-path', '不允许登记符号链接');
    if (!st.isDirectory()) throw new WorkError('invalid', '只能登记文件夹');
    const rel = relPosix(root, abs);
    if (rel === '' || TOP_BUCKETS.has(rel)) throw new WorkError('invalid', '不能登记受管根或顶层桶本身');
    if (rel.split('/').some((part) => isIgnoredName(part, true))) throw new WorkError('invalid', '不能登记忽略目录');
    if (lstatOrNull(join(abs, '.anvil.json')) !== null) throw new WorkError('conflict', '这个文件夹已经有 .anvil.json');
    if (idx.byRel.has(rel)) throw new WorkError('conflict', '这个文件夹已经是对象');

    let parent: IndexedObject | null = null;
    let cur = dirname(abs);
    while (within(root, cur, false)) {
      const found = idx.byRel.get(relPosix(root, cur));
      if (found !== undefined) {
        parent = found;
        break;
      }
      const next = dirname(cur);
      if (next === cur) break;
      cur = next;
    }
    if (parent !== null) {
      if (!(input.kind === 'problem' && parent.record.meta.kind === 'contest')) {
        throw new WorkError('invalid', '最近的祖先已是对象：只有 problem 能挂进 contest，其它组合请先改 kind 或换位置');
      }
    }

    let title = input.title === undefined ? basename(abs) : input.title.trim();
    if (title === '') title = basename(abs);
    if (title.length > 120) throw new WorkError('invalid', 'title 太长');
    const now = this.nowDate().toISOString();
    const id = `obj_${randomBytes(5).toString('hex')}`;
    const meta: WorkMeta = {
      schema: 1,
      id,
      kind: input.kind,
      title,
      createdAt: now,
      updatedAt: now,
      parentId: input.kind === 'problemset' ? linkParentId : parent === null ? null : parent.record.meta.id,
      labels: [],
      links: {},
      archived: false,
    };
    const record: WorkMetaRecord = { meta, raw: { ...meta } as unknown as Record<string, unknown> };
    writeFileAtomic(join(abs, '.anvil.json'), `${JSON.stringify(workMetaToJson(record), null, 2)}\n`);
    const fresh = this.refreshIndex();
    const created = fresh.byId.get(id);
    if (created === undefined) throw new WorkError('internal', '登记后对象没有进入索引');
    return this.detailOf(created);
  }

  private updateNow(input: WorkUpdateInput): WorkObjectDetailDto {
    const idx = this.ensureIndex();
    const obj = idx.byId.get(input.id);
    if (obj === undefined) throw new WorkError('not-found', '找不到这个对象');
    const current = obj.record.meta;
    // 归档冻结（27 §4）：已归档对象只允许取消归档，其余字段一律拒绝。
    // 判据用 effectiveArchived，与 trash / create 同一词：旧 problem 随父比赛定格时也读。
    if (obj.effectiveArchived) {
      const frozenFields = [input.title, input.labels, input.parentId].some((field) => field !== undefined);
      if (frozenFields) throw new WorkError('conflict', '已归档的对象是只读的；先取消归档再修改');
    }
    const next: WorkMeta = {
      ...current,
      labels: [...current.labels],
      links: { ...current.links },
    };
    let changed = false;

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title.length < 1 || title.length > 120) throw new WorkError('invalid', 'title 长度必须在 1–120 之间');
      if (title !== next.title) {
        next.title = title;
        changed = true;
      }
    }

    if (input.labels !== undefined) {
      const labels = cleanLabels(input.labels);
      if (!labels.ok) throw new WorkError('invalid', labels.message);
      if (JSON.stringify(labels.labels) !== JSON.stringify(next.labels)) {
        next.labels = labels.labels;
        changed = true;
      }
    }

    if (input.archived !== undefined) {
      if (typeof input.archived !== 'boolean') throw new WorkError('invalid', 'archived 必须是布尔值');
      if (next.archived !== input.archived) {
        next.archived = input.archived;
        changed = true;
      }
    }

    if (input.parentId !== undefined) {
      // 只有题组能改关联（26 §4.2）；旧 problem 的物理父子不改，比赛 / 模板 / 笔记没有关联
      if (current.kind !== 'problemset') throw new WorkError('invalid', '只有题组可以修改关联比赛');
      // 跨归档不可编辑（27 §1.7）：当前关联的比赛已归档时，改挂 / 清除都不允许，先取消它的归档。
      // 关联比赛缺失（被回收 / 删除）不算归档，仍可改挂或清除来修复悬空
      if (current.parentId !== null) {
        const currentParent = idx.byId.get(current.parentId) ?? null;
        if (currentParent !== null && currentParent.record.meta.kind === 'contest' && currentParent.effectiveArchived) {
          throw new WorkError('conflict', '关联的比赛已归档，先取消归档再调整关联');
        }
      }
      let nextParentId: string | null = null;
      if (input.parentId !== null && input.parentId !== '') {
        if (!workIdOk(input.parentId)) throw new WorkError('invalid', 'parentId 形状不合法');
        if (input.parentId === current.id) throw new WorkError('invalid', '题组不能关联自己');
        const linked = idx.byId.get(input.parentId) ?? null;
        if (linked === null) throw new WorkError('parent-missing', '关联的比赛不存在');
        if (linked.record.meta.kind !== 'contest') throw new WorkError('invalid', '关联对象必须是 contest');
        // 0..n（27 §2.1）：不再检查占用；跨归档不可编辑——目标已归档时不能新建这条关联
        if (linked.effectiveArchived) throw new WorkError('conflict', '关联的比赛已归档，先取消归档再关联');
        nextParentId = linked.record.meta.id;
      }
      if (next.parentId !== nextParentId) {
        next.parentId = nextParentId;
        changed = true;
      }
    }

    if (!changed) return this.detailOf(obj);
    next.updatedAt = this.nowDate().toISOString();
    const record: WorkMetaRecord = { meta: next, raw: obj.record.raw };
    writeFileAtomic(join(obj.absPath, '.anvil.json'), `${JSON.stringify(workMetaToJson(record), null, 2)}\n`);
    const fresh = this.refreshIndex();
    const updated = fresh.byId.get(next.id);
    if (updated === undefined) throw new WorkError('internal', '更新后对象没有进入索引');
    return this.detailOf(updated);
  }

  private trashNow(id: string): { id: string; trashName: string } {
    const idx = this.ensureIndex();
    const obj = idx.byId.get(id);
    if (obj === undefined) throw new WorkError('not-found', '找不到这个对象');
    // 归档对象不能直接进回收站（27 §3.3）：先取消归档回到活动，再按回收站规则操作
    if (obj.effectiveArchived) throw new WorkError('conflict', '已归档的对象不能移入回收站；先取消归档');
    const trashRoot = join(idx.root, '.anvil', 'trash');
    mkdirSync(trashRoot, { recursive: true });
    const stamp = localStamp(this.nowDate());
    let trashName = `${stamp}_${id}`;
    for (let i = 2; lstatOrNull(join(trashRoot, trashName)) !== null; i += 1) trashName = `${stamp}_${id}-${i}`;
    const trashAbs = join(trashRoot, trashName);
    renameSync(obj.absPath, trashAbs);
    try {
      const manifest = {
        schema: 1,
        id,
        title: obj.record.meta.title,
        originalRelPath: obj.relPath,
        trashedAt: this.nowDate().toISOString(),
      };
      writeFileAtomic(join(trashAbs, 'trash.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (err) {
      try {
        renameSync(trashAbs, obj.absPath);
      } catch {
        /* 回滚失败只能把原异常抛出去 */
      }
      throw new WorkError('internal', `移入回收站失败：${asError(err).message}`);
    }
    this.index = null;
    return { id, trashName };
  }

  private purgeTrashNow(): WorkTrashPurgeResult {
    const idx = this.ensureIndex();
    const trashRoot = join(idx.root, '.anvil', 'trash');
    const rootStat = lstatOrNull(trashRoot);
    if (rootStat === null) return { removed: 0 };
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new WorkError('unsafe-path', '回收站必须是受管根内的普通目录');
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(trashRoot, { withFileTypes: true });
    } catch (err) {
      throw new WorkError('internal', `回收站读不出来：${asError(err).message}`);
    }
    let removed = 0;
    try {
      for (const entry of entries) {
        const abs = join(trashRoot, entry.name);
        const stat = lstatOrNull(abs);
        if (stat === null) continue;
        // 只认应用自己生成的两类回收条目（普通目录 + 合法 trash.json）；杂项与符号链接一律不碰
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        const manifest = lstatOrNull(join(abs, 'trash.json'));
        if (manifest === null || manifest.isSymbolicLink() || !manifest.isFile()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(join(abs, 'trash.json'), 'utf8'));
        } catch {
          continue;
        }
        const recordEntry = parseRecordTrashManifest(raw);
        const objectEntry = raw as { schema?: unknown; id?: unknown; title?: unknown; originalRelPath?: unknown; trashedAt?: unknown };
        const validObject =
          objectEntry.schema === 1 &&
          workIdOk(objectEntry.id) &&
          typeof objectEntry.title === 'string' &&
          typeof objectEntry.originalRelPath === 'string' &&
          objectEntry.originalRelPath !== '' &&
          typeof objectEntry.trashedAt === 'string' &&
          !Number.isNaN(Date.parse(objectEntry.trashedAt));
        if (!recordEntry.ok && !validObject) continue;
        rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed += 1;
      }
    } catch (err) {
      throw new WorkError('internal', `清空回收站失败（已删除 ${removed} 项）：${asError(err).message}`);
    } finally {
      this.index = null;
    }
    return { removed };
  }

  /** 回收站里那件对象的 meta：`trash.json` 不带 arenaPath，只能读被删对象的 `.anvil.json` */
  private trashedMeta(trashAbs: string): WorkMeta | null {
    const file = join(trashAbs, '.anvil.json');
    const stat = lstatOrNull(file);
    if (stat === null || stat.isSymbolicLink() || !stat.isFile()) return null;
    try {
      const parsed = parseWorkMeta(JSON.parse(readFileSync(file, 'utf8')));
      return parsed.ok ? parsed.record.meta : null;
    } catch {
      return null;
    }
  }

  /** 回收站里指向同一场的 contest（按 arenaPath 认，不看标题） */
  private trashedContestForArena(idx: WorkIndex, arenaPath: string): WorkTrashDto | null {
    for (const item of idx.trash) {
      const dir = idx.trashDirs.get(item.id);
      if (dir === undefined) continue;
      const meta = this.trashedMeta(dir);
      if (meta !== null && meta.kind === 'contest' && meta.links.arenaPath === arenaPath) return item;
    }
    return null;
  }

  private restoreNow(id: string): WorkObjectDetailDto {
    const idx = this.ensureIndex();
    const trashAbs = idx.trashDirs.get(id);
    if (trashAbs === undefined) throw new WorkError('not-found', '回收站里没有这个对象');
    const manifestPath = join(trashAbs, 'trash.json');
    const manifestStat = lstatOrNull(manifestPath);
    if (manifestStat === null) throw new WorkError('not-found', '回收站清单不存在');
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new WorkError('unsafe-path', 'trash.json 必须是普通文件，不允许符号链接');
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new WorkError('not-found', '回收站清单读不出来');
    }
    const m = manifest as { schema?: unknown; entryType?: unknown; id?: unknown; originalRelPath?: unknown };
    if (m.schema === 2 || m.entryType === 'arena-record') {
      throw new WorkError('invalid', '这是成绩存档的回收条目，请用成绩恢复接口');
    }
    if (m.schema !== 1 || m.id !== id || typeof m.originalRelPath !== 'string' || m.originalRelPath === '') {
      throw new WorkError('not-found', '回收站清单不完整');
    }
    // 恢复后出现两份同场对象 = 这场的读与写当场全废（contestByArenaPath 报冲突），所以在门口就挡
    const trashedMeta = this.trashedMeta(trashAbs);
    if (trashedMeta !== null && trashedMeta.kind === 'contest' && trashedMeta.links.arenaPath !== undefined) {
      const dup = idx.objects.find(
        (o) => o.record.meta.kind === 'contest' && o.record.meta.links.arenaPath === trashedMeta.links.arenaPath,
      );
      if (dup !== undefined) {
        throw new WorkError('conflict', `工坊里已经有同一场的另一份对象（${dup.record.meta.title}）；先处理它再恢复`);
      }
    }
    const targetAbs = resolveInside(idx.root, m.originalRelPath, { allowMissing: true });
    if (lstatOrNull(targetAbs) !== null) throw new WorkError('path-occupied', '原路径已被占用，不能自动改名恢复');
    const parent = dirname(targetAbs);
    const parentStat = lstatOrNull(parent);
    if (parentStat === null || !parentStat.isDirectory()) throw new WorkError('parent-missing', '原路径的父目录不存在');
    if (parentStat.isSymbolicLink()) throw new WorkError('unsafe-path', '父目录是符号链接');
    assertNoSymlinkComponents(idx.root, parent);
    renameSync(trashAbs, targetAbs);
    try {
      unlinkSync(join(targetAbs, 'trash.json'));
    } catch {
      /* 清单已随目录移回；删不掉不影响对象本身 */
    }
    const fresh = this.refreshIndex();
    const restored = fresh.byId.get(id);
    if (restored === undefined) throw new WorkError('internal', '恢复后对象没有进入索引');
    return this.detailOf(restored);
  }

  private rescanNow(compare: boolean): WorkRescanSummary {
    const root = this.readRootState();
    const previous = this.index !== null && this.index.root === root ? new Set(this.index.byId.keys()) : null;
    const next = this.buildIndex(root);
    this.index = next;
    const nextIds = new Set(next.byId.keys());
    return {
      scannedAt: next.scannedAt,
      objects: next.byId.size,
      added: previous === null ? next.byId.size : [...nextIds].filter((id) => !previous.has(id)).length,
      removed: compare && previous !== null ? [...previous].filter((id) => !nextIds.has(id)).length : 0,
      unregistered: next.unregistered.length,
      errors: next.errors.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 扫描                                                               */
  /* ------------------------------------------------------------------ */

  private buildIndex(root: string): WorkIndex {
    const errors: WorkScanErrorDto[] = [];
    const unregistered: WorkUnregisteredDto[] = [];
    const collected: CollectedObject[] = [];

    const walk = (absDir: string, relDir: string): void => {
      const metaPath = join(absDir, '.anvil.json');
      const metaStat = lstatOrNull(metaPath);
      const hasMeta = metaStat !== null;
      if (relDir !== '' && hasMeta) {
        if (!metaStat.isFile()) {
          errors.push({ relPath: relDir, kind: 'meta-invalid', message: '.anvil.json 不是普通文件' });
        } else {
          let raw: unknown;
          try {
            raw = JSON.parse(readFileSync(metaPath, 'utf8'));
          } catch (err) {
            errors.push({ relPath: relDir, kind: 'meta-invalid', message: `.anvil.json 解析失败：${asError(err).message}` });
            raw = undefined;
          }
          if (raw !== undefined) {
            const parsed = parseWorkMeta(raw);
            if (!parsed.ok) {
              errors.push({ relPath: relDir, kind: 'meta-invalid', message: parsed.message });
            } else {
              const files = this.collectFiles(absDir, relDir, errors);
              collected.push({
                record: parsed.record,
                relPath: relDir,
                absPath: absDir,
                files: files.files,
                fileCount: files.total,
                sourceCount: files.sourceTotal,
                filesTruncated: files.truncated,
              });
            }
          }
        }
      } else if (relDir !== '' && unregisteredKindHint(relDir) !== null) {
        unregistered.push({ relPath: relDir, kindHint: unregisteredKindHint(relDir) });
      }

      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        errors.push({ relPath: relDir, kind: 'scan', message: `目录读不出来：${asError(err).message}` });
        return;
      }
      entries.sort((a, b) => comparePosix(a.name, b.name));
      for (const entry of entries) {
        if (isIgnoredName(entry.name, entry.isDirectory())) continue;
        const childRel = joinRel(relDir, entry.name);
        if (entry.isSymbolicLink()) {
          errors.push({ relPath: childRel, kind: 'symlink', message: '符号链接不跟随' });
          continue;
        }
        if (entry.isDirectory()) walk(join(absDir, entry.name), childRel);
      }
    };

    walk(root, '');

    const groups = new Map<string, CollectedObject[]>();
    for (const obj of collected) {
      const group = groups.get(obj.record.meta.id);
      if (group === undefined) groups.set(obj.record.meta.id, [obj]);
      else group.push(obj);
    }
    const survivors: CollectedObject[] = [];
    for (const [id, group] of groups) {
      if (group.length === 1) {
        survivors.push(group[0]!);
      } else {
        for (const dup of group) {
          errors.push({ relPath: dup.relPath, kind: 'meta-invalid', message: `id 重复：${id}` });
        }
      }
    }

    const byId = new Map<string, IndexedObject>();
    const byRel = new Map<string, IndexedObject>();
    const objects: IndexedObject[] = [];
    const problemMarkFiles: ProblemMarksFile[] = [];
    for (const item of survivors) {
      const indexed: IndexedObject = {
        record: item.record,
        relPath: item.relPath,
        absPath: item.absPath,
        root,
        files: item.files,
        fileCount: item.fileCount,
        sourceCount: item.sourceCount,
        filesTruncated: item.filesTruncated,
        effectiveArchived: item.record.meta.archived,
      };
      // 列表徽章在扫描时派生（30 §4.1）：坏文件 / schema 过高只让这一场没有徽章，不阻塞其它对象
      const arenaPath = item.record.meta.links.arenaPath;
      if (item.record.meta.kind === 'contest' && arenaPath !== undefined) {
        const host: RecordHostInfo = {
          root,
          contestId: item.record.meta.id,
          contestRelPath: item.relPath,
          contestAbs: item.absPath,
          arenaPath,
          effectiveArchived: indexed.effectiveArchived,
        };
        try {
          const read = readProblemMarks(host);
          if (read.kind === 'ok') {
            indexed.problemMarkSummary = problemMarkSummaryOf(read.file);
            problemMarkFiles.push(read.file);
          }
        } catch {
          /* 标记文件坏 / 路径不安全：这一场没有徽章，不影响扫描其它对象 */
        }
      }
      byId.set(item.record.meta.id, indexed);
      byRel.set(item.relPath, indexed);
      objects.push(indexed);
    }

    const dropped = new Set<string>();
    for (const obj of objects) {
      const parentId = obj.record.meta.parentId;
      if (parentId === null) continue;
      const parent = byId.get(parentId);
      if (parent === undefined) {
        // 题组的关联比赛缺失（被回收 / 外部删除）只警告：对象保留，可继续使用（26 §2.3）
        const message =
          obj.record.meta.kind === 'problemset'
            ? `关联的比赛不存在（对象保留）：${parentId}`
            : `parentId 指向不存在的对象：${parentId}`;
        errors.push({ relPath: obj.relPath, kind: 'parent-missing', message });
      } else if (parent.record.meta.kind !== 'contest') {
        errors.push({ relPath: obj.relPath, kind: 'meta-invalid', message: 'parentId 指向的对象不是 contest' });
        dropped.add(obj.relPath);
      }
    }

    // 0..n（27 §2.1）：多个题组关联同一个比赛不再算冲突；父缺失 / 父不是 contest 的检查保持上面不变

    for (let pass = 0; pass < 2; pass += 1) {
      for (const obj of objects) {
        const parentId = obj.record.meta.parentId;
        if (parentId === null) continue;
        // 生命周期独立（26 §5.1）：只有旧 problem 继承父对象归档；题组只看自己
        if (obj.record.meta.kind !== 'problem') continue;
        const parent = byId.get(parentId);
        if (parent !== undefined && parent.effectiveArchived) obj.effectiveArchived = true;
      }
    }

    const finalObjects = objects.filter((obj) => !dropped.has(obj.relPath)).sort((a, b) => comparePosix(a.relPath, b.relPath));
    const finalById = new Map([...byId].filter(([, obj]) => !dropped.has(obj.relPath)));
    const finalByRel = new Map([...byRel].filter(([, obj]) => !dropped.has(obj.relPath)));

    const trash: WorkTrashDto[] = [];
    const trashDirs = new Map<string, string>();
    const trashRoot = join(root, '.anvil', 'trash');
    const trashStat = lstatOrNull(trashRoot);
    if (trashStat !== null && (trashStat.isSymbolicLink() || !trashStat.isDirectory())) {
      errors.push({ relPath: '.anvil/trash', kind: 'meta-invalid', message: '回收站必须是普通目录，不允许符号链接' });
    }
    if (trashStat !== null && trashStat.isDirectory()) {
      let entries: Dirent[];
      try {
        entries = readdirSync(trashRoot, { withFileTypes: true });
      } catch (err) {
        errors.push({ relPath: '.anvil/trash', kind: 'scan', message: `回收站读不出来：${asError(err).message}` });
        entries = [];
      }
      entries.sort((a, b) => comparePosix(b.name, a.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const dirAbs = join(trashRoot, entry.name);
        const manifestPath = join(dirAbs, 'trash.json');
        const manifestStat = lstatOrNull(manifestPath);
        if (manifestStat === null || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
          errors.push({ relPath: toPosix(`.anvil/trash/${entry.name}`), kind: 'meta-invalid', message: 'trash.json 必须是普通文件' });
          continue;
        }
        let manifest: unknown;
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
          errors.push({ relPath: toPosix(`.anvil/trash/${entry.name}`), kind: 'meta-invalid', message: 'trash.json 读不出来' });
          continue;
        }
        const recordEntry = parseRecordTrashManifest(manifest);
        if (recordEntry.ok) {
          const rec = recordEntry.manifest;
          if (!trashDirs.has(rec.id)) trashDirs.set(rec.id, dirAbs);
          trash.push({
            entryType: 'arena-record',
            id: rec.id,
            recordId: rec.recordId,
            contestId: rec.contestId,
            arenaPath: rec.arenaPath,
            title: rec.title,
            fileName: rec.fileName,
            trashedAt: rec.trashedAt,
          });
          continue;
        }
        const m = manifest as { schema?: unknown; id?: unknown; title?: unknown; originalRelPath?: unknown; trashedAt?: unknown };
        if (
          m.schema !== 1 ||
          !workIdOk(m.id) ||
          typeof m.title !== 'string' ||
          typeof m.originalRelPath !== 'string' ||
          m.originalRelPath === '' ||
          typeof m.trashedAt !== 'string' ||
          Number.isNaN(Date.parse(m.trashedAt))
        ) {
          const hint = (manifest as { schema?: unknown } | null)?.schema === 2 ? recordEntry.message : 'trash.json 字段不完整';
          errors.push({ relPath: toPosix(`.anvil/trash/${entry.name}`), kind: 'meta-invalid', message: hint });
          continue;
        }
        if (!trashDirs.has(m.id)) trashDirs.set(m.id, dirAbs);
        const objectEntry: WorkTrashObjectDto = {
          entryType: 'object',
          id: m.id,
          title: m.title,
          originalRelPath: m.originalRelPath,
          trashedAt: m.trashedAt,
        };
        trash.push(objectEntry);
      }
    }
    trash.sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : a.trashedAt > b.trashedAt ? -1 : 0));

    return {
      root,
      scannedAt: Math.floor(this.nowDate().getTime() / 1000),
      objects: finalObjects,
      byId: finalById,
      byRel: finalByRel,
      trash,
      trashDirs,
      unregistered: unregistered.sort((a, b) => comparePosix(a.relPath, b.relPath)),
      errors: errors.sort((a, b) => comparePosix(a.relPath, b.relPath)),
      problemMarkFiles,
    };
  }

  private collectFiles(
    objAbs: string,
    objRel: string,
    errors: WorkScanErrorDto[],
  ): { files: WorkFileDto[]; total: number; sourceTotal: number; truncated: boolean } {
    const files: WorkFileDto[] = [];
    let total = 0;
    let sourceTotal = 0;
    const walk = (absDir: string, relDir: string): void => {
      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        errors.push({ relPath: joinRel(objRel, relDir), kind: 'scan', message: `文件列表读取失败：${asError(err).message}` });
        return;
      }
      entries.sort((a, b) => comparePosix(a.name, b.name));
      for (const entry of entries) {
        if (isIgnoredName(entry.name, entry.isDirectory())) continue;
        if (entry.isSymbolicLink()) continue;
        const childRel = joinRel(relDir, entry.name);
        if (entry.isDirectory()) {
          if (lstatOrNull(join(absDir, entry.name, '.anvil.json')) !== null) continue; // 子对象单独列出
          walk(join(absDir, entry.name), childRel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === '.anvil.json') continue;
        total += 1;
        if (isImportSourceName(entry.name)) sourceTotal += 1;
        if (files.length >= 500) continue;
        const st = lstatOrNull(join(absDir, entry.name));
        if (st === null) continue;
        files.push({
          path: childRel,
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000),
          ext: extname(entry.name).toLowerCase(),
        });
      }
    };
    walk(objAbs, '');
    files.sort((a, b) => comparePosix(a.path, b.path));
    return { files, total, sourceTotal, truncated: total > files.length };
  }

  /* ------------------------------------------------------------------ */
  /* DTO                                                                */
  /* ------------------------------------------------------------------ */

  private toTree(idx: WorkIndex, archived: boolean): WorkTreeDto {
    return {
      root: idx.root,
      scannedAt: idx.scannedAt,
      objects: idx.objects.filter((obj) => obj.effectiveArchived === archived).map((obj) => this.dtoOf(obj)),
      unregistered: idx.unregistered,
      errors: idx.errors,
      problemTags: collectProblemTags(idx.problemMarkFiles),
      trash: idx.trash,
    };
  }

  private dtoOf(obj: IndexedObject): WorkObjectDto {
    const meta = obj.record.meta;
    return {
      id: meta.id,
      kind: meta.kind,
      title: meta.title,
      relPath: obj.relPath,
      parentId: meta.parentId,
      labels: [...meta.labels],
      links: { ...meta.links },
      archived: meta.archived,
      effectiveArchived: obj.effectiveArchived,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      fileCount: obj.fileCount,
      sourceCount: obj.sourceCount,
      ...(meta.sourcePath === undefined ? {} : { sourcePath: meta.sourcePath }),
      ...(obj.problemMarkSummary === undefined ? {} : { problemMarkSummary: obj.problemMarkSummary }),
    };
  }

  private detailOf(obj: IndexedObject): WorkObjectDetailDto {
    const base: WorkObjectDetailDto = { ...this.dtoOf(obj), files: [...obj.files], filesTruncated: obj.filesTruncated };
    if (obj.record.meta.kind !== 'contest') return base;
    if (obj.record.meta.links.arenaPath === undefined) return { ...base, problemMarks: null };
    const detail = problemMarksDetailOf({
      root: obj.root,
      contestId: obj.record.meta.id,
      contestRelPath: obj.relPath,
      contestAbs: obj.absPath,
      arenaPath: obj.record.meta.links.arenaPath,
      effectiveArchived: obj.effectiveArchived,
    });
    return {
      ...base,
      problemMarks: detail.dto,
      ...(detail.error === undefined ? {} : { problemMarksError: detail.error }),
    };
  }
}
