import type { SourceId } from '@anvil/shared';

/**
 * 切屏的决策核（纯函数，无 DOM、无 React）。单测钉住 2026-10-05 定的两条规则。
 *
 * 背景（docs/09 §7）：换屏 = 旧卡飞出 → 空档 → 落地屏飞入，整段 1390ms（6 卡）/ 1484ms（7 卡）。
 * 飞出的卡挂 `fill:"forwards"`，一旦被 `cancel()` 就瞬移回原位 —— 所以**编排期间不接受任何
 * 新的切换请求**：改道会让卡片在中间屏上先回原位再重飞，看上去就是"卡直接出现然后才飞"。
 */

export interface SwitchState {
  /** 真的挂在屏上的源（切换进行中仍是旧屏幕） */
  shown: SourceId;
  /** 是否有编排在播 */
  flying: boolean;
}

export type SwitchAction =
  /** 编排在播：忽略本次点击，等它跑完（用户 2026-10-05 拍板的口径） */
  | { kind: 'ignore' }
  /** 已经在这个源上：什么都不用做 */
  | { kind: 'plain' }
  /** 从 `from` 飞出去，落地后再飞入 */
  | { kind: 'fly'; from: SourceId };

/**
 * 决定这次点击该干什么。
 *
 * 1. `flying` → 一律忽略。这是"不叠两套动画"的硬保证，也让编排期间的表现完全可预期：
 *    点谁都不动，等这一轮跑完再响应下一次点击。
 * 2. `shown === next` → `plain`，不重播动效。
 * 3. 其余 → `fly`，`from` 就是当前挂屏的源。
 *
 * 注意调用方还有一层 `canFly`（屏上没有卡片可飞时走瞬切）：只有真的能从 `from` 飞出去，
 * 才允许置落地标志，否则空屏上会挂一次没有意义的飞入。
 */
export function decideSwitch(state: SwitchState, next: SourceId): SwitchAction {
  const { shown, flying } = state;
  if (flying) return { kind: 'ignore' };
  if (shown === next) return { kind: 'plain' };
  return { kind: 'fly', from: shown };
}
