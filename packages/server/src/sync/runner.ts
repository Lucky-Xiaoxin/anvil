import type { DatabaseSync } from 'node:sqlite';
import type { SyncSourceId, SyncStatesDto, SyncStateDto } from '@anvil/shared';
import { IDLE_STATE as CF_IDLE, deriveState as deriveCfState } from './job.ts';
import { IDLE_STATE as AT_IDLE, deriveAtState } from './at.ts';
import type { SyncSource } from './source.ts';

/**
 * 每个源一份进度快照：AT 挂了不拖累 CF 的读数，反之也一样（docs/09 §2/§3.3）。
 * 两源可以并发跑 —— 串行管的是「同一个源内部的请求之间」，不是「源与源之间」。
 */
const snapshots: SyncStatesDto = { cf: { ...CF_IDLE }, at: { ...AT_IDLE } };
const running = new Map<SyncSourceId, Promise<SyncStateDto>>();

export function idleStates(db: DatabaseSync): SyncStatesDto {
  return {
    cf: { ...CF_IDLE, ...deriveCfState(db) },
    // AT 没有 pages / offsite 概念，快照里就不出这两个键
    at: { ...AT_IDLE, ...deriveAtState(db) },
  };
}

export function initSnapshot(db: DatabaseSync): void {
  Object.assign(snapshots, idleStates(db));
}

export function syncSnapshot(): SyncStatesDto {
  return snapshots;
}

export function isRunning(source: SyncSourceId): boolean {
  return running.has(source);
}

/** 后台起跑：接口立刻回 202，前端 1s 轮询快照。同一源重复点击是空转，不是排队 */
export function startSync(source: SyncSource, handle: string): SyncStatesDto {
  if (!running.has(source.id)) {
    snapshots[source.id] = { ...snapshots[source.id], phase: 'fetching', fetched: 0, stored: 0, error: undefined };
    running.set(
      source.id,
      source
        .sync(handle, (next) => {
          snapshots[source.id] = next;
        })
        .finally(() => {
          running.delete(source.id);
        }),
    );
  }
  return snapshots;
}
