/**
 * 工坊服务（docs/contracts/23）：`.anvil.json` 是权威，内存索引只是缓存。
 * 所有写操作走单 Promise 队列；所有元数据写入走 writeFileAtomic；不新增 SQLite 表。
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, type Dirent } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  buildWorkRelPath,
  cleanLabels,
  contestPathOk,
  defaultTemplateOf,
  flattenTaxonomy,
  isImportSourceName,
  isWorkKind,
  parseTaxonomy,
  parseWorkArenaRecord,
  parseWorkMeta,
  seedTaxonomy,
  slugForAttempt,
  slugWithRandomSuffix,
  unregisteredKindHint,
  workIdOk,
  workMetaToJson,
  WORK_TEMPLATE_CONTENT_MAX,
  type WorkArenaGhost,
  type WorkArenaRecordDto,
  type WorkArenaSaveResult,
  type WorkArenaView,
  type WorkFileDto,
  type WorkImportCommitInput,
  type WorkImportPlanDto,
  type WorkImportResultDto,
  type WorkImportScanInput,
  type WorkKind,
  type WorkOpenApp,
  type WorkMeta,
  type WorkMetaRecord,
  type WorkObjectDetailDto,
  type WorkObjectDto,
  type WorkScanErrorDto,
  type WorkTaxonomyDto,
  type WorkTaxonomyFile,
  type WorkTemplateFileDto,
  type WorkTemplateSaveInput,
  type WorkTreeDto,
  type WorkTrashDto,
  type WorkUnregisteredDto,
} from '@anvil/shared';
import { writeFileAtomic } from '../atomic.ts';
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

export interface WorkServiceDeps {
  db: DatabaseSync;
  getRoot: () => string;
  setRoot: (root: string) => void;
  spawn?: SpawnFn;
  findCode?: () => string | null;
  now?: () => Date;
  repoRoot?: string;
  vaultDir?: string;
  /** 仅测试注入导入上限；生产固定用契约 §4.4 */
  importLimits?: Partial<Record<'maxDepth' | 'maxFiles' | 'maxBytes' | 'maxFileBytes' | 'maxCandidates', number>>;
}

export interface WorkCreateInput {
  kind: WorkKind;
  title?: string;
  parentId?: string;
  problemKey?: string;
  arenaPath?: string;
  topId?: string;
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
  tags?: { primary?: string | null; related?: string[] };
  labels?: unknown;
  archived?: boolean;
  /** 仅 problemset：null = 清除关联 */
  parentId?: string | null;
}

export interface WorkInitInput {
  path: string;
  confirmExisting?: boolean;
}

export interface WorkArenaSaveInput {
  arenaPath: string;
  /** 目录行给的标题；没有同 arenaPath 的对象时用来建 contest */
  title?: string;
  ghost: WorkArenaGhost;
  view: WorkArenaView;
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
  files: WorkFileDto[];
  fileCount: number;
  sourceCount: number;
  filesTruncated: boolean;
  effectiveArchived: boolean;
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
  taxonomy: WorkTaxonomyFile | null;
  taxonomyError: string | null;
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

  /** 回放页 / 目录行读回存档：按 `links.arenaPath` 找唯一的 contest 对象 */
  getArenaRecord(arenaPath: string): WorkArenaRecordDto {
    const obj = this.contestByArenaPath(arenaPath);
    const file = join(obj.absPath, 'record.json');
    const fileStat = lstatOrNull(file);
    if (fileStat === null) throw new WorkError('not-found', '这场还没有保存过成绩');
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new WorkError('unsafe-path', 'record.json 必须是普通文件，不允许符号链接');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new WorkError('internal', `record.json 读不出来：${asError(err).message}`);
    }
    const parsed = parseWorkArenaRecord(raw);
    if (!parsed.ok) throw new WorkError('internal', `record.json 不合法：${parsed.message}`);
    if (parsed.record.arenaPath !== arenaPath) {
      throw new WorkError('conflict', 'record.json 的榜单路径与这场不一致，请先清理存档');
    }
    return parsed.record;
  }

  /** 保存 VP 成绩：同 arenaPath 的 contest 已存在就更新，没有就建一场，然后把 record.json 写进对象文件夹 */
  saveArenaRecord(input: WorkArenaSaveInput): Promise<WorkArenaSaveResult> {
    return this.enqueue(() => this.saveArenaRecordNow(input));
  }

  private contestByArenaPath(arenaPath: string): IndexedObject {
    if (!contestPathOk(arenaPath)) throw new WorkError('invalid', 'arenaPath 不在榜单路径白名单内');
    const idx = this.ensureIndex();
    const matches = idx.objects.filter(
      (obj) => obj.record.meta.kind === 'contest' && obj.record.meta.links.arenaPath === arenaPath,
    );
    if (matches.length === 0) throw new WorkError('not-found', '工坊里还没有这场比赛的 contest 对象');
    if (matches.length > 1) throw new WorkError('conflict', `有 ${matches.length} 个 contest 指向同一场，先清理重复对象`);
    return matches[0]!;
  }

  private saveArenaRecordNow(input: WorkArenaSaveInput): WorkArenaSaveResult {
    if (!contestPathOk(input.arenaPath)) throw new WorkError('invalid', 'arenaPath 不在榜单路径白名单内');
    const stem = input.arenaPath.split('/').pop()?.replace(/\.srk\.json$/, '') ?? input.arenaPath;
    const preTitle = (input.title ?? '').trim() || stem;
    const savedAt = this.nowDate().toISOString();
    const pre = parseWorkArenaRecord({
      schema: 1,
      arenaPath: input.arenaPath,
      title: preTitle,
      savedAt,
      ghost: input.ghost,
      view: input.view,
    });
    if (!pre.ok) throw new WorkError('invalid', pre.message);

    const idx = this.ensureIndex();
    const matches = idx.objects.filter(
      (obj) => obj.record.meta.kind === 'contest' && obj.record.meta.links.arenaPath === input.arenaPath,
    );
    if (matches.length > 1) throw new WorkError('conflict', `有 ${matches.length} 个 contest 指向同一场，先清理重复对象`);

    let obj: IndexedObject;
    if (matches.length === 1) {
      obj = matches[0]!;
    } else {
      const made = this.createNow({ kind: 'contest', title: preTitle, arenaPath: input.arenaPath });
      const created = this.ensureIndex().byId.get(made.id);
      if (created === undefined) throw new WorkError('internal', '保存成绩时创建的比赛对象没有进入索引');
      obj = created;
    }

    const record: WorkArenaRecordDto = { ...pre.record, title: obj.record.meta.title, savedAt };
    writeFileAtomic(join(obj.absPath, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    const fresh = this.refreshIndex();
    const updated = fresh.byId.get(obj.record.meta.id);
    if (updated === undefined) throw new WorkError('internal', '保存成绩后对象没有进入索引');
    return { record, object: this.dtoOf(updated) };
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
    const taxPath = join(anvil, 'taxonomy.json');
    if (lstatOrNull(taxPath) === null) {
      writeFileAtomic(taxPath, `${JSON.stringify(seedTaxonomy(), null, 2)}\n`);
    }

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
    if (kind !== 'problem' && (input.problemKey !== undefined || input.templateId !== undefined)) {
      throw new WorkError('invalid', 'problemKey / templateId 只属于 problem');
    }
    if (kind !== 'contest' && input.arenaPath !== undefined) throw new WorkError('invalid', 'arenaPath 只属于 contest');
    if (kind !== 'template' && input.topId !== undefined) throw new WorkError('invalid', 'topId 只属于 template');

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
      if (kind === 'problem' && parent.effectiveArchived) throw new WorkError('invalid', '父比赛已归档，不能往里建题');
      // 0..n（27 §2.1）：一个比赛可以被任意多个题组关联；只挡「目标已归档」（27 §1.7）
      if (kind === 'problemset' && parent.effectiveArchived) {
        throw new WorkError('invalid', '关联的比赛已归档，先取消归档再关联');
      }
    }

    let title = input.title === undefined ? '' : input.title.trim();
    if (title === '') {
      if (kind !== 'problem' || problemKey === '') throw new WorkError('invalid', 'title 不能为空');
      title = this.lookupProblemName(problemKey) ?? problemKey;
    }
    if (title.length > 120) throw new WorkError('invalid', 'title 太长');

    let topId: string | null = null;
    if (input.topId !== undefined && input.topId !== '') {
      if (idx.taxonomy === null) throw new WorkError('invalid', '词表不可用，暂时不能指定模板分类');
      if (!idx.taxonomy.nodes.some((n) => n.id === input.topId)) throw new WorkError('invalid', 'topId 必须是一级词表节点');
      topId = input.topId;
    }

    let templateSource: IndexedObject | null = null;
    const explicitTemplate = typeof input.templateId === 'string' ? input.templateId.trim() : '';
    if (explicitTemplate !== '') {
      templateSource = idx.byId.get(explicitTemplate) ?? null;
      if (templateSource === null) throw new WorkError('not-found', '来源模板不存在');
      if (templateSource.record.meta.kind !== 'template') throw new WorkError('invalid', 'templateId 必须指向模板对象');
    } else if (kind === 'problem' && input.templateId === undefined) {
      // 未选模板 = 用默认模板（非归档里 updatedAt 最新的那件），与创建对话框同一判据
      templateSource = this.defaultTemplateOf(idx);
    }

    const date = this.nowDate();
    const pathInput = {
      title,
      problemKey,
      arenaPath,
      parentRelPath: parent === null ? null : parent.relPath,
      topId,
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
        tags: { primary: null, related: [] },
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
    if (entries.includes('test.cpp')) copyFileSync(join(sourceAbs, 'test.cpp'), join(targetAbs, 'test.cpp'));
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
      if (linked.effectiveArchived) throw new WorkError('invalid', '关联的比赛已归档，先取消归档再关联');
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
      tags: { primary: null, related: [] },
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
    // 归档冻结（27 §4）：已归档对象只允许取消归档，其余字段一律拒绝
    if (current.archived) {
      const frozenFields = [input.title, input.tags, input.labels, input.parentId].some((field) => field !== undefined);
      if (frozenFields) throw new WorkError('conflict', '已归档的对象是只读的；先取消归档再修改');
    }
    const next: WorkMeta = {
      ...current,
      tags: { primary: current.tags.primary, related: [...current.tags.related] },
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

    if (input.tags !== undefined) {
      const nodeIds = idx.taxonomy === null ? null : new Set(flattenTaxonomy(idx.taxonomy.nodes).map((n) => n.id));
      const checkNode = (id: string): void => {
        if (nodeIds === null || !nodeIds.has(id)) throw new WorkError('invalid', `词表里没有这个节点：${id}`);
      };
      if (input.tags.primary !== undefined) {
        if (input.tags.primary !== null) checkNode(input.tags.primary);
        if (next.tags.primary !== input.tags.primary) {
          next.tags.primary = input.tags.primary;
          changed = true;
        }
      }
      if (input.tags.related !== undefined) {
        if (!Array.isArray(input.tags.related)) throw new WorkError('invalid', 'related 必须是数组');
        const related: string[] = [];
        for (const id of input.tags.related) {
          checkNode(id);
          if (id !== next.tags.primary && !related.includes(id)) related.push(id);
        }
        if (JSON.stringify(related) !== JSON.stringify(next.tags.related)) {
          next.tags.related = related;
          changed = true;
        }
      }
      // primary 改了以后，related 里不能再留同一个节点
      if (next.tags.primary !== null && next.tags.related.includes(next.tags.primary)) {
        next.tags.related = next.tags.related.filter((id) => id !== next.tags.primary);
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
          throw new WorkError('invalid', '关联的比赛已归档，先取消归档再调整关联');
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
        if (linked.effectiveArchived) throw new WorkError('invalid', '关联的比赛已归档，先取消归档再关联');
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
    const m = manifest as { schema?: unknown; id?: unknown; originalRelPath?: unknown };
    if (m.schema !== 1 || m.id !== id || typeof m.originalRelPath !== 'string' || m.originalRelPath === '') {
      throw new WorkError('not-found', '回收站清单不完整');
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

    let taxonomy: WorkTaxonomyFile | null = null;
    let taxonomyError: string | null = null;
    const taxPath = join(root, '.anvil', 'taxonomy.json');
    const taxStat = lstatOrNull(taxPath);
    if (taxStat === null) {
      taxonomyError = '词表读取失败：.anvil/taxonomy.json 不存在';
    } else if (taxStat.isSymbolicLink() || !taxStat.isFile()) {
      taxonomyError = '词表读取失败：taxonomy.json 必须是普通文件，不允许符号链接';
    } else {
      try {
        const parsed = parseTaxonomy(JSON.parse(readFileSync(taxPath, 'utf8')));
        if (parsed.ok) taxonomy = parsed.taxonomy;
        else taxonomyError = parsed.message;
      } catch (err) {
        taxonomyError = `词表读取失败：${asError(err).message}`;
      }
    }

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
    for (const item of survivors) {
      const indexed: IndexedObject = {
        record: item.record,
        relPath: item.relPath,
        absPath: item.absPath,
        files: item.files,
        fileCount: item.fileCount,
        sourceCount: item.sourceCount,
        filesTruncated: item.filesTruncated,
        effectiveArchived: item.record.meta.archived,
      };
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

    if (taxonomy !== null) {
      const nodeIds = new Set(flattenTaxonomy(taxonomy.nodes).map((n) => n.id));
      for (const obj of objects) {
        const tags = obj.record.meta.tags;
        const missing = [tags.primary, ...tags.related].filter((id): id is string => id !== null && !nodeIds.has(id));
        if (missing.length > 0) {
          errors.push({ relPath: obj.relPath, kind: 'tag-missing', message: `词表里找不到：${missing.join(', ')}` });
        }
      }
    }

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
          errors.push({ relPath: toPosix(`.anvil/trash/${entry.name}`), kind: 'meta-invalid', message: 'trash.json 字段不完整' });
          continue;
        }
        if (!trashDirs.has(m.id)) trashDirs.set(m.id, dirAbs);
        trash.push({ id: m.id, title: m.title, originalRelPath: m.originalRelPath, trashedAt: m.trashedAt });
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
      taxonomy,
      taxonomyError,
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
      taxonomy: this.taxonomyDto(idx, archived),
      taxonomyError: idx.taxonomyError,
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
      tags: { primary: meta.tags.primary, related: [...meta.tags.related] },
      labels: [...meta.labels],
      links: { ...meta.links },
      archived: meta.archived,
      effectiveArchived: obj.effectiveArchived,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      fileCount: obj.fileCount,
      sourceCount: obj.sourceCount,
      ...(meta.sourcePath === undefined ? {} : { sourcePath: meta.sourcePath }),
    };
  }

  private detailOf(obj: IndexedObject): WorkObjectDetailDto {
    return { ...this.dtoOf(obj), files: [...obj.files], filesTruncated: obj.filesTruncated };
  }

  private taxonomyDto(idx: WorkIndex, archived = false): WorkTaxonomyDto | null {
    if (idx.taxonomy === null) return null;
    const flat = flattenTaxonomy(idx.taxonomy.nodes);
    const parentOf = new Map(flat.map((n) => [n.id, n.parentId]));
    const valid = new Set(flat.map((n) => n.id));
    const counts = new Map<string, number>();
    for (const obj of idx.objects) {
      if (obj.effectiveArchived !== archived) continue;
      const primary = obj.record.meta.tags.primary;
      if (primary === null || !valid.has(primary)) continue;
      counts.set(primary, (counts.get(primary) ?? 0) + 1);
      const parent = parentOf.get(primary);
      if (parent !== undefined && parent !== null) counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    const mapNode = (node: WorkTaxonomyFile['nodes'][number]): WorkTaxonomyDto['nodes'][number] => ({
      id: node.id,
      name: node.name,
      count: counts.get(node.id) ?? 0,
      ...(node.children === undefined ? {} : { children: node.children.map(mapNode) }),
    });
    return { version: idx.taxonomy.version, nodes: idx.taxonomy.nodes.map(mapNode) };
  }
}
