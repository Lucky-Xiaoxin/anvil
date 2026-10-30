/**
 * 回会话持久化（docs/contracts/16 §3）：每场一条 `arena:session:<官方路径>`，侧栏收起态 `arena:rail`，
 * 目录收放 `arena:tree` 与停留位置 `arena:tree-scroll`；「我的成绩」幽灵行每场一条
 * `arena:ghost:<官方路径>`（docs/contracts/20 §2.1）。
 *
 * 只碰这几个键；读写一律包 try —— localStorage 在某些隐私模式下会直接抛，
 * 会话读不出来就当没有（开新钟），不该让整屏打不开。
 */
import { GHOST_RESULTS, type GhostResult, type GhostSub, type Session } from './engine.ts';

export const sessionKey = (path: string): string => `arena:session:${path}`;
export const ghostKey = (path: string): string => `arena:ghost:${path}`;
export const RAIL_KEY = 'arena:rail';

/** 界面只需要一个能读写字符串的存储；测试注入桩件，不必造整个 DOM */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** 只有「列出进行中场次」用得到；桩件可以不提供 */
  key?(index: number): string | null;
  readonly length?: number;
}

/** 浏览器 localStorage 的安全包装：隐私模式下访问本身就可能抛 */
export function browserStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const PREFIX = 'arena:session:';
const GHOST_PREFIX = 'arena:ghost:';

/**
 * 目录要给进行中的场次挂「回放中 · 时刻」，所以得知道有哪些会话活着。
 * 存储不支持枚举（桩件 / 老浏览器）就回空 —— 少标一行不致命，别为此造第二个索引键。
 */
export function listSessionPaths(store: Store): string[] {
  if (typeof store.key !== 'function' || typeof store.length !== 'number') return [];
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
  }
  return out;
}

/** 目录行要标「有我的成绩 / 可保存」：同一套枚举，不另造索引 */
export function listGhostPaths(store: Store): string[] {
  if (typeof store.key !== 'function' || typeof store.length !== 'number') return [];
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null && k.startsWith(GHOST_PREFIX)) out.push(k.slice(GHOST_PREFIX.length));
  }
  return out;
}

export function loadSession(store: Store, path: string): Session | null {
  try {
    const raw = store.getItem(sessionKey(path));
    if (raw === null || raw === '') return null;
    const v = JSON.parse(raw) as Partial<Session>;
    if (typeof v.started !== 'number' || !Number.isFinite(v.started)) return null;
    return {
      started: v.started,
      hold: v.hold === true,
      paused: v.paused === true,
      ended: v.ended === true,
      scrubMs: typeof v.scrubMs === 'number' && Number.isFinite(v.scrubMs) ? v.scrubMs : 0,
      at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
      durationMs: typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) ? v.durationMs : 0,
    };
  } catch {
    return null;
  }
}

export function saveSession(store: Store, path: string, s: Session): void {
  try {
    store.setItem(sessionKey(path), JSON.stringify(s));
  } catch {
    /* 存不下就丢掉持久化，钟照走 */
  }
}

/** 「结束」清记录：回到目录时这一行不再是「回放中」 */
export function clearSession(store: Store, path: string): void {
  try {
    store.removeItem(sessionKey(path));
  } catch {
    /* 同上 */
  }
}

export function loadRail(store: Store): boolean {
  try {
    return store.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveRail(store: Store, on: boolean): void {
  try {
    store.setItem(RAIL_KEY, on ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}

/* ---------- 目录收放与停留位置（2026-10-10 用户验收 r3） ---------- */

export const TREE_KEY = 'arena:tree';
export const SCROLL_KEY = 'arena:tree-scroll';

/** 存的是「展开中的组键」集合：默认空 = 全收起（394 行全摊开等于没有目录） */
export function loadOpenGroups(store: Store): Set<string> {
  try {
    const raw = store.getItem(TREE_KEY);
    if (raw === null || raw === '') return new Set();
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return new Set();
    return new Set(v.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function saveOpenGroups(store: Store, keys: Set<string>): void {
  try {
    store.setItem(TREE_KEY, JSON.stringify([...keys]));
  } catch {
    /* 存不下就丢持久化，收放照改 */
  }
}

/** 滚动位置只在目录就绪后恢复；读不出来（首访 / 坏值）当 0 */
export function loadScrollTop(store: Store): number {
  try {
    const n = Number(store.getItem(SCROLL_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveScrollTop(store: Store, top: number): void {
  try {
    store.setItem(SCROLL_KEY, String(Math.round(top)));
  } catch {
    /* 忽略 */
  }
}

/* ---------- 「我的成绩」幽灵行（docs/contracts/20 §2.1 · v8 逐发）：每场一条，与回放会话 / vault 缓存互不相干 ---------- */

export interface GhostData {
  /** 面板里的「展示我」：关 = 行隐藏但数据留着（顶栏读数跟着消失） */
  show: boolean;
  /** 逐发提交（`t` = 比赛分钟），按 `p` 再按 `t` 升序存 */
  subs: GhostSub[];
}

export const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * 单发录入的 sanitize：读不懂就整条丢（宁可少一发，也不按猜出来的判名占名次）。
 * 判名只收面板给的那五档 —— `FB` 进不来，幽灵永不首杀。
 */
const subOf = (v: unknown): GhostSub | null => {
  if (v === null || typeof v !== 'object') return null;
  const o = v as { p?: unknown; t?: unknown; r?: unknown };
  const p = intOf(o.p);
  const t = intOf(o.t);
  const r = typeof o.r === 'string' && (GHOST_RESULTS as readonly string[]).includes(o.r) ? (o.r as GhostResult) : null;
  if (p === null || p < 0 || t === null || t < 0 || r === null) return null;
  return { p, t, r };
};

/** 逐发对象清洗：旧键与草稿共用一份（v7 的 marks 形状不迁，读出来当没有） */
export function ghostDataOf(v: unknown): GhostData | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { show?: unknown; subs?: unknown };
  if (!Array.isArray(o.subs)) return null;
  const subs: GhostSub[] = [];
  for (const x of o.subs) {
    const s = subOf(x);
    if (s !== null) subs.push(s);
  }
  return { show: o.show !== false, subs: subs.sort(ghostOrder) };
}

export function loadGhost(store: Store, path: string): GhostData | null {
  try {
    const raw = store.getItem(ghostKey(path));
    if (raw === null || raw === '') return null;
    return ghostDataOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 先题后时：与榜上的列序一致，逐发清单里改错好找 */
const ghostOrder = (a: GhostSub, b: GhostSub): number => a.p - b.p || a.t - b.t;

/** 写入前排序：minuteKey 要序列化这份 subs，顺序稳定才不会白重建榜 */
export function saveGhost(store: Store, path: string, data: GhostData): void {
  try {
    const subs = [...data.subs].sort(ghostOrder);
    store.setItem(ghostKey(path), JSON.stringify({ show: data.show, subs }));
  } catch {
    /* 存不下就丢掉这一场的成绩，榜照看 */
  }
}

/** 「清除本场成绩」= 删键：下次进来面板留空，入口照旧在 */
export function clearGhost(store: Store, path: string): void {
  try {
    store.removeItem(ghostKey(path));
  } catch {
    /* 同上 */
  }
}
