/**
 * XCPC 取数 · 搜索 · 认领 · 快照刷新（docs/14 §2 / §4）—— 数据源是 heimaom.cn 的静态导出，
 * 即 xcpcrating 社区快照，**非官方**。"同步" = 拉最新快照，不是实时数据。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { XCPC_METALS, XCPC_TIERS } from '@anvil/shared';
import type {
  SourceState,
  XcpcHistoryRow,
  XcpcMedals,
  XcpcMetal,
  XcpcPlayerDto,
  XcpcProfileDto,
  XcpcRefreshDto,
  XcpcSearchRow,
  XcpcStatusDto,
  XcpcTier,
} from '@anvil/shared';
import {
  getSyncState,
  loadXcpcPlayer,
  replaceXcpcPlayer,
  setSyncState,
  syncKey,
  type XcpcStoredPlayer,
} from '../db.ts';

export const XCPC_BASE = 'https://heimaom.cn/data/';
/** 社区快照周期本来就慢：过期判据看「数据版本」而不是本地同步时刻（docs/14 §4） */
export const XCPC_STALE_AFTER_DAYS = 10;
export const SEARCH_TIMEOUT_MS = 20_000;
/** 详情分片实测单片 1.8MB，超时放宽（docs/14 §2.2） */
export const DETAIL_TIMEOUT_MS = 60_000;
export const MAX_RESULTS = 8;
export const MAX_RETRIES = 1;
/** 缺 key 时保留旧数据，这条就是那条错误原文（docs/14 §4） */
export const MISSING_IN_SNAPSHOT = '档案在新版快照中未找到 · 保留本地数据';

const USER_AGENT = 'ANVIL/1.0 (personal ICPC training dashboard)';
/** 站点 hay 的分隔符：一个不会出现在姓名 / 校名里的控制字符，免得跨字段假命中 */
const HAY_SEP = '\x01';

export type XcpcErrorKind = 'not-found' | 'unavailable' | 'busy';

/**
 * 只带一句人话：界面把它直接当降级条的第二行显示，所以消息里不放主机名与路径，
 * 也不重复「XCPC 快照暂不可达」——那句话由界面自己说。
 */
export class XcpcError extends Error {
  readonly kind: XcpcErrorKind;

  constructor(kind: XcpcErrorKind, message: string) {
    super(message);
    this.name = 'XcpcError';
    this.kind = kind;
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? '请求超时' : err.message;
  return String(err);
}

function readJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new XcpcError('unavailable', '快照返回的不是 JSON');
  }
}

/* ---------- 分桶 / 分片键 ---------- */

function md5hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** 桶名 = md5(小写后首字符)[:2]（docs/14 §2.1） */
export function bucketOf(query: string): string {
  const first = String.fromCodePoint(query.codePointAt(0) ?? 0);
  return md5hex(first).slice(0, 2);
}

/** 详情分片 = md5(key)[:2]（docs/14 §2） */
export function shardOf(key: string): string {
  return md5hex(key).slice(0, 2);
}

/* ---------- 原始响应形状 ---------- */

interface XcpcRawHistory {
  contestId?: unknown;
  title?: unknown;
  startAt?: unknown;
  teamName?: unknown;
  tier?: unknown;
  solved?: unknown;
  official?: unknown;
  dirt?: unknown;
  firstATime?: unknown;
  lastHourSolved?: unknown;
  rankOfficial?: unknown;
  teamCountOfficial?: unknown;
  rankPercentOfficial?: unknown;
  perfOfficial?: unknown;
  ratingAfterOfficial?: unknown;
}

interface XcpcRawDetail {
  key?: unknown;
  name?: unknown;
  org?: unknown;
  contests?: unknown;
  officialRating?: unknown;
  officialRank?: unknown;
  history?: unknown;
  medals?: unknown;
}

interface SearchEntry extends XcpcSearchRow {
  hay: string;
}

/** 紧凑行 `[key,name,org,contests]` → 带 hay 的候选；畸形行丢掉 */
function toEntry(raw: unknown): SearchEntry | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [key, name, org, contests] = raw as unknown[];
  if (typeof key !== 'string' || key === '' || typeof name !== 'string' || typeof org !== 'string') return null;
  const n = Number(contests);
  return { key, name, org, contests: Number.isFinite(n) ? n : 0, hay: hayOf(name, org) };
}

/** 检索面只有姓名与校名两段（拼音不做，见 docs/14 §2.2 修订） */
function hayOf(name: string, org: string): string {
  return `${name}${HAY_SEP}${org}`.toLowerCase();
}

function num(input: unknown): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

function str(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

/* ---------- DTO 映射：官方单口径，服务端做完这一层（docs/14 §4） ---------- */

/** 上游只有四档 tier，实测存在缺失行；没见过的值不硬套一档，交回 null → 界面「—」 */
function tierOf(input: unknown): XcpcTier | null {
  const v = str(input);
  return (XCPC_TIERS as readonly string[]).includes(v) ? (v as XcpcTier) : null;
}

/**
 * 网络赛标签。`preliminary` 在 contestId 里是"预赛 / 初赛"的通用词 —— 单看它会把
 * 「广东省赛邀请赛预赛」「安徽初赛」也标成网络赛，所以必须再让标题表态（网络 / Online）。
 */
function isOnline(contestId: string, title: string): boolean {
  return contestId.includes('preliminary') && (/网络/.test(title) || /\bonline\b/i.test(title));
}

function toHistoryRow(raw: XcpcRawHistory): XcpcHistoryRow {
  const star = raw.official === false;
  const contestId = str(raw.contestId);
  const title = str(raw.title);
  // 打星行上游的官方套装本来就是 null，这里再压一次：口径只有一条，别让半套脏数据进界面
  const official = (value: unknown): number | null => (star ? null : numOrNull(value));
  return {
    contestId,
    title,
    startAt: str(raw.startAt),
    teamName: str(raw.teamName),
    tier: tierOf(raw.tier),
    online: isOnline(contestId, title),
    // solved 不是官方榜单字段，打星行照给真实值（docs/14 §2.3）
    solved: num(raw.solved),
    star,
    rank: official(raw.rankOfficial),
    teams: official(raw.teamCountOfficial),
    rankPercent: official(raw.rankPercentOfficial),
    perf: official(raw.perfOfficial),
    ratingAfter: official(raw.ratingAfterOfficial),
    dirt: numOrNull(raw.dirt),
    firstATime: numOrNull(raw.firstATime),
    lastHourSolved: numOrNull(raw.lastHourSolved),
  };
}

/** `{[tier]: {gold,silver,bronze}}`；上游会省略零奖牌 tier 与整个字段，缺什么就不写什么 */
function toMedals(raw: unknown): XcpcMedals {
  const out: XcpcMedals = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const buckets = raw as Record<string, unknown>;
  for (const tier of XCPC_TIERS) {
    const bucket = buckets[tier];
    if (typeof bucket !== 'object' || bucket === null) continue;
    const counts: Partial<Record<XcpcMetal, number>> = {};
    for (const metal of XCPC_METALS) {
      const n = (bucket as Record<string, unknown>)[metal];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) counts[metal] = Math.floor(n);
    }
    if (Object.keys(counts).length > 0) out[tier] = counts;
  }
  return out;
}

export function toPlayerDto(raw: unknown): XcpcPlayerDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const detail = raw as XcpcRawDetail;
  const history = Array.isArray(detail.history) ? (detail.history as XcpcRawHistory[]).map(toHistoryRow) : [];
  return {
    key: str(detail.key),
    name: str(detail.name),
    org: str(detail.org),
    contests: num(detail.contests),
    officialRating: num(detail.officialRating),
    officialRank: num(detail.officialRank),
    medals: toMedals(detail.medals),
    history,
  };
}

/** 落库读回：payload 是原样 JSON 文本 */
function toProfile(stored: XcpcStoredPlayer): XcpcProfileDto | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stored.payload);
  } catch {
    return null;
  }
  const player = toPlayerDto(raw);
  if (player === null) return null;
  return { player, snapshotAt: stored.snapshotAt, fetchedAt: stored.fetchedAt, rankTotal: stored.rankTotal };
}

/* ---------- 客户端 ---------- */

export interface XcpcClientOptions {
  fetchImpl?: typeof fetch;
}

export class XcpcClient {
  private readonly fetchImpl: typeof fetch;
  /** Promise 级去重：同一桶 / 同一分片并发也只发一次（docs/14 §2.2） */
  private readonly buckets = new Map<string, Promise<SearchEntry[]>>();
  private readonly shards = new Map<string, Promise<Record<string, unknown>>>();

  constructor(options: XcpcClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 快照版本变了就把缓存丢掉，下一轮重新拉 */
  clearCache(): void {
    this.buckets.clear();
    this.shards.clear();
  }

  /** 429/5xx 与网络异常重试 1 次；404 原样返回，由调用方判空桶 */
  private async send(path: string, timeoutMs: number): Promise<{ status: number; text: string }> {
    const url = `${XCPC_BASE}${path}`;
    for (let attempt = 0; ; attempt++) {
      let transient = '';
      try {
        const res = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': USER_AGENT },
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) transient = `HTTP ${res.status}`;
        else return { status: res.status, text };
      } catch (err) {
        transient = reasonOf(err);
      }
      if (attempt >= MAX_RETRIES) {
        // 只报原因，不报主机名 —— 界面要把这句直接当第二行显示（docs/14 §5.5）
        throw new XcpcError('unavailable', `${transient} · 已重试 ${MAX_RETRIES} 次`);
      }
    }
  }

  private async jsonAt(path: string, timeoutMs: number): Promise<unknown> {
    const res = await this.send(path, timeoutMs);
    if (res.status === 404) throw new XcpcError('not-found', '快照里没有这个文件');
    return readJson(res.text, path);
  }

  /** `{generatedAt, counts:{…}}`；版本 = generatedAt 原串 */
  async meta(): Promise<{ generatedAt: string }> {
    const raw = (await this.jsonAt('meta.json', SEARCH_TIMEOUT_MS)) as { generatedAt?: unknown };
    const generatedAt = str(raw?.generatedAt);
    if (generatedAt === '') throw new XcpcError('unavailable', '快照的 meta.json 没有 generatedAt');
    return { generatedAt };
  }

  /**
   * 官方榜分母。响应里没 total、或这个文件干脆 404 → null（界面显示 —，不瞎编）；
   * 只有网络 / 5xx 才算失败 —— docs/14 §2 与 §4 在这一点上取「分母可以缺」这一头。
   */
  async officialTotal(): Promise<number | null> {
    try {
      const raw = (await this.jsonAt('leaderboards/official/meta.json', SEARCH_TIMEOUT_MS)) as { total?: unknown };
      return numOrNull(raw?.total);
    } catch (err) {
      if (err instanceof XcpcError && err.kind === 'not-found') return null;
      throw err;
    }
  }

  /** 搜索桶：404 = 空桶按 [] 处理 */
  private bucket(hex: string): Promise<SearchEntry[]> {
    const hit = this.buckets.get(hex);
    if (hit) return hit;
    const pending = this.send(`search/players/${hex}.json`, SEARCH_TIMEOUT_MS).then((res) => {
      if (res.status === 404) return [];
      const rows = readJson(res.text, `search/players/${hex}.json`);
      return Array.isArray(rows) ? rows.map(toEntry).filter((r): r is SearchEntry => r !== null) : [];
    });
    // 拉失败的桶别把 rejected Promise 留在缓存里，否则整个进程都读不到它
    pending.catch(() => this.buckets.delete(hex));
    this.buckets.set(hex, pending);
    return pending;
  }

  /** 详情分片：`{key: PlayerDetail}` map，实测一片 ~290 人 / 1.8MB */
  private shard(hex: string): Promise<Record<string, unknown>> {
    const hit = this.shards.get(hex);
    if (hit) return hit;
    const pending = this.jsonAt(`players/${hex}.json`, DETAIL_TIMEOUT_MS).then((rows) =>
      typeof rows === 'object' && rows !== null ? (rows as Record<string, unknown>) : {},
    );
    pending.catch(() => this.shards.delete(hex));
    this.shards.set(hex, pending);
    return pending;
  }

  /** 分片里查无此 key → not-found（路由给 404） */
  async playerDetail(key: string): Promise<unknown> {
    const shard = await this.shard(shardOf(key));
    const detail = shard[key];
    if (detail === undefined) throw new XcpcError('not-found', '快照里没有这个档案');
    return detail;
  }

  /**
   * 一段式（docs/14 §2.2 修订版）：查询首字符进桶，桶内对「姓名 + 校名」做子串匹配。
   * 固有边界：必须从姓名或校名的**第一个字**起头 —— 搜「邮电」找不到北京邮电大学。
   * 不做全扫兜底：拼音检索已整体取消。
   */
  async search(query: string): Promise<XcpcSearchRow[]> {
    const qn = query.trim().toLowerCase();
    if (qn === '') return [];
    const rows = (await this.bucket(bucketOf(qn))).filter((e) => e.hay.includes(qn));
    return rows.slice(0, MAX_RESULTS).map(stripHay);
  }
}

const stripHay = ({ key, name, org, contests }: SearchEntry): XcpcSearchRow => ({ key, name, org, contests });

/* ---------- 状态 ---------- */

/** 快照距今多少天：拿 generatedAt 那个真实时刻算（docs/14 §4 的「数据版本」口径） */
export function snapshotAgeDays(generatedAt: string | null, now = Date.now()): number | null {
  if (generatedAt === null) return null;
  const ts = Date.parse(generatedAt);
  return Number.isFinite(ts) ? (now - ts) / 86_400_000 : null;
}

export interface XcpcStore {
  db: DatabaseSync;
  /** vault/config.json 的 xcpcPlayerKey；'' = 未认领 */
  getKey: () => string;
  setKey: (key: string) => void;
}

function readState(db: DatabaseSync, name: string): string | null {
  const raw = getSyncState(db, syncKey('xcpc', name));
  return raw === null || raw === '' ? null : raw;
}

export function xcpcStatus(store: XcpcStore, now = Date.now()): XcpcStatusDto {
  const key = store.getKey();
  const stored = key === '' ? null : loadXcpcPlayer(store.db);
  const error = readState(store.db, 'last_error');
  const fetched = readState(store.db, 'last_sync_at');
  if (stored === null) {
    return { claimed: false, key: null, officialRating: null, snapshotAt: null, fetchedAt: null, status: 'idle', error: null };
  }
  const profile = toProfile(stored);
  const snapshotAt = stored.snapshotAt;
  const age = snapshotAgeDays(snapshotAt, now);

  let status: SourceState = 'ok';
  if (error !== null) status = 'down';
  else if (age !== null && age > XCPC_STALE_AFTER_DAYS) status = 'stale';

  return {
    claimed: true,
    key: stored.key,
    officialRating: profile?.player.officialRating ?? null,
    snapshotAt,
    fetchedAt: fetched === null ? stored.fetchedAt : Number(fetched),
    status,
    error,
  };
}

export function xcpcProfile(store: XcpcStore): XcpcProfileDto | null {
  if (store.getKey() === '') return null;
  const stored = loadXcpcPlayer(store.db);
  return stored === null ? null : toProfile(stored);
}

/* ---------- 认领 / 刷新：进程内串行（docs/14 §4 互斥） ---------- */

let running = false;

function stamp(now = Date.now()): number {
  return Math.floor(now / 1000);
}

/**
 * 认领 = 拉详情分片 + meta.json + 官方榜 meta，三个都成功才落库；
 * 任一失败 → 现状不动（连 last_error 都不写，"没成功认领"不该把已有档案的点打红）。
 * 换人 = 再认领一次，旧档案整域清掉。
 */
export async function claimXcpc(store: XcpcStore, client: XcpcClient, key: string): Promise<XcpcProfileDto> {
  if (running) throw new XcpcError('busy', 'XCPC 正在拉快照，等它跑完');
  running = true;
  try {
    const [detail, meta, rankTotal] = await Promise.all([
      client.playerDetail(key),
      client.meta(),
      client.officialTotal(),
    ]);
    const player = toPlayerDto(detail);
    if (player === null) throw new XcpcError('unavailable', '这个档案读不出结构');
    const now = stamp();
    replaceXcpcPlayer(store.db, {
      key,
      payload: JSON.stringify(detail),
      snapshotAt: meta.generatedAt,
      rankTotal,
      fetchedAt: now,
    });
    setSyncState(store.db, syncKey('xcpc', 'last_sync_at'), String(now));
    setSyncState(store.db, syncKey('xcpc', 'last_error'), '');
    store.setKey(key);
    return { player, snapshotAt: meta.generatedAt, fetchedAt: now, rankTotal };
  } finally {
    running = false;
  }
}

/**
 * 拉快照：先比版本，没变就只记一次「上次同步」；变了才重拉分片与分母。
 * 新版里找不到这个 key → 保留旧数据 + last_error（状态转 down），不清库。
 */
export async function refreshXcpc(store: XcpcStore, client: XcpcClient): Promise<XcpcRefreshDto> {
  if (running) throw new XcpcError('busy', 'XCPC 正在拉快照，等它跑完');
  running = true;
  const db = store.db;
  try {
    const stored = loadXcpcPlayer(db);
    const current = stored === null ? null : toProfile(stored);
    // 认领标记还在、行却读不出来（手工动过 vault）：按没认领过对待，别拿半截数据刷新
    if (stored === null || current === null) throw new XcpcError('not-found', '还没有认领 XCPC 档案');
    let meta: { generatedAt: string };
    try {
      meta = await client.meta();
    } catch (err) {
      setSyncState(db, syncKey('xcpc', 'last_error'), errorText(err));
      throw err;
    }

    const now = stamp();
    if (meta.generatedAt === stored.snapshotAt) {
      setSyncState(db, syncKey('xcpc', 'last_sync_at'), String(now));
      return { ...current, updated: false, status: xcpcStatus(store, now * 1000).status };
    }

    let detail: unknown;
    let rankTotal: number | null;
    try {
      [detail, rankTotal] = await Promise.all([client.playerDetail(stored.key), client.officialTotal()]);
    } catch (err) {
      // 新版快照里查无此 key：旧数据留着，把原因挂上去
      if (err instanceof XcpcError && err.kind === 'not-found') {
        setSyncState(db, syncKey('xcpc', 'last_error'), MISSING_IN_SNAPSHOT);
        return { ...current, updated: false, status: 'down' };
      }
      setSyncState(db, syncKey('xcpc', 'last_error'), errorText(err));
      throw err;
    }

    const player = toPlayerDto(detail);
    if (player === null) {
      setSyncState(db, syncKey('xcpc', 'last_error'), MISSING_IN_SNAPSHOT);
      return { ...current, updated: false, status: 'down' };
    }

    client.clearCache();
    replaceXcpcPlayer(db, {
      key: stored.key,
      payload: JSON.stringify(detail),
      snapshotAt: meta.generatedAt,
      rankTotal,
      fetchedAt: now,
    });
    setSyncState(db, syncKey('xcpc', 'last_sync_at'), String(now));
    setSyncState(db, syncKey('xcpc', 'last_error'), '');
    return {
      player,
      snapshotAt: meta.generatedAt,
      fetchedAt: now,
      rankTotal,
      updated: true,
      status: xcpcStatus(store, now * 1000).status,
    };
  } finally {
    running = false;
  }
}

function errorText(err: unknown): string {
  return err instanceof XcpcError ? err.message : `快照拉取失败：${reasonOf(err)}`;
}
