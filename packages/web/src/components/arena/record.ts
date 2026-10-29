/** 回放幽灵数据 ↔ 多存档 DTO 的映射与命名；目录行、回放顶栏、工坊共用 */
import type {
  ArenaRecord,
  ArenaRecordResult,
  ArenaRecordSummaryDto,
  WorkArenaGhost,
  WorkArenaRecordDto,
} from '@anvil/shared';
import { arenaResultLabel, copyArenaRecordName, defaultArenaRecordName, legacyArenaRecordName } from '@anvil/shared';
import { fullStamp } from '../../format.ts';
import type { LeafRow } from './catalog.ts';
import type { GhostData } from './session.ts';

export function arenaTitleOf(row: LeafRow): string {
  return `${row.date} ${row.name}`.trim() || row.path;
}

export function ghostToRecord(ghost: GhostData): WorkArenaGhost {
  return { show: ghost.show, subs: ghost.subs.map((s) => ({ p: s.p, t: s.t, r: s.r })) };
}

export function recordToGhost(ghost: WorkArenaGhost): GhostData {
  return { show: ghost.show, subs: ghost.subs.map((s) => ({ p: s.p, t: s.t, r: s.r })) };
}

/** 客户端生成新档 ID：rec_ + 32 位小写十六进制（契约 §4.1） */
export function newRecordId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `rec_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 首次保存默认名：本地日期 时间 */
export function firstSaveName(now = new Date()): string {
  return defaultArenaRecordName(now);
}

/** 另存默认名：原名称 副本 */
export function copySaveName(name: string): string {
  return copyArenaRecordName(name);
}

export function legacyRecordDisplayName(record: WorkArenaRecordDto): string {
  return legacyArenaRecordName(record.savedAt);
}

/** 存档时间读数（上海时钟到分钟）；坏时间原样返回，不编造 */
export function recordStamp(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : fullStamp(Math.floor(at / 1000));
}

export function recordSourceLabel(record: ArenaRecord | ArenaRecordSummaryDto): string {
  return arenaResultLabel(record.result);
}

export function recordCountLabel(summary: ArenaRecordSummaryDto): string {
  return `${summary.submissionCount} 发`;
}

/** 列表摘要 / 完整档的结束状态（同一份读法） */
export function resultLabel(result: ArenaRecordResult): string {
  return arenaResultLabel(result);
}
