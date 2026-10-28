import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimXcpc, refreshXcpc, XCPC_SYNC_TIMEOUT_MS } from '../src/api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('XCPC 前端等待上限', () => {
  it('claim / refresh 都覆盖后端最坏重试预算', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await claimXcpc('key');
    await refreshXcpc();

    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([XCPC_SYNC_TIMEOUT_MS, XCPC_SYNC_TIMEOUT_MS]);
    // 服务端最坏：meta 2×20s + 详情 2×60s + 退避 ≈ 161s
    expect(XCPC_SYNC_TIMEOUT_MS).toBeGreaterThanOrEqual(161_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
