import type {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
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
  request<StatusDto>('/api/config', post(patch));
export const startSync = (source: SyncSourceId): Promise<SyncStatesDto> => request<SyncStatesDto>('/api/sync', post({ source }));

/** 未认领是正常态而非故障，404 在这里折成 null，不进错误提示条 */
export async function getXcpc(): Promise<XcpcProfileDto | null> {
  try {
    return await request<XcpcProfileDto>('/api/xcpc');
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'unclaimed') return null;
    throw err;
  }
}

export const searchXcpc = (q: string): Promise<{ results: XcpcSearchRow[] }> =>
  request<{ results: XcpcSearchRow[] }>(`/api/xcpc/search?q=${encodeURIComponent(q)}`);

export const claimXcpc = (key: string): Promise<XcpcProfileDto> => request<XcpcProfileDto>('/api/xcpc/claim', post({ key }));

/** 拉快照 = 比版本后按需重拉，单请求往返，不走 /api/sync 的 runner */
export const refreshXcpc = (): Promise<XcpcRefreshDto> => request<XcpcRefreshDto>('/api/xcpc/refresh', post({}));

/** 源显示名：tab 条、顶栏按钮与错误文案共用一份 */
export const SOURCE_NAME: Record<SourceId, string> = { cf: 'Codeforces', at: 'AtCoder', xcpc: 'XCPC' };
