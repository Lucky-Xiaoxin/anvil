import { describe, expect, it } from 'vitest';
import { createLatestGate } from '../src/components/work/latest.ts';

describe('LatestGate', () => {
  it('只有最后一次 begin 有效；invalidate 后连最后一次也失效', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });

  it('选择变化使待应用的自动选择失效，下一次加载仍可申请新选择', () => {
    const gate = createLatestGate();
    const beforeSelection = gate.begin();
    gate.invalidate();
    gate.invalidate();
    expect(gate.isCurrent(beforeSelection)).toBe(false);
    const nextLoad = gate.begin();
    expect(gate.isCurrent(beforeSelection)).toBe(false);
    expect(gate.isCurrent(nextLoad)).toBe(true);
  });
});
