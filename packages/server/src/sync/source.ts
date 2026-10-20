import type { SyncSourceId, SyncStateDto } from '@anvil/shared';

/**
 * 同步源接口（docs/contracts/09 §3.3，冻结）：本切片的 cf / at 走它，未来 XCPC 照同一个形状接进来。
 * 硬性要求：按源域清空/重建、单源失败不影响其它源、进度按源上报。
 */
export interface SyncSource {
  id: SyncSourceId;
  checkHandle(handle: string): Promise<CheckResult>;
  sync(handle: string, onProgress: (p: SyncProgress) => void): Promise<SyncResult>;
}

export type SyncProgress = SyncStateDto;
export type SyncResult = SyncStateDto;

/**
 * 校验结果。契约（docs/contracts/09 §3.3）只锁了 `{ ok:false; message }`；
 * `kind` 是实现侧加的可选判别位，用来把「查无此人」和「上游不在线」分给不同的 HTTP 状态码。
 */
export type CheckResult = { ok: true } | { ok: false; kind?: 'not-found' | 'unavailable'; message: string };
