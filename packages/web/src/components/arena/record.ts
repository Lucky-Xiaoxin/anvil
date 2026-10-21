/** 回放幽灵数据 ↔ record.json 存档的映射；目录行与回放顶栏共用 */
import type { WorkArenaGhost, WorkArenaView } from '@anvil/shared';
import type { LeafRow } from './catalog.ts';
import { loadSession, type GhostData, type Store } from './session.ts';

export function arenaTitleOf(row: LeafRow): string {
  return `${row.date} ${row.name}`.trim() || row.path;
}

export function ghostToRecord(ghost: GhostData): WorkArenaGhost {
  return { show: ghost.show, subs: ghost.subs.map((s) => ({ p: s.p, t: s.t, r: s.r })) };
}

export function recordToGhost(ghost: WorkArenaGhost): GhostData {
  return { show: ghost.show, subs: ghost.subs.map((s) => ({ p: s.p, t: s.t, r: s.r })) };
}

/** 目录行保存：有进行中的钟就存 live 位置，否则按回顾存档（位置从会话回读，没有就从 0） */
export function viewOfRow(store: Store, row: LeafRow, live: { elapsed: number; paused: boolean } | null): WorkArenaView {
  if (live !== null) return { mode: 'live', viewMs: live.elapsed, paused: live.paused, frozenView: false };
  const session = loadSession(store, row.path);
  const viewMs = session === null ? 0 : session.scrubMs > 0 ? session.scrubMs : session.durationMs;
  return { mode: 'review', viewMs, paused: false, frozenView: false };
}
