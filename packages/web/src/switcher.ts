import type { SourceId } from '@anvil/shared';

/**
 * 切屏的决策核（纯函数，无 DOM、无 React），供单测钉住 2026-10-05 修掉的两个闪屏 bug。
 *
 * 背景（docs/09 §7）：换屏 = 旧卡飞出 → 空档 → 落地屏飞入。飞出的卡挂 `fill:"forwards"`，
 * 一旦被 `cancel()` 就会瞬移回原位 —— 所以任何"取消正在播的编排"都必须伴随一次复位。
 */

export interface SwitchState {
  /** 真的挂在屏上的源（切换进行中仍是旧屏幕） */
  shown: SourceId;
  /** 正在飞向的源 */
  want: SourceId;
  /** 是否有编排在播 */
  flying: boolean;
}

export type SwitchAction =
  /** 目标已在途：忽略，让编排走完 */
  | { kind: 'ignore' }
  /** 离屏半途被掐断：先复位旧卡并立即落位到 `mid` */
  | { kind: 'retarget'; mid: SourceId }
  /** 直接换屏，无编排 */
  | { kind: 'plain' }
  /** 从 `from` 飞出去，落地后再飞入 */
  | { kind: 'fly'; from: SourceId };

/**
 * 决定这次点击该干什么。
 *
 * 两条被钉住的规则：
 * 1. `want === next` → 忽略。若不忽略，连点同一个 tab 会把正在播的飞出段 `cancel()` 掉，
 *    挂 forwards 的卡瞬间弹回原位再重飞 —— 就是"原位置所有卡突然出现、闪一下再消失"。
 * 2. 只有在真的能从 `from` 飞出去时才返回 `fly`；否则 `plain`，调用方**不得**置落地标志，
 *    否则空屏上会挂一次没有意义的飞入。
 */
export function decideSwitch(state: SwitchState, next: SourceId): SwitchAction {
  const { shown, want, flying } = state;
  if (flying && next === want) return { kind: 'ignore' };
  if (flying) return { kind: 'retarget', mid: want };
  if (shown === next) return { kind: 'plain' };
  return { kind: 'fly', from: shown };
}
