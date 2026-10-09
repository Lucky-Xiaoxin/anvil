import { clockOf, dayKeyOf } from '@anvil/shared';

export function prefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 接口层与网络层抛上来的东西统一成一句能给人看的话 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 千分位只在 ≥10 000 时用；rating 不加 */
export function fmtInt(n: number): string {
  return n >= 10000 ? n.toLocaleString('zh-CN') : String(n);
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch 秒 → 「2026-10-04 08:12」，钉死 Asia/Shanghai */
export function fullStamp(epochSeconds: number): string {
  const { hour, minute } = clockOf(new Date(epochSeconds * 1000));
  return `${dayKeyOf(epochSeconds)} ${p2(hour)}:${p2(minute)}`;
}

/** epoch 秒 → 「10-04 20:15」：同年不写年份，降级条这类短读数用 */
export function shortStamp(epochSeconds: number, now = Date.now()): string {
  const stamp = fullStamp(epochSeconds);
  const sameYear = stamp.slice(0, 4) === fullStamp(Math.floor(now / 1000)).slice(0, 4);
  return sameYear ? stamp.slice(5) : stamp;
}

export function relativeTime(epochSeconds: number | null, now = Date.now()): string {
  if (epochSeconds === null) return '从未同步';
  const diff = Math.max(0, now - epochSeconds * 1000);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return dayKeyOf(epochSeconds);
}

/* ---------- 比赛时钟读数（模拟榜单）：相对开赛的毫秒，不是墙上时钟 ---------- */

/** 毫秒 → `4:12:07`（小时不补零，与视觉基线一致） */
export function clockHMS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

/** 毫秒 → `4:00`：封榜时刻这类「到分钟」的读数 */
export function clockHM(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}`;
}
