import type { DatabaseSync } from 'node:sqlite';
import type { SyncStateDto } from '@anvil/shared';
import {
  countDistinctOkProblems,
  countRatingEntries,
  countSubmissions,
  getMeta,
  handleMetaKey,
  insertSubmissions,
  replaceRatingHistory,
  resetSourceData,
  setMeta,
  setSyncState,
  submissionTimeRange,
  syncKey,
  type RatingInput,
  type SubmissionRow,
} from '../db.ts';
import { switchNote } from './note.ts';
import type { CheckResult, SyncSource } from './source.ts';

export const SOURCE = 'at' as const;

/** 端点主机是 kenkoooo.com/atcoder/… 这条路径；atcoder-api.kenkoooo.com 等旧子域已死（docs/09 §2） */
export const KENKOOLO_BASE = 'https://kenkoooo.com/atcoder/atcoder-api/v3';
export const AT_BASE = 'https://atcoder.jp';

/** 2026-10-04 本机复测：kenkoooo 每请求最多 500 条、按 from_second 升序，全量必须翻页（chokudai 5 页 2230 条） */
export const SUBMISSIONS_PAGE_SIZE = 500;
/** 翻页兜底：真有人提交到 200 页，也该停下来看一眼，别让同步无限跑 */
export const MAX_PAGES = 200;

/** 限流：kenkoooo ≈ 1 req/s、官方同低频；全程串行，不并发（docs/09 §2） */
export const MIN_INTERVAL_MS = 1000;
/** 社区 best-effort 源：429/5xx 退避重试 ≤2 次 */
export const MAX_RETRIES = 2;
/** 大号响应可达数百 KB → 超时放宽 */
export const SUBMISSIONS_TIMEOUT_MS = 60_000;
export const HISTORY_TIMEOUT_MS = 30_000;

/** 如实自报家门：这是个人本地工具的请求，不是爬虫伪装 */
export const USER_AGENT = 'ANVIL/1.0 (personal ICPC training dashboard)';

export const AT_CONTEST_SUFFIX = '.contest.atcoder.jp';

export type AtErrorKind = 'not-found' | 'network' | 'failed';

export class AtError extends Error {
  readonly kind: AtErrorKind;
  readonly detail: string;

  constructor(kind: AtErrorKind, message: string, detail = '') {
    super(message);
    this.name = 'AtError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** kenkoooo 提交明细一行（只声明本切片要落库的字段） */
export interface AtSubmissionRaw {
  id: number;
  epoch_second: number;
  problem_id?: string | null;
  contest_id?: string | null;
  user_id?: string;
  language?: string | null;
  point?: number | null;
  length?: number | null;
  result?: string | null;
  execution_time?: number | string | null;
}

/** atcoder.jp/users/{h}/history/json 一条参赛记录 */
export interface AtHistoryRaw {
  IsRated: boolean;
  Place: number | null;
  OldRating: number;
  NewRating: number;
  Performance: number;
  InnerPerformance?: number;
  ContestScreenName: string;
  ContestName: string;
  ContestNameEn?: string;
  EndTime: string;
}

export interface AtClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxRetries?: number;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? '请求超时' : err.message;
  return String(err);
}

/** 上游回 HTML（维护页 / 反爬墙）时别让 JSON.parse 抛穿，转成可读错误 */
function readJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AtError('failed', `${what} 返回的不是 JSON`, 'bad-json');
  }
}

function asArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new AtError('failed', `${what} 响应结构不认识`, 'shape');
  return value as T[];
}

export class AtClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(options: AtClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.now = options.now ?? Date.now;
  }

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (this.now() - this.lastAt);
    if (wait > 0) await this.sleep(wait);
    this.lastAt = this.now();
  }

  /** 串行 + 限流：429/5xx 与网络异常退避重试 ≤maxRetries 次；404 原样交给调用方判 */
  private async send(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let transient = '';
      try {
        const res = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': USER_AGENT },
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          transient = `AtCoder HTTP ${res.status}`;
        } else {
          return { status: res.status, text };
        }
      } catch (err) {
        if (err instanceof AtError) throw err;
        transient = reasonOf(err);
      }
      if (attempt >= this.maxRetries) {
        throw new AtError(
          'network',
          `AtCoder 请求失败（已退避重试 ${this.maxRetries} 次）：${transient}`,
          url.replace(/^https:\/\//, ''),
        );
      }
      await this.sleep(2 ** attempt * 1000);
    }
  }

  /** 存在性只能走页面状态码：history/json 对不存在的 handle 也回 200 + []（docs/09 §2） */
  async pageStatus(handle: string): Promise<number> {
    const res = await this.send(`${AT_BASE}/users/${encodeURIComponent(handle)}`, HISTORY_TIMEOUT_MS);
    return res.status;
  }

  async checkHandle(handle: string): Promise<CheckResult> {
    try {
      const status = await this.pageStatus(handle);
      if (status === 200) return { ok: true };
      if (status === 404) return { ok: false, kind: 'not-found', message: 'AtCoder 上没有这个 handle（页面 404）' };
      return { ok: false, kind: 'unavailable', message: `AtCoder 返回 HTTP ${status}，认不出这个 handle` };
    } catch (err) {
      if (err instanceof AtError) return { ok: false, kind: 'unavailable', message: err.message };
      return { ok: false, kind: 'unavailable', message: `校验失败：${reasonOf(err)}` };
    }
  }

  /**
   * 提交明细：从 fromSecond 起一页 500 条往前沿着时间走，每页立刻交给 onBatch 落库。
   * 页边界用「重叠一秒 + 主键去重」，同一秒挤满一页才停手。
   */
  async submissions(
    handle: string,
    fromSecond: number,
    onBatch: (rows: AtSubmissionRaw[]) => void,
  ): Promise<{ fetched: number; pages: number }> {
    let from = fromSecond;
    let fetched = 0;
    let pages = 0;
    let lastMax = Number.NEGATIVE_INFINITY;

    for (;;) {
      const qs = new URLSearchParams({ user: handle, from_second: String(from) });
      const res = await this.send(`${KENKOOLO_BASE}/user/submissions?${qs}`, SUBMISSIONS_TIMEOUT_MS);
      if (res.status === 404) throw new AtError('not-found', 'AtCoder Problems 上没有这个用户的提交记录', `user=${handle}`);
      const batch = asArray<AtSubmissionRaw>(readJson(res.text, 'AtCoder Problems'), 'AtCoder Problems');
      pages++;
      fetched += batch.length;
      onBatch(batch);
      if (batch.length < SUBMISSIONS_PAGE_SIZE || pages >= MAX_PAGES) return { fetched, pages };
      const max = batch.reduce((m, r) => Math.max(m, r.epoch_second), 0);
      if (max === lastMax) return { fetched, pages };
      lastMax = max;
      from = max;
    }
  }

  /** 参赛 / rating 史：官方单请求全量。[] 是合法答案（没打过比赛），不是错误 */
  async history(handle: string): Promise<AtHistoryRaw[]> {
    const res = await this.send(`${AT_BASE}/users/${encodeURIComponent(handle)}/history/json`, HISTORY_TIMEOUT_MS);
    if (res.status === 404) throw new AtError('not-found', 'AtCoder 上没有这个 handle', `user=${handle}`);
    return asArray<AtHistoryRaw>(readJson(res.text, 'AtCoder 参赛史'), 'AtCoder 参赛史');
  }
}

/** `agc078.contest.atcoder.jp` → `agc078`（docs/09 §2） */
export function atContestKey(screenName: string): string {
  return screenName.endsWith(AT_CONTEST_SUFFIX) ? screenName.slice(0, -AT_CONTEST_SUFFIX.length) : screenName;
}

export function parseAtSubmission(s: AtSubmissionRaw): SubmissionRow {
  return {
    id: s.id,
    // AT 的 contest_id 是字符串（"abc300"），不进 submissions 的 INTEGER 列；题键里已经带上了
    contestId: null,
    // 题号缺失时退化到提交号：宁可不去重，也不能把两道题并成一道
    problemKey: s.problem_id ? `at:${s.problem_id}` : `at:sub:${s.id}`,
    problemName: null,
    // 题目难度 / 标签本切片不拉（docs/09 §10）→ 存 NULL，界面渲染 —
    problemRating: null,
    problemTagsJson: null,
    // AC → OK：与 CF 用同一个判定词，shared 的聚合函数才能直接复用（docs/09 §5）；
    // 判题中的 result 是空串 → 归 NULL（`??` 拦不住空串），否则订正谓词认不出它是"非最终判定"
    verdict: s.result === 'AC' ? 'OK' : (s.result || null),
    language: s.language ?? null,
    participantType: null,
    createdTs: s.epoch_second,
    relativeTs: null,
  };
}

export function parseAtHistory(r: AtHistoryRaw): RatingInput | null {
  const ts = Math.floor(Date.parse(r.EndTime) / 1000);
  // EndTime 读不懂就别把 1970 塞进曲线
  if (!Number.isFinite(ts)) return null;
  const isRated = r.IsRated === true;
  return {
    contestKey: atContestKey(r.ContestScreenName),
    contestName: r.ContestName || r.ContestNameEn || r.ContestScreenName,
    rank: typeof r.Place === 'number' && r.Place > 0 ? r.Place : null,
    oldRating: r.OldRating,
    newRating: r.NewRating,
    isRated,
    // 非 rated 上游给 0：那不是"跑了 0 分"，是没算 → NULL
    performance: isRated && r.Performance > 0 ? r.Performance : null,
    updatedTs: ts,
  };
}

export const IDLE_STATE: SyncStateDto = {
  phase: 'idle',
  fetched: 0,
  stored: 0,
  total: 0,
  problems: 0,
  ratingContests: 0,
};

export function deriveAtState(db: DatabaseSync): Pick<SyncStateDto, 'total' | 'problems' | 'ratingContests'> {
  return {
    total: countSubmissions(db, SOURCE),
    problems: countDistinctOkProblems(db, SOURCE),
    ratingContests: countRatingEntries(db, SOURCE),
  };
}

/**
 * AT 同步：一次 = 翻页拉提交明细 + 一次官方参赛史，全程串行。
 * 只有用户点击才会走到这里 —— history/json 属官方 robots 灰色口径，不轮询、不预取、不后台跑（docs/09 §2）。
 */
export async function syncAt(
  db: DatabaseSync,
  handle: string,
  client: AtClient,
  onChange?: (state: SyncStateDto) => void,
): Promise<SyncStateDto> {
  const owner = getMeta(db, handleMetaKey(SOURCE));
  const stale = countSubmissions(db, SOURCE);
  const switching = owner !== handle;
  let state: SyncStateDto = { ...IDLE_STATE, ...deriveAtState(db), phase: 'fetching', resetNote: switchNote(owner, handle, stale) };
  const publish = (patch: Partial<Omit<SyncStateDto, 'error'>> & { error?: string }) => {
    state = { ...state, ...patch };
    onChange?.(state);
  };

  let fetched = 0;
  let stored = 0;
  // 与 CF 同一套纪律：清空推迟到第一批真的拉到手，断网时本地还留着上一次的缓存可看
  let pendingWipe = switching;
  // 换人从 epoch 0 全量重拉；同一个人只从已存的最晚一条接着拉（重叠的那几条靠主键忽略）
  const fromSecond = switching ? 0 : (submissionTimeRange(db, SOURCE)?.max ?? 0);

  try {
    await client.submissions(handle, fromSecond, (batch) => {
      if (pendingWipe) {
        resetSourceData(db, SOURCE);
        setMeta(db, handleMetaKey(SOURCE), handle);
        pendingWipe = false;
      }
      fetched += batch.length;
      stored += insertSubmissions(db, SOURCE, batch.map(parseAtSubmission));
      publish({
        phase: 'fetching',
        fetched,
        stored,
        total: stored + (batch.length === SUBMISSIONS_PAGE_SIZE ? SUBMISSIONS_PAGE_SIZE : 0),
        problems: countDistinctOkProblems(db, SOURCE),
      });
    });
    if (pendingWipe) {
      // 上游一条都没有（result 里 200+[] 的一种）：也把库清干净，别让上一个人的记录挂在新 handle 下面
      resetSourceData(db, SOURCE);
      setMeta(db, handleMetaKey(SOURCE), handle);
      pendingWipe = false;
    }

    publish({ phase: 'storing', total: countSubmissions(db, SOURCE) });
    const history = await client.history(handle);
    const rows = history.map(parseAtHistory).filter((r): r is RatingInput => r !== null);
    // 参赛史整域重建：官方不给"这场撤了"的事件，上游删掉的一场必须从本地消失；
    // 清空 + 写入并进一个事务 —— 中途抛错不会把整条曲线丢在"已清空"状态
    replaceRatingHistory(db, SOURCE, rows);
    setSyncState(db, syncKey(SOURCE, 'last_sync_at'), String(Math.floor(Date.now() / 1000)));
    setSyncState(db, syncKey(SOURCE, 'last_error'), '');
    publish({ phase: 'done', ...deriveAtState(db) });
    return state;
  } catch (err) {
    const message =
      err instanceof AtError ? `${err.message}${err.detail ? `（${err.detail}）` : ''}` : `同步失败：${String(err)}`;
    setSyncState(db, syncKey(SOURCE, 'last_error'), message);
    publish({ phase: 'error', error: message, total: countSubmissions(db, SOURCE) });
    return state;
  }
}

export function createAtSource(db: DatabaseSync, client: AtClient): SyncSource {
  return {
    id: SOURCE,
    checkHandle: (handle: string) => client.checkHandle(handle),
    sync: (handle: string, onProgress: (p: SyncStateDto) => void) => syncAt(db, handle, client, onProgress),
  };
}
