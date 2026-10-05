import { describe, expect, it } from 'vitest';
import { FLY, legTimes } from '../src/fly.ts';

const endsOf = (n: number, leg: 'out' | 'in') => legTimes(n, leg).map((t) => t.start + t.duration);

describe('切换编排的时序不变量（docs/09 §7：任意两张卡不同时起步、也不同时完成）', () => {
  it('第 i 张 = start i×STEP、duration DUR + i×DSTEP', () => {
    expect(legTimes(6, 'out').map((t) => t.start)).toEqual([0, 41, 82, 123, 164, 205]);
    expect(legTimes(6, 'out').map((t) => t.duration)).toEqual([360, 369, 378, 387, 396, 405]);
    expect(legTimes(6, 'in').map((t) => t.start)).toEqual([0, 30, 60, 90, 120, 150]);
  });

  it('起步与完成两两不同，且都严格递增（2 到 12 张都成立）', () => {
    for (const n of [2, 3, 6, 7, 12]) {
      for (const leg of ['out', 'in'] as const) {
        const t = legTimes(n, leg);
        const starts = t.map((x) => x.start);
        const ends = t.map((x) => x.start + x.duration);
        expect(new Set(starts).size, `${leg}/${n} 起步`).toBe(n);
        expect(new Set(ends).size, `${leg}/${n} 完成`).toBe(n);
        expect(starts, leg).toEqual([...starts].sort((a, b) => a - b));
        expect(ends, leg).toEqual([...ends].sort((a, b) => a - b));
      }
    }
  });

  it('总时长：6 卡 1390ms、AT 屏 7 卡 1484ms（含 40ms 空档）', () => {
    const total = (n: number) => {
      const out = Math.max(...legTimes(n, 'out').map((t) => t.start + t.duration));
      const inTotal = Math.max(...legTimes(n, 'in').map((t) => t.start + t.duration));
      return out + FLY.handoff + inTotal;
    };
    // 契约 §7 定档是 step 51/40 + handoff 80 → 1530 / 1644；用户 2026-10-05 微调成
    // step 41/30 + handoff 40 → 1390 / 1484
    expect(total(6)).toBe(1390);
    expect(total(7)).toBe(1484);
  });

  it('跨段不撞：飞入段整体晚于飞出段一个 handoff', () => {
    for (const n of [6, 7]) {
      const outEnd = Math.max(...endsOf(n, 'out'));
      const inStarts = legTimes(n, 'in').map((t) => outEnd + FLY.handoff + t.start);
      expect(Math.min(...inStarts)).toBeGreaterThan(outEnd);
    }
  });

  it('不变量靠 STEP 与 DSTEP 同为正撑着：两个都为 0 就退化成整屏一起动', () => {
    expect(FLY.out.step).toBeGreaterThan(0);
    expect(FLY.out.durStep).toBeGreaterThan(0);
    expect(FLY.in.step).toBeGreaterThan(0);
    expect(FLY.in.durStep).toBeGreaterThan(0);
  });

  it('方向与缓动按定稿档：出「对称」、入「柔和」', () => {
    expect(FLY.out.ease).toBe('cubic-bezier(.65,0,.35,1)');
    expect(FLY.in.ease).toBe('cubic-bezier(.4,0,.2,1)');
    expect(FLY.rise).toBe(72);
    expect(FLY.scale).toBe(4);
    expect(FLY.dead).toBe(0.03);
  });
});
