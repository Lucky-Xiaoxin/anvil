import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface TipData {
  x: number;
  y: number;
  date: string;
  value: string;
  zero: boolean;
  /** 方向读数（rating 涨跌）：单独上色，主读数保持琥珀 */
  delta?: string;
  deltaUp?: boolean;
  /** 第三行起：口径 / 原因（源状态、名次与 Perf 这类附注）。阶梯与编年要给到四行 */
  sub?: string | string[];
  /** 主读数换档：折线 tooltip 分数按方向上色，与线段同色 */
  valueClass?: string;
  /** 强制在锚点下方弹出（此时 y 传锚点底缘）：顶部 tab 条用它 —— 上方放不下，而按默认
   *  翻面落点 `y + 18` 又会落进 47px 高的按钮里，把按钮下半截盖住 */
  below?: boolean;
}

interface TipApi {
  show: (tip: TipData) => void;
  hide: () => void;
}

const TipCtx = createContext<TipApi>({ show: () => {}, hide: () => {} });

export const useTip = (): TipApi => useContext(TipCtx);

/** 一个全局 tooltip：position:fixed，不受内容区滚动裁剪 */
export function TipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipData | null>(null);
  const [below, setBelow] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const hide = useCallback(() => setTip(null), []);
  const api = useMemo<TipApi>(() => ({ show: setTip, hide }), [hide]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const half = el.offsetWidth / 2 + 6;
    el.style.left = `${Math.max(half, Math.min(window.innerWidth - half, tip.x))}px`;
    /*
     * 基础样式是 translate(-50%,-100%)，浮层整体在锚点上方 10px 处。顶栏底下的 tab 条
     * 锚点 top 只有 56px，而浮层高 55–73px —— 不翻面的话标题行整行跑到视口外。
     * 上方放不下就翻到下方（箭头跟着翻，改由 .tip--below 接管）；锚点自带 below 偏好的
     * （tab 条）一律走下方，y 是它们的底缘。
     */
    const down = tip.below === true || tip.y - 10 - el.offsetHeight < 4;
    el.style.transform = down ? 'translate(-50%,0)' : 'translate(-50%,-100%)';
    el.style.top = `${down ? tip.y + 18 : tip.y - 10}px`;
    setBelow(down);
  }, [tip]);

  useEffect(() => {
    window.addEventListener('scroll', hide, true);
    /*
     * 锚点被卸载时不会补发 mouseleave：hover 着 tab 条直接点侧栏「设置」，tab 条整个消失，
     * 浮层就一直飘在设置页上。浮层本身没有可点内容，所以任何一次点击都先收掉它。
     */
    document.addEventListener('click', hide, true);
    return () => {
      window.removeEventListener('scroll', hide, true);
      document.removeEventListener('click', hide, true);
    };
  }, [hide]);

  return (
    <TipCtx.Provider value={api}>
      {children}
      {tip && (
        <div
          className={`tip${below ? ' tip--below' : ''}`}
          ref={ref}
          role="tooltip"
          aria-hidden="false"
          style={{ left: tip.x, top: tip.y - 10 }}
        >
          <div className="tip__d">{tip.date}</div>
          <div className={`tip__v${tip.zero ? ' is-zero' : ''}${tip.valueClass ? ` ${tip.valueClass}` : ''}`}>
            {tip.value}
            {tip.delta ? <b className={tip.deltaUp ? 'is-up' : undefined}>{tip.delta}</b> : null}
          </div>
          {tip.sub
            ? (Array.isArray(tip.sub) ? tip.sub : [tip.sub]).map((line, i) => (
                <div className="tip__x" key={i}>
                  {line}
                </div>
              ))
            : null}
        </div>
      )}
    </TipCtx.Provider>
  );
}
