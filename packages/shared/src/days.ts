/**
 * 日历日算术：时区口径钉死 `Asia/Shanghai`（UTC+8，无夏令时）。
 * 全模块不读运行机时区 —— 一律 offset 算术 + UTC getter（docs/09 §6）。
 *
 * 约定：本模块流转的 `Date` 是「上海日历日」的载体 —— 它的 UTC 字段才是真实日历字段，
 * 毫秒值比真实 UTC 早 8 小时。只有 UTC 午夜（`dayOf` 之外的 parseDayKey/addDays 结果）
 * 才代表"某一天"，一天之内的时刻只出现在 today 这类入参上。
 */

export const WEEKS = 53;
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export const TZ_OFFSET_SECONDS = 8 * 3600;
const DAY_MS = 86_400_000;

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch 秒 → 载体 Date：它的 UTC 年月日 = 上海日历的年月日 */
export function dayOf(epochSeconds: number): Date {
  return new Date((epochSeconds + TZ_OFFSET_SECONDS) * 1000);
}

/** 真实时刻 → 上海日历日（可能带一天内的时刻，用于"今天"的比较） */
export function civilDay(now: Date): Date {
  return dayOf(Math.floor(now.getTime() / 1000));
}

export function formatDay(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export function formatMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`;
}

/** epoch 秒 → 上海日 "YYYY-MM-DD"；与运行环境 TZ 无关 */
export function dayKeyOf(epochSeconds: number): string {
  return formatDay(dayOf(epochSeconds));
}

/** "YYYY-MM-DD" → 该上海日的 UTC 午夜载体 */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
}

/** 周一 = 0 … 周日 = 6 */
export function dowMon(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

export function mondayOf(d: Date): Date {
  return addDays(d, -dowMon(d));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** 上海日 "YYYY-MM-DD" → 上海日历月 "YYYY-MM" */
export function monthOfDay(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** 格子图窗口：所在周周一往前推 weeks-1 周 */
export function gridStartDate(today: Date, weeks = WEEKS): Date {
  return addDays(mondayOf(today), -(weeks - 1) * 7);
}

/** 上海日历的「今天」在钟点上的读数，供"数据更新于 …"一类文案用 */
export function clockOf(now: Date): { hour: number; minute: number } {
  const d = dayOf(Math.floor(now.getTime() / 1000));
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}
