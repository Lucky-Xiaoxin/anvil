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
});
