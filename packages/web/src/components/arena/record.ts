/** 回放幽灵数据 ↔ record.json 存档的映射；目录行与回放顶栏共用 */
import type { WorkArenaGhost, WorkArenaRecordDto, WorkArenaView } from '@anvil/shared';
import { ApiError, getWorkArenaRecord } from '../../api.ts';
import { shortStamp } from '../../format.ts';
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

/** 目录行保存：有进行中的钟就存 live 位置，否则按回顾会话位置存 review；scrubMs=0 是合法位置，不能拿终榜顶替 */
export function viewOfRow(store: Store, row: LeafRow, live: { elapsed: number; paused: boolean } | null): WorkArenaView {
  if (live !== null) return { mode: 'live', viewMs: live.elapsed, paused: live.paused, frozenView: false };
  const session = loadSession(store, row.path);
  const viewMs = session === null ? 0 : session.scrubMs;
  return { mode: 'review', viewMs, paused: false, frozenView: false };
}

/**
 * 保存前探一次这场的已有存档。
 * 404 = 还没存过，返回 null；其它错误照抛（那种状态下保存本身也会失败，不静默放行）。
 */
export async function probeSavedRecord(arenaPath: string): Promise<WorkArenaRecordDto | null> {
  try {
    return await getWorkArenaRecord(arenaPath);
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'not-found') return null;
    throw err;
  }
}

/** 一场只有一份 record.json，第二次保存是整份替换：先点名会被抹掉的那份，再等第二次点击 */
export function overwriteHintOf(record: WorkArenaRecordDto, now = Date.now()): string {
  return `已有 ${shortStamp(Math.floor(Date.parse(record.savedAt) / 1000), now)} 的存档 · ${record.ghost.subs.length} 发`;
}

/** 本地录入与工坊存档是否同一份：题序不参与比较，结果与时刻都算 */
export function ghostsAgree(a: WorkArenaGhost | GhostData, b: WorkArenaGhost | GhostData): boolean {
  const key = (g: WorkArenaGhost | GhostData): string =>
    JSON.stringify({ show: g.show, subs: [...g.subs].sort((x, y) => x.p - y.p || x.t - y.t) });
  return key(a) === key(b);
}
