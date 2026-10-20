import type {
  ArenaCatalogDto,
  ArenaContestDto,
  DashboardDto,
  SourceId,
  StatusDto,
  SyncSourceId,
  SyncStatesDto,
  XcpcProfileDto,
  XcpcRefreshDto,
  XcpcSearchRow,
} from '@anvil/shared';

export class ApiError extends Error {
  readonly kind: string;
  constructor(message: string, kind = 'unknown') {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
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
  try {
    res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as { name?: string }).name === 'TimeoutError') {
      throw new ApiError(`本地服务响应超时（>${Math.round(timeoutMs / 1000)} 秒）`, 'timeout');
    }
    throw new ApiError('连不上本地服务，ANVIL 可能没在跑', 'offline');
  }
  const text = await res.text();
  const body = text === '' ? null : readJson(text);
  if (!res.ok) {
    const detail = (body as { error?: { kind?: string; message?: string } } | null)?.error;
    throw new ApiError(detail?.message ?? `接口 ${path} 返回 HTTP ${res.status}`, detail?.kind ?? 'http');
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

export const claimXcpc = (key: string): Promise<XcpcProfileDto> => request<XcpcProfileDto>('/api/xcpc/claim', post({ key }), 90_000);

/** 拉快照 = 比版本后按需重拉，单请求往返，不走 /api/sync 的 runner */
export const refreshXcpc = (): Promise<XcpcRefreshDto> => request<XcpcRefreshDto>('/api/xcpc/refresh', post({}), 90_000);

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
