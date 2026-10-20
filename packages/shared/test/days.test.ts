import { afterEach, describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  civilDay,
  dayKeyOf,
  dayOf,
  formatDay,
  formatMonth,
  gridStartDate,
  mondayOf,
  parseDayKey,
  TZ_OFFSET_SECONDS,
  WEEKS,
} from '@anvil/shared';

const ORIGINAL_TZ = process.env.TZ;
/** 跨国际换日线 + 半区偏移 + 本机时区：日界一挪就能抓出「偷偷用本地 getter」的实现 */
const ZONES = ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata', 'Pacific/Chatham'];

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe('时区口径钉死 Asia/Shanghai（docs/contracts/09 §6）', () => {
  it('UTC+8 整点：偏移量就是 8 小时', () => {
    expect(TZ_OFFSET_SECONDS).toBe(8 * 3600);
  });

  it('epoch → 日：与运行环境 TZ 无关', () => {
    // 2026-10-03T23:30Z：上海已经是 10-04 早上，纽约还在 10-03 晚上
    const boundary = Date.UTC(2026, 9, 3, 23, 30) / 1000;
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(dayKeyOf(boundary), tz).toBe('2026-10-04');
    }
  });

  it('日界两侧各归各天：上海 23:59 → 当天，00:00 → 次日', () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(dayKeyOf(Date.UTC(2026, 9, 3, 15, 59) / 1000)).toBe('2026-10-03');
      expect(dayKeyOf(Date.UTC(2026, 9, 3, 16, 0) / 1000)).toBe('2026-10-04');
    }
  });

  it('月份分桶同样钉死', () => {
    process.env.TZ = 'America/New_York';
    // 纽约的 2026-09-30 晚 = 上海的 10-01 凌晨
    expect(formatMonth(dayOf(Date.UTC(2026, 8, 30, 17) / 1000))).toBe('2026-10');
    expect(dayKeyOf(Date.UTC(2026, 8, 30, 17) / 1000)).toBe('2026-10-01');
  });

  it('civilDay 把真实时刻折成上海日历日', () => {
    process.env.TZ = 'Pacific/Kiritimati';
    const now = new Date(Date.UTC(2026, 9, 3, 20, 0));
    expect(formatDay(civilDay(now))).toBe('2026-10-04');
    expect(formatDay(now)).not.toBe('2026-10-04');
  });
});

describe('日历日算术', () => {
  it('周对齐：周一是首列', () => {
    process.env.TZ = 'UTC';
    // 2026-10-03 是周六 → 本周周一 2026-09-28
    expect(formatDay(mondayOf(parseDayKey('2026-10-03')))).toBe('2026-09-28');
    expect(formatDay(mondayOf(parseDayKey('2026-09-28')))).toBe('2026-09-28');
    expect(formatDay(gridStartDate(parseDayKey('2026-10-03'), WEEKS))).toBe('2025-09-29');
  });

  it('addDays 跨月跨年不漂', () => {
    expect(formatDay(addDays(parseDayKey('2026-12-31'), 1))).toBe('2027-01-01');
    expect(formatDay(addDays(parseDayKey('2026-03-01'), -1))).toBe('2026-02-28');
    expect(formatDay(addDays(parseDayKey('2026-01-01'), 365))).toBe('2027-01-01');
  });

  it('addMonths 落在月初，跨年进位正确', () => {
    expect(formatMonth(addMonths(parseDayKey('2026-12-15'), 1))).toBe('2027-01');
    expect(formatMonth(addMonths(parseDayKey('2026-01-15'), -1))).toBe('2025-12');
    expect(formatDay(addMonths(parseDayKey('2026-05-31'), 0))).toBe('2026-05-01');
  });

  it('parseDayKey 与 formatDay 互逆', () => {
    for (const key of ['2025-09-29', '2026-02-28', '2026-10-03']) {
      expect(formatDay(parseDayKey(key))).toBe(key);
    }
  });
});
