import { describe, expect, it } from 'vitest';
import type { SourceId } from '@anvil/shared';
import { decideSwitch, type SwitchState } from '../src/switcher.ts';

const st = (shown: SourceId, flying: boolean): SwitchState => ({ shown, flying });

describe('切屏决策（2026-10-05 口径：编排期间一律忽略后续点击）', () => {
  it('编排在播 → 一律忽略，点谁都不动', () => {
    // CF→AT 飞行中：点 AT（在途目标）、点 CF（回原处）、点 XCPC（去第三个源）都不生效
    for (const next of ['cf', 'at', 'xcpc'] as SourceId[]) {
      expect(decideSwitch(st('cf', true), next), `CF 屏在飞时点 ${next}`).toEqual({ kind: 'ignore' });
    }
    for (const next of ['cf', 'at', 'xcpc'] as SourceId[]) {
      expect(decideSwitch(st('at', true), next), `AT 屏在飞时点 ${next}`).toEqual({ kind: 'ignore' });
    }
  });

  it('回归：飞行中点回原处必须被忽略，否则会产生"卡直接出现然后才飞"', () => {
    // AT → 点 CF → 1.4s 内点 AT：忽略，落地仍是 CF，AT 的卡照常飞完
    expect(decideSwitch(st('at', true), 'at')).toEqual({ kind: 'ignore' });
    // 反过来同样
    expect(decideSwitch(st('cf', true), 'cf')).toEqual({ kind: 'ignore' });
  });

  it('已经在这个源上且无编排 → plain（不重播动效）', () => {
    expect(decideSwitch(st('cf', false), 'cf')).toEqual({ kind: 'plain' });
    expect(decideSwitch(st('at', false), 'at')).toEqual({ kind: 'plain' });
    expect(decideSwitch(st('xcpc', false), 'xcpc')).toEqual({ kind: 'plain' });
  });

  it('无编排切到别的源 → fly，from 是当前挂屏的源', () => {
    expect(decideSwitch(st('cf', false), 'at')).toEqual({ kind: 'fly', from: 'cf' });
    expect(decideSwitch(st('at', false), 'cf')).toEqual({ kind: 'fly', from: 'at' });
    expect(decideSwitch(st('cf', false), 'xcpc')).toEqual({ kind: 'fly', from: 'cf' });
    expect(decideSwitch(st('at', false), 'xcpc')).toEqual({ kind: 'fly', from: 'at' });
  });

  it('忽略只限在飞期间：编排走完后能正常响应下一次切换', () => {
    // CF→AT 跑完：shown=at、无编排 → 点 CF 是一次正常飞出
    expect(decideSwitch(st('at', false), 'cf')).toEqual({ kind: 'fly', from: 'at' });
  });
});
