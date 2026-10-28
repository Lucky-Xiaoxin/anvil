import type {
  ArenaCatalogDto,
  ArenaContestDto,
  DashboardDto,
  SourceId,
  StatusDto,
  SyncSourceId,
  SyncStatesDto,
  WorkArenaGhost,
  WorkArenaRecordDto,
  WorkArenaSaveResult,
  WorkArenaView,
  WorkImportCommitInput,
  WorkImportPlanDto,
  WorkImportResultDto,
  WorkKind,
  WorkObjectDetailDto,
  WorkOpenApp,
  WorkTags,
  WorkTemplateFileDto,
  WorkTrashPurgeResult,
  WorkTreeDto,
  XcpcProfileDto,
  XcpcRefreshDto,
  XcpcSearchRow,
} from '@anvil/shared';

export class ApiError extends Error {
  readonly kind: string;
  /** root-not-empty 时服务端带回的已有项数 */
  readonly entries?: number;
  constructor(message: string, kind = 'unknown', entries?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.entries = entries;
  }
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
  try {
    res = await fetch(path, { ...init, signal });
  } catch (err) {
    // 调用方主动取消（切对象 / 卸载）不是故障，原样交给上层决定是否忽略
    if (init?.signal?.aborted === true) throw new ApiError('请求已取消', 'aborted');
    if ((err as { name?: string }).name === 'TimeoutError') {
      throw new ApiError(`本地服务响应超时（>${Math.round(timeoutMs / 1000)} 秒）`, 'timeout');
    }
    throw new ApiError('连不上本地服务，ANVIL 可能没在跑', 'offline');
  }
  const text = await res.text();
  const body = text === '' ? null : readJson(text);
  if (!res.ok) {
    const detail = (body as { error?: { kind?: string; message?: string; entries?: number } } | null)?.error;
    throw new ApiError(detail?.message ?? `接口 ${path} 返回 HTTP ${res.status}`, detail?.kind ?? 'http', detail?.entries);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const getStatus = (): Promise<StatusDto> => request<StatusDto>('/api/status');
export const getDashboard = (source: 'cf' | 'at'): Promise<DashboardDto> =>
  request<DashboardDto>(`/api/dashboard?source=${source}`);
export const getSyncStates = (): Promise<SyncStatesDto> => request<SyncStatesDto>('/api/sync/state');
export const saveHandles = (patch: { cfHandle?: string; atHandle?: string }): Promise<StatusDto> =>
  request<StatusDto>('/api/config', post(patch), 45_000);
export const startSync = (source: SyncSourceId): Promise<SyncStatesDto> => request<SyncStatesDto>('/api/sync', post({ source }));

/** 未认领是正常态而非故障，404 在这里折成 null，不进错误提示条 */
export async function getXcpc(): Promise<XcpcProfileDto | null> {
  try {
    return await request<XcpcProfileDto>('/api/xcpc', undefined, 45_000);
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'unclaimed') return null;
    throw err;
  }
}

export const searchXcpc = (q: string): Promise<{ results: XcpcSearchRow[] }> =>
  request<{ results: XcpcSearchRow[] }>(`/api/xcpc/search?q=${encodeURIComponent(q)}`, undefined, 45_000);

/**
 * 后端最坏预算：meta 2×20s + 详情 2×60s + 退避 ≈ 161s（claim ≈ 120.5s）。
 * 前端等待必须覆盖它，否则后台还在下载、前台先报超时。
 */
export const XCPC_SYNC_TIMEOUT_MS = 180_000;

export const claimXcpc = (key: string): Promise<XcpcProfileDto> =>
  request<XcpcProfileDto>('/api/xcpc/claim', post({ key }), XCPC_SYNC_TIMEOUT_MS);

/** 拉快照 = 比版本后按需重拉，单请求往返，不走 /api/sync 的 runner */
export const refreshXcpc = (): Promise<XcpcRefreshDto> =>
  request<XcpcRefreshDto>('/api/xcpc/refresh', post({}), XCPC_SYNC_TIMEOUT_MS);

/** 源显示名：tab 条、顶栏按钮与错误文案共用一份 */
export const SOURCE_NAME: Record<SourceId, string> = { cf: 'Codeforces', at: 'AtCoder', xcpc: 'XCPC' };

/* ---------- 模拟榜单（docs/contracts/16 §2.2）：一切取数走服务端代理，前端不出网 ---------- */

export const getArenaCatalog = (refresh = false): Promise<ArenaCatalogDto> =>
  request<ArenaCatalogDto>(`/api/arena/catalog${refresh ? '?refresh=1' : ''}`, undefined, 30_000);

/** 单场 ~1.5MB，进回放才拉；已缓存场次离线可回放（服务端折成 fromCache） */
export const getArenaContest = (path: string, refresh = false): Promise<ArenaContestDto> =>
  request<ArenaContestDto>(
    `/api/arena/contest?path=${encodeURIComponent(path)}${refresh ? '&refresh=1' : ''}`,
    undefined,
    120_000,
  );

/* ---------- 工坊（docs/contracts/23 §9.2）：受管工作区 / 对象 / 标签 ---------- */

export interface WorkRescanSummaryDto {
  scannedAt: number;
  objects: number;
  added: number;
  removed: number;
  unregistered: number;
  errors: number;
}

export const getWorkTree = (opts: { archived?: boolean; rescan?: boolean; signal?: AbortSignal } = {}): Promise<WorkTreeDto> =>
  request<WorkTreeDto>(
    `/api/work/tree?archived=${opts.archived === true ? '1' : '0'}&rescan=${opts.rescan === true ? '1' : '0'}`,
    opts.signal === undefined ? undefined : { signal: opts.signal },
    45_000,
  );

export const initWork = (path: string, confirmExisting = false): Promise<WorkTreeDto> =>
  request<WorkTreeDto>('/api/work/init', post({ path, confirmExisting }), 45_000);

export const getWorkObject = (id: string, signal?: AbortSignal): Promise<WorkObjectDetailDto> =>
  request<WorkObjectDetailDto>(
    `/api/work/object?id=${encodeURIComponent(id)}`,
    signal === undefined ? undefined : { signal },
  );

export const createWork = (body: {
  kind: WorkKind;
  title?: string;
  parentId?: string;
  problemKey?: string;
  arenaPath?: string;
  topId?: string;
  /** 省略 = 默认模板；null / '' = 不复制 */
  templateId?: string | null;
}): Promise<WorkObjectDetailDto> => request<WorkObjectDetailDto>('/api/work/create', post(body), 30_000);

export const adoptWork = (body: { relPath: string; kind: WorkKind; title?: string; parentId?: string | null }): Promise<WorkObjectDetailDto> =>
  request<WorkObjectDetailDto>('/api/work/adopt', post(body), 30_000);

export const updateWork = (body: {
  id: string;
  title?: string;
  tags?: { primary?: string | null; related?: string[] };
  labels?: string[];
  archived?: boolean;
  /** 仅题组：关联 / 清除关联比赛（26 §4.2） */
  parentId?: string | null;
}): Promise<WorkObjectDetailDto> => request<WorkObjectDetailDto>('/api/work/update', post(body), 30_000);

export const trashWork = (id: string): Promise<{ id: string; trashName: string }> =>
  request<{ id: string; trashName: string }>('/api/work/trash', post({ id }), 30_000);

export const restoreWork = (id: string): Promise<WorkObjectDetailDto> =>
  request<WorkObjectDetailDto>('/api/work/restore', post({ id }), 30_000);

export const purgeWorkTrash = (): Promise<WorkTrashPurgeResult> =>
  request<WorkTrashPurgeResult>('/api/work/trash/purge', post({ confirm: true }), 30_000);

export const openWork = async (id: string, relPath?: string, app?: WorkOpenApp): Promise<void> => {
  await request<null>(
    '/api/work/open',
    post({ id, ...(relPath === undefined ? {} : { relPath }), ...(app === undefined ? {} : { app }) }),
    30_000,
  );
};

/* 旧代码导入（docs/contracts/24）：扫描可长达数分钟，提交要复制整棵目录 */
export const scanWorkImport = (sourceRoot: string): Promise<WorkImportPlanDto> =>
  request<WorkImportPlanDto>('/api/work/import/scan', post({ sourceRoot }), 5 * 60_000);

export const commitWorkImport = (input: WorkImportCommitInput): Promise<WorkImportResultDto> =>
  request<WorkImportResultDto>('/api/work/import/commit', post(input), 10 * 60_000);

export const rescanWork = (): Promise<WorkRescanSummaryDto> => request<WorkRescanSummaryDto>('/api/work/rescan', post({}), 45_000);

/** 模板详情内联编辑：只读写一个主文件（切片 5a.1） */
export const getWorkTemplate = (id: string): Promise<WorkTemplateFileDto> =>
  request<WorkTemplateFileDto>(`/api/work/template?id=${encodeURIComponent(id)}`);

export const saveWorkTemplate = (id: string, content: string, baseRevision: string | null): Promise<WorkTemplateFileDto> =>
  request<WorkTemplateFileDto>('/api/work/template', post({ id, content, baseRevision }), 30_000);

/** VP 成绩存档：按榜单路径找工坊 contest 对象，读/写对象文件夹里的 record.json */
export const getWorkArenaRecord = (path: string): Promise<WorkArenaRecordDto> =>
  request<WorkArenaRecordDto>(`/api/work/arena-record?path=${encodeURIComponent(path)}`, undefined, 30_000);

export const saveWorkArenaRecord = (body: {
  arenaPath: string;
  title?: string;
  ghost: WorkArenaGhost;
  view: WorkArenaView;
}): Promise<WorkArenaSaveResult> => request<WorkArenaSaveResult>('/api/work/arena-record', post(body), 30_000);
