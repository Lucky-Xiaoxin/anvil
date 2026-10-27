import { type DatabaseSync } from 'node:sqlite';
import type { SyncStateDto } from '@anvil/shared';
import {
  countDistinctOkProblems,
  countOffsite,
  countRatingContests,
  countSubmissions,
  getMeta,
  handleMetaKey,
  insertSubmissions,
  resetSourceData,
  setMeta,
  setSyncState,
  syncKey,
  upsertRatingHistory,
  type RatingInput,
} from '../db.ts';
import {
  CfError,
  PAGE_SIZE,
  parseRating,
  parseSubmission,
  type CfClient,
  type CfRatingRaw,
  type CfSubmissionRaw,
} from './cf.ts';
import type { CheckResult, SyncSource } from './source.ts';
import { life } from '../life.ts';
import { switchNote } from './note.ts';

export const SOURCE = 'cf' as const;

export const IDLE_STATE: SyncStateDto = {
  phase: 'idle',
  fetched: 0,
  stored: 0,
  total: 0,
  problems: 0,
  ratingContests: 0,
  pages: 0,
  offsite: 0,
};

export function deriveState(db: DatabaseSync): Pick<SyncStateDto, 'total' | 'problems' | 'ratingContests' | 'offsite'> {
  return {
    total: countSubmissions(db, SOURCE),
    problems: countDistinctOkProblems(db, SOURCE),
    ratingContests: countRatingContests(db, SOURCE),
    offsite: countOffsite(db, SOURCE),
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
  const owner = getMeta(db, handleMetaKey(SOURCE));
  const stale = countSubmissions(db, SOURCE);
  const switching = owner !== handle;
  const resetNote = switchNote(owner, handle, stale);
  const startCount = switching ? 0 : stale;
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
  // 清空推迟到第一页真的拉到手：换完 handle 正好断网时，本地还留着上一次的缓存可看
  let pendingWipe = switching;

  try {
    for (;;) {
      const page = await client.call<CfSubmissionRaw[]>('user.status', { handle, from, count: PAGE_SIZE });
      if (pendingWipe) {
        life('sync-reset', `${SOURCE} ${owner ?? '(unowned)'} -> ${handle} stale=${stale}`);
        resetSourceData(db, SOURCE);
        setMeta(db, handleMetaKey(SOURCE), handle);
        pendingWipe = false;
      }
      pages++;
      fetched += page.length;
      stored += insertSubmissions(db, SOURCE, page.map(parseSubmission));
      publish({
        phase: 'fetching',
        fetched,
        stored,
        pages,
        problems: countDistinctOkProblems(db, SOURCE),
        total: startCount + fetched + (page.length === PAGE_SIZE ? PAGE_SIZE : 0),
      });
      if (page.length < PAGE_SIZE) break;
      if (!full && stored < fetched) break;
      from += PAGE_SIZE;
    }

    publish({ phase: 'storing', total: countSubmissions(db, SOURCE) });
    const rating = await client.call<CfRatingRaw[]>('user.rating', { handle });
    const rows: RatingInput[] = rating.map(parseRating);
    upsertRatingHistory(db, SOURCE, rows);
    setSyncState(db, syncKey(SOURCE, 'last_sync_at'), String(Math.floor(Date.now() / 1000)));
    setSyncState(db, syncKey(SOURCE, 'last_error'), '');
    publish({ phase: 'done', ...deriveState(db) });
    return state;
  } catch (err) {
    const message =
      err instanceof CfError ? `${err.message}${err.detail ? `（${err.detail}）` : ''}` : `同步失败：${String(err)}`;
    setSyncState(db, syncKey(SOURCE, 'last_error'), message);
    publish({ phase: 'error', error: message, total: countSubmissions(db, SOURCE) });
    return state;
  }
}

/** SyncSource 适配器：CF 的 handle 校验沿用 user.status?count=1 */
export function createCfSource(db: DatabaseSync, client: CfClient): SyncSource {
  return {
    id: SOURCE,
    checkHandle: async (handle: string): Promise<CheckResult> => client.checkHandle(handle),
    sync: (handle: string, onProgress: (p: SyncStateDto) => void) => syncOnce(db, handle, client, onProgress),
  };
}
