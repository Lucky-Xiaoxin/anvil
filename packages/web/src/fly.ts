import { prefersReduced } from './format.ts';

/**
 * 卡片飞出飞入编排（docs/contracts/09 §7，2026-10-04 第 15 轮口径 · 定稿档 = 极缓）。
 * 时序不变量：第 i 张 delay = i×STEP、duration = DUR + i×DSTEP，STEP 与 DSTEP 同为正
 * ⇒ 起步与完成时间都严格递增 —— 任意两张卡不会同时起步、也不会同时完成。
 */
export const FLY = {
  out: { dur: 180, step: 20, durStep: 5, ease: 'cubic-bezier(.65,0,.35,1)' },
  in: { dur: 260, step: 15, durStep: 7, ease: 'cubic-bezier(.4,0,.2,1)' },
  /* 契约定档是 step 51/40 + handoff 80（整段 1530/1644ms）；
     用户 2026-10-05 两轮微调：空档减半、两段起步间隔各再减 10ms → 整段 1390/1484ms；
     用户 2026-10-10（UX 批次）：两段时长再各砍一半、step 与 durStep 同步收 → 整段 695/742ms */
  handoff: 20,
  rise: 72,
  scale: 4,
  /** 中线 ±3% 内算「中部」：跨行宽卡（格子图 / 曲线 / 降级条）走右侧 */
  dead: 0.03,
} as const;

/**
 * 第 i 张卡的起步与时长：`start = i×STEP`、`duration = DUR + i×DSTEP`。
 * STEP 与 DSTEP 同为正 ⇒ 起步与完成时间都严格递增 —— 时序不变量的唯一来源，单独抽出来才好测。
 */
export function legTimes(n: number, leg: 'out' | 'in'): { start: number; duration: number }[] {
  const p = leg === 'out' ? FLY.out : FLY.in;
  return Array.from({ length: n }, (_, i) => ({ start: i * p.step, duration: p.dur + i * p.durStep }));
}

/**
 * 飞行物 = 内容区的直接子卡片：四张统计卡、格子卡 / 曲线卡、降级条；
 * XCPC 屏两个飞行单元 —— 整卷（.dossier）与认领卡（.stack > .card），docs/contracts/14 §5.4。
 */
const FLY_SELECTOR =
  ':scope > .grid-4 > .stat, :scope > .card, :scope > .alert, :scope > .dossier, :scope > .stack > .card';

export const flyNodes = (content: HTMLElement): HTMLElement[] =>
  Array.from(content.querySelectorAll<HTMLElement>(FLY_SELECTOR));

interface Item {
  node: HTMLElement;
  left: number;
  right: number;
  dist: number;
  /** -1 = 中线左、1 = 右、0 = 中部（按右飞） */
  side: number;
}

function plan(content: HTMLElement): { items: Item[]; box: DOMRect } {
  const box = content.getBoundingClientRect();
  const mid = box.left + box.width / 2;
  const items = flyNodes(content).map((node) => {
    const r = node.getBoundingClientRect();
    const dx = r.left + r.width / 2 - mid;
    return {
      node,
      left: r.left,
      right: r.right,
      dist: Math.abs(dx),
      side: Math.abs(dx) < box.width * FLY.dead ? 0 : dx < 0 ? -1 : 1,
    };
  });
  return { items, box };
}

/** 飞出：外圈先走（距中线降序）。左卡钻进侧边栏底下并淡出，右卡切在屏幕边 */
export function flyOut(content: HTMLElement): { total: number; anims: Animation[] } {
  const { items, box } = plan(content);
  items.sort((a, b) => b.dist - a.dist);
  const s = FLY.scale / 100;
  const times = legTimes(items.length, 'out');
  const anims: Animation[] = [];
  let total = 0;
  items.forEach((it, i) => {
    const { start: delay, duration } = times[i]!;
    const dl = Math.round(it.right - box.left) + 48;
    const dr = Math.round(box.right - it.left) + 48;
    const kf =
      it.side < 0
        ? [
            { transform: 'translateX(0px) scale(1)', opacity: 1 },
            { transform: `translateX(${Math.round(-dl * 0.62)}px) scale(${(1 - s * 0.62).toFixed(3)})`, opacity: 0.85, offset: 0.62 },
            { transform: `translateX(${-dl}px) scale(${(1 - s).toFixed(3)})`, opacity: 0 },
          ]
        : [
            { transform: 'translateX(0px) scale(1)', opacity: 1 },
            { transform: `translateX(${dr}px) scale(${(1 - s).toFixed(3)})`, opacity: 1 },
          ];
    // fill:"forwards" —— 先飞完的卡必须停在屏外，否则它自己的动画先结束、换屏还没到，卡片会在原地复活
    anims.push(it.node.animate(kf, { duration, delay, easing: FLY.out.ease, fill: 'forwards' }));
    total = Math.max(total, delay + duration);
  });
  return { total, anims };
}

/** 飞入：中部先来（距中线升序），从底部升起 72 + 距/6 px 收成扇形 */
export function flyIn(content: HTMLElement): { total: number; anims: Animation[] } {
  const { items } = plan(content);
  items.sort((a, b) => a.dist - b.dist);
  const s = FLY.scale / 100;
  const times = legTimes(items.length, 'in');
  const anims: Animation[] = [];
  let total = 0;
  items.forEach((it, i) => {
    const { start: delay, duration } = times[i]!;
    const rise = Math.round(FLY.rise + it.dist / 6);
    anims.push(
      it.node.animate(
        [
          { transform: `translateY(${rise}px) scale(${(1 - s).toFixed(3)})`, opacity: 0 },
          { transform: 'translateY(0px) scale(1)', opacity: 1 },
        ],
        { duration, delay, easing: FLY.in.ease, fill: 'backwards' },
      ),
    );
    total = Math.max(total, delay + duration);
  });
  return { total, anims };
}

/** 整套编排跳过、直接换屏（prefers-reduced-motion） */
export const flySkipped = (): boolean => prefersReduced();
