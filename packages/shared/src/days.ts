/** 本地自然日与周对齐：全项目只用本机本地时区（Asia/Shanghai）。 */

export const WEEKS = 53;
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDay(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function formatMonth(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

/** epoch 秒 → 本地日 "YYYY-MM-DD" */
export function localDayKey(epochSeconds: number): string {
  return formatDay(new Date(epochSeconds * 1000));
}

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/** 周一 = 0 … 周日 = 6 */
export function dowMon(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dowMon(d));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** 本地日 "YYYY-MM-DD" → 本地日历月 "YYYY-MM" */
export function monthOfDay(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** 格子图窗口：所在周周一往前推 weeks-1 周 */
export function gridStartDate(today: Date, weeks = WEEKS): Date {
  return addDays(mondayOf(today), -(weeks - 1) * 7);
}
