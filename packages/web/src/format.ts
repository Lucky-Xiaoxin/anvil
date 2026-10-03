export function prefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 千分位只在 ≥10 000 时用；rating 不加 */
export function fmtInt(n: number): string {
  return n >= 10000 ? n.toLocaleString('zh-CN') : String(n);
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
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
