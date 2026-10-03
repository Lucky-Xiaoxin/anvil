import { type DatabaseSync } from 'node:sqlite';
import type { SyncStateDto } from '@anvil/shared';
import {
  countDistinctOkProblems,
  countOffsite,
  countRatingContests,
  countSubmissions,
  getMeta,
  insertSubmissions,
  resetUserData,
  setMeta,
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

/** 本地库归属于哪个 handle */
export const META_HANDLE = 'cf_handle';

/**
 * 库只属于一个 handle：换了人就先清空重建。
 * submissions 会把两个人的提交叠在一起，rating_history 更狠——它以 contest_id 为主键，
 * 两人打过的同一场会互相覆盖，曲线变成两个 rating 的拼图。
 */
function claimDatabase(db: DatabaseSync, handle: string): string | null {
  const owner = getMeta(db, META_HANDLE);
  if (owner === handle) return null;
  const stale = countSubmissions(db);
  const note =
    owner === null
      ? stale > 0
        ? `本地数据无法归属 handle → 清空 ${stale} 条，为 ${handle} 重建`
        : null
      : `换 handle：清掉 ${owner} 的 ${stale} 条数据，为 ${handle} 全量重建`;
  resetUserData(db);
  setMeta(db, META_HANDLE, handle);
  return note;
}

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
  const resetNote = claimDatabase(db, handle);
  const startCount = countSubmissions(db);
  const full = startCount === 0;
  let state: SyncStateDto = { ...IDLE_STATE, ...deriveState(db), phase: 'fetching', resetNote };
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
