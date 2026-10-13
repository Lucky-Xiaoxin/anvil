/**
 * 回会话持久化（docs/16 §3）：每场一条 `arena:session:<官方路径>`，侧栏收起态 `arena:rail`，
 * 目录收放 `arena:tree` 与停留位置 `arena:tree-scroll`；「我的成绩」幽灵行每场一条
 * `arena:ghost:<官方路径>`（docs/20 §2.1）。
 *
 * 只碰这几个键；读写一律包 try —— localStorage 在某些隐私模式下会直接抛，
 * 会话读不出来就当没有（开新钟），不该让整屏打不开。
 */
import type { GhostMark, Session } from './engine.ts';

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

const PREFIX = 'arena:session:';

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

/* ---------- 「我的成绩」幽灵行（docs/20 §2.1）：每场一条，与回放会话 / vault 缓存互不相干 ---------- */

export interface GhostData {
  /** 面板里的「展示我」：关 = 行隐藏但数据留着 */
  show: boolean;
  /** 每题一条（`ac` 缺省 = 未过；单位 = 比赛分钟），按 `p` 升序存 */
  marks: GhostMark[];
}

const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * 单条录入的 sanitize：读不懂就整条丢（宁可少一行，也不按猜出来的成绩占名次）。
 * `p` 必须是 ≥0 整数；`ac` 给了就得是正有限数；`fails` 给了就得是 ≥1 的整数。
 */
const markOf = (v: unknown): GhostMark | null => {
  if (v === null || typeof v !== 'object') return null;
  const o = v as { p?: unknown; ac?: unknown; fails?: unknown };
  const p = intOf(o.p);
  if (p === null || p < 0) return null;
  const m: GhostMark = { p };
  if (o.ac !== undefined && o.ac !== null) {
    if (typeof o.ac !== 'number' || !Number.isFinite(o.ac) || o.ac <= 0) return null;
    m.ac = o.ac;
  }
  if (o.fails !== undefined && o.fails !== null) {
    const f = intOf(o.fails);
    if (f === null || f < 1) return null;
    m.fails = f;
  }
  return m;
};

export function loadGhost(store: Store, path: string): GhostData | null {
  try {
    const raw = store.getItem(ghostKey(path));
    if (raw === null || raw === '') return null;
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as { show?: unknown; marks?: unknown };
    if (!Array.isArray(o.marks)) return null;
    const marks: GhostMark[] = [];
    for (const x of o.marks) {
      const m = markOf(x);
      if (m !== null) marks.push(m);
    }
    return { show: o.show !== false, marks: marks.sort((a, b) => a.p - b.p) };
  } catch {
    return null;
  }
}

/** 写入前按 `p` 升序排：minuteKey 要序列化这份 marks，顺序稳定才不会白重建榜 */
export function saveGhost(store: Store, path: string, data: GhostData): void {
  try {
    const marks = [...data.marks].sort((a, b) => a.p - b.p);
    store.setItem(ghostKey(path), JSON.stringify({ show: data.show, marks }));
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
