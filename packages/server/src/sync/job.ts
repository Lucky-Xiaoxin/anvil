import { type DatabaseSync } from 'node:sqlite';
import type { SyncStateDto } from '@anvil/shared';
import {
  countDistinctOkProblems,
  countOffsite,
  countRatingContests,
  countSubmissions,
  insertSubmissions,
  setSyncState,
  upsertRatingHistory,
  type RatingInput,
} from '../db.ts';
import { CfError, PAGE_SIZE, parseRating, parseSubmission, type CfClient, type CfRatingRaw, type CfSubmissionRaw } from './cf.ts';

export const IDLE_STATE: SyncStateDto = {
  phase: 'idle',
  fetched: 0,
  stored: 0,
  total: 0,
  pages: 0,
  problems: 0,
  ratingContests: 0,
  offsite: 0,
};

export function deriveState(db: DatabaseSync): Pick<SyncStateDto, 'total' | 'problems' | 'ratingContests' | 'offsite'> {
  return {
    total: countSubmissions(db),
    problems: countDistinctOkProblems(db),
    ratingContests: countRatingContests(db),
    offsite: countOffsite(db),
  };
}

export type SyncPatch = Partial<Omit<SyncStateDto, 'error'>> & { error?: string };

/**
 * 全量：from=1 一页一页拉到底。
 * 增量：接口默认新→旧，一旦某页出现已存 id 就停（重拉不重复，幂等）。
 */
export async function syncOnce(
  db: DatabaseSync,
  handle: string,
  client: CfClient,
  onChange?: (state: SyncStateDto) => void,
): Promise<SyncStateDto> {
  const startCount = countSubmissions(db);
  const full = startCount === 0;
  let state: SyncStateDto = { ...IDLE_STATE, ...deriveState(db), phase: 'fetching' };
  const publish = (patch: SyncPatch) => {
    state = { ...state, ...patch };
    onChange?.(state);
  };

  let from = 1;
  let fetched = 0;
  let stored = 0;
  let pages = 0;

  try {
    for (;;) {
      const page = await client.call<CfSubmissionRaw[]>('user.status', { handle, from, count: PAGE_SIZE });
      pages++;
      fetched += page.length;
      stored += insertSubmissions(db, page.map(parseSubmission));
      publish({
        phase: 'fetching',
        fetched,
        stored,
        pages,
        problems: countDistinctOkProblems(db),
        total: startCount + fetched + (page.length === PAGE_SIZE ? PAGE_SIZE : 0),
      });
      if (page.length < PAGE_SIZE) break;
      if (!full && stored < fetched) break;
      from += PAGE_SIZE;
    }

    publish({ phase: 'storing', total: countSubmissions(db) });
    const rating = await client.call<CfRatingRaw[]>('user.rating', { handle });
    const rows: RatingInput[] = rating.map(parseRating);
    upsertRatingHistory(db, rows);
    setSyncState(db, 'last_sync_at', String(Math.floor(Date.now() / 1000)));
    publish({ phase: 'done', ...deriveState(db) });
    return state;
  } catch (err) {
    const message =
      err instanceof CfError ? `${err.message}${err.detail ? `（${err.detail}）` : ''}` : `同步失败：${String(err)}`;
    setSyncState(db, 'last_error', message);
    publish({ phase: 'error', error: message, total: countSubmissions(db) });
    return state;
  }
}
