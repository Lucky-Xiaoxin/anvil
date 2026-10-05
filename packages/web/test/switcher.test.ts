import { describe, expect, it } from 'vitest';
import type { SourceId } from '@anvil/shared';
import { decideSwitch, type SwitchState } from '../src/switcher.ts';

const st = (shown: SourceId, want: SourceId, flying: boolean): SwitchState => ({ shown, want, flying });

describe('切屏决策（钉住闪屏回归）', () => {
  it('目标已在途 → 忽略；否则连点同一个 tab 会 cancel 掉飞出段、旧卡瞬移回原位', () => {
    // CF→AT 编排进行中，再点 AT：什么都不做，让编排走完
    expect(decideSwitch(st('cf', 'at', true), 'at')).toEqual({ kind: 'ignore' });
    // 同理 AT→CF 进行中再点 CF
    expect(decideSwitch(st('at', 'cf', true), 'cf')).toEqual({ kind: 'ignore' });
  });

  it('目标已落位且无编排 → 瞬切（不重播动效）', () => {
    expect(decideSwitch(st('cf', 'cf', false), 'cf')).toEqual({ kind: 'plain' });
    expect(decideSwitch(st('at', 'at', false), 'at')).toEqual({ kind: 'plain' });
  });

  it('无编排切到别的源 → 飞出去，from 是当前挂屏的源', () => {
    expect(decideSwitch(st('cf', 'cf', false), 'at')).toEqual({ kind: 'fly', from: 'cf' });
    expect(decideSwitch(st('at', 'at', false), 'cf')).toEqual({ kind: 'fly', from: 'at' });
  });

  it('编排进行中改道 → 先落位到在途目标，再开播新目标（不排队）', () => {
    // CF→AT 飞行中点 XCPC：先落到 AT，再从 AT 开播 XCPC
    expect(decideSwitch(st('cf', 'at', true), 'xcpc')).toEqual({ kind: 'retarget', mid: 'at' });
    // CF→AT 飞行中点回 CF：先落到 AT，再从 AT 飞回 CF
    expect(decideSwitch(st('cf', 'at', true), 'cf')).toEqual({ kind: 'retarget', mid: 'at' });
  });

  it('改道后落在 mid，下一步就是从这个 mid 飞出去', () => {
    const mid = decideSwitch(st('cf', 'at', true), 'cf');
    expect(mid).toEqual({ kind: 'retarget', mid: 'at' });
    // retarget 落地后：shown=at、want=at、无编排 → 再点 cf 就是一次正常飞出
    expect(decideSwitch(st('at', 'at', false), 'cf')).toEqual({ kind: 'fly', from: 'at' });
  });
});
