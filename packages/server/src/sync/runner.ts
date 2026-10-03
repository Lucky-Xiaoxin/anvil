import { type DatabaseSync } from 'node:sqlite';
import type { SyncStateDto } from '@anvil/shared';
import { IDLE_STATE, deriveState, syncOnce } from './job.ts';
import type { CfClient } from './cf.ts';

let snapshot: SyncStateDto = { ...IDLE_STATE };
let running: Promise<SyncStateDto> | null = null;

export function initSnapshot(db: DatabaseSync): void {
  snapshot = { ...IDLE_STATE, ...deriveState(db) };
}

export function syncSnapshot(): SyncStateDto {
  return snapshot;
}

export function isRunning(): boolean {
  return running !== null;
}

/** 后台起跑：接口立刻回 202，前端 1s 轮询 snapshot */
export function startSync(db: DatabaseSync, handle: string, client: CfClient): SyncStateDto {
  if (running) return snapshot;
  snapshot = { ...IDLE_STATE, ...deriveState(db), phase: 'fetching' };
  running = syncOnce(db, handle, client, (next) => {
    snapshot = next;
  }).finally(() => {
    running = null;
  });
  return snapshot;
}
