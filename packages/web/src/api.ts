import type { DashboardDto, StatusDto, SyncStateDto } from '@anvil/shared';

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

const json = (handle: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle }),
});

export const getStatus = (): Promise<StatusDto> => request<StatusDto>('/api/status');
export const getDashboard = (): Promise<DashboardDto> => request<DashboardDto>('/api/dashboard');
export const getSyncState = (): Promise<SyncStateDto> => request<SyncStateDto>('/api/sync/state');
export const saveHandle = (handle: string): Promise<StatusDto> =>
  request<StatusDto>('/api/config', json(handle));
export const startSync = (): Promise<SyncStateDto> =>
  request<SyncStateDto>('/api/sync', { method: 'POST' });
