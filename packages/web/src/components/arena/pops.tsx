/**
 * 弹层壳子（docs/contracts/16 §5.2 + docs/contracts/20 §2.3）：提交明细 / 队伍 / 「我的成绩」面板共用一套定位，
 * 外观照 mock-04 的 `.pop`。
 *
 * 封榜段内的记录一律显示 `Frozen` —— 契约 §4 要的是这个词（不泄露判名），
 * 稿内的 `?` 是格子的读法，弹层里按 §4 走。
 */
import { memo, type ReactNode } from 'react';

/** 视口坐标：由调用方从被点元素的 getBoundingClientRect 拿来 */
export interface Anchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 弹层外壳。`width` / `height` 是稿内定值（默认 270 × 260 = 提交明细与队伍弹层），
 * 幽灵面板更高（330 × 500 = 13 行输入 + 底部开关 + 小注的实测高）—— 翻转判定按传入值算，
 * 默认值保证现有两弹层零变化。
 *
 * `label` 同规格：默认「明细」= 提交明细 / 队伍两弹层原样，幽灵弹层传「我的成绩」
 * （它不是"明细"，是一块录入面板，无障碍名跟着语义走）。
 */
export function Popover({
  anchor,
  viewport,
  onClose,
  width = 270,
  height = 260,
  label = '明细',
  cls,
  children,
}: {
  anchor: Anchor;
  viewport: { w: number; h: number };
  onClose: () => void;
  width?: number;
  height?: number;
  /** 弹层的无障碍名（默认「明细」） */
  label?: string;
  /** 追加到 `.pop` 的修饰类（默认无 = 现有两弹层零变化） */
  cls?: string;
  children: ReactNode;
}) {
  /*
   * 高度在测量前未知，按稿内的落点算：默认贴在锚点下方 8px，装不下就翻到上方。
   * 宽度是稿内定值，不需要测量就能定横向。
   */
  const left = Math.max(10, Math.min(viewport.w - width - 10, anchor.left + anchor.width / 2 - width / 2));
  const below = anchor.top + anchor.height + 8;
  const flip = below + height > viewport.h;
  const top = flip ? Math.max(10, anchor.top - 8 - height) : below;
  return (
    <>
      <div className="backdrop" onMouseDown={onClose} />
      <div className={cls === undefined ? 'pop' : `pop ${cls}`} role="dialog" aria-modal="false" aria-label={label} style={{ left, top, width }}>
        {children}
        <button className="pop__x" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>
    </>
  );
}

/** 判名 → 结果档颜色类 */
export function resClass(r: string): string {
  if (r === 'AC') return 'res res--ac';
  if (r === 'FB') return 'res res--fb';
  if (r === 'CE') return 'res res--mute';
  return 'res res--bad';
}

export interface PopHead {
  title: string;
  sub: string;
}

export const PopShell = memo(function PopShell({ head, children }: { head: PopHead; children: ReactNode }) {
  return (
    <>
      <div className="pop__h">
        <span className="pop__t">{head.title}</span>
      </div>
      {head.sub === '' ? null : <div className="pop__sub">{head.sub}</div>}
      <div className="pop__rule" />
      {children}
    </>
  );
});
