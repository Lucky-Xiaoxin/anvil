import { type DatabaseSync } from 'node:sqlite';
import { aggregateDashboard, buildRating, type DashboardDto } from '@anvil/shared';
import { loadAcEvents, loadRatingRows } from './db.ts';

export function buildDashboard(db: DatabaseSync, today = new Date()): DashboardDto {
  const { activity, stats } = aggregateDashboard(loadAcEvents(db), today);
  return { activity, stats, rating: buildRating(loadRatingRows(db)) };
}
