import { type DatabaseSync } from 'node:sqlite';
import { aggregateDashboard, buildRating, type DashboardDto, type SyncSourceId } from '@anvil/shared';
import { loadAcEvents, loadRatingRows } from './db.ts';

/** AT 的诚实标注一行（docs/contracts/09 §5，逐字照抄） */
export const AT_NOTE = '2016 起 · 参赛史非提交史 · 来源：AtCoder 官方页 / AtCoder Problems';

export function buildDashboard(db: DatabaseSync, source: SyncSourceId, today = new Date()): DashboardDto {
  const { activity, stats } = aggregateDashboard(loadAcEvents(db, source), today);
  const rows = loadRatingRows(db, source);
  const rating = buildRating(rows, source);

  if (source === 'at') {
    if (rating) rating.note = AT_NOTE;
    // 曲线只收 rated 场，非 rated 场并进「参赛 N 场」副行（docs/contracts/09 §2/§5）；一场没打过就不出这行，别摆个 0
    if (rows.length > 0) {
      stats.entryCount = `参赛 ${rows.length} 场 · 非 rated ${rows.length - (rating?.count ?? 0)} 场`;
    }
  }
  return { activity, stats, rating };
}
