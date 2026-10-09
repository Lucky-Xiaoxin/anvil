/**
 * 回会话持久化（docs/16 §3）：每场一条 `arena:session:<官方路径>`，侧栏收起态 `arena:rail`。
 *
 * 只碰这两个键；读写一律包 try —— localStorage 在某些隐私模式下会直接抛，
 * 会话读不出来就当没有（开新钟），不该让整屏打不开。
 */
import type { Session } from './engine.ts';

export const sessionKey = (path: string): string => `arena:session:${path}`;
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
