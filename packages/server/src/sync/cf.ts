import { cfEnvelopeSchema } from '@anvil/shared';
import type { RatingInput, SubmissionRow } from '../db.ts';

export const API_BASE = 'https://codeforces.com/api';
export const PAGE_SIZE = 10000;
export const MIN_INTERVAL_MS = 2000;
export const MAX_RETRIES = 3;
export const REQUEST_TIMEOUT_MS = 30000;
/** 练习 / 场外提交的哨兵值 */
export const OFFSITE_SENTINEL = 2147483647;

export type CfErrorKind = 'not-found' | 'rate-limited' | 'network' | 'failed';

export class CfError extends Error {
  readonly kind: CfErrorKind;
  readonly detail: string;

  constructor(kind: CfErrorKind, message: string, detail = '') {
    super(message);
    this.name = 'CfError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** CF 侧一次请求返回的提交记录（只声明本切片要落库的字段） */
export interface CfSubmissionRaw {
  id: number;
  contestId?: number;
  creationTimeSeconds: number;
  relativeTimeSeconds?: number;
  programmingLanguage?: string;
  verdict?: string;
  problem?: {
    contestId?: number;
    index?: string;
    name?: string;
    rating?: number;
    tags?: string[];
  };
  author?: { participantType?: string };
}

export interface CfRatingRaw {
  contestId: number;
  contestName: string;
  handle: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
}

export interface CfClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxRetries?: number;
  now?: () => number;
}

const TRANSIENT = /rate limit|temporar|too many|internal|unavailable|timed out|timeout|overload/i;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? '请求超时' : err.message;
  return String(err);
}

/** CF 偶尔回 HTML（网关 / 维护页）：转成信封交给上层报错，不让 JSON.parse 抛穿 */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { status: 'BAD_JSON', comment: '返回的不是 JSON' };
  }
}

export class CfClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(options: CfClientOptions = {}) {
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

  async call<T>(method: string, params: Record<string, string | number>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) qs.set(key, String(value));
    const url = `${API_BASE}/${method}?${qs}`;

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let transient = '';
      try {
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          transient = `Codeforces HTTP ${res.status}`;
        } else {
          const env = cfEnvelopeSchema.safeParse(readJson(text));
          if (!env.success) throw new CfError('failed', 'Codeforces 响应结构不认识', `method=${method}`);
          if (env.data.status === 'OK') return env.data.result as T;
          const comment = env.data.comment || '未知原因';
          if (/not found/i.test(comment)) throw new CfError('not-found', comment, `method=${method}`);
          if (!TRANSIENT.test(comment)) throw new CfError('failed', comment, `method=${method}`);
          transient = comment;
        }
      } catch (err) {
        if (err instanceof CfError) throw err;
        transient = reasonOf(err);
      }
      if (attempt >= this.maxRetries) {
        throw new CfError('network', `Codeforces 请求失败（已重试 ${this.maxRetries} 次）：${transient}`, `method=${method}`);
      }
      await this.sleep(2 ** attempt * 1000);
    }
  }

  /** 只发一条请求确认 handle 存在 */
  async checkHandle(handle: string): Promise<void> {
    await this.call<unknown>('user.status', { handle, count: 1 });
  }
}

export function parseSubmission(sub: CfSubmissionRaw): SubmissionRow {
  const p = sub.problem ?? {};
  const contestId = p.contestId ?? sub.contestId ?? null;
  const index = p.index ?? null;
  return {
    id: sub.id,
    contestId,
    problemKey: `cf:${contestId ?? 0}:${index ?? 'X'}`,
    problemName: p.name ?? null,
    problemRating: p.rating ?? null,
    problemTagsJson: JSON.stringify(p.tags ?? []),
    verdict: sub.verdict ?? null,
    language: sub.programmingLanguage ?? null,
    participantType: sub.author?.participantType ?? null,
    createdTs: sub.creationTimeSeconds,
    relativeTs: sub.relativeTimeSeconds === OFFSITE_SENTINEL ? null : (sub.relativeTimeSeconds ?? null),
  };
}

export function parseRating(r: CfRatingRaw): RatingInput {
  return {
    contestId: r.contestId,
    contestName: r.contestName,
    rank: r.rank,
    oldRating: r.oldRating,
    newRating: r.newRating,
    updatedTs: r.ratingUpdateTimeSeconds,
  };
}
