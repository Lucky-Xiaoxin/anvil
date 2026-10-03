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
  /** 有方向的读数（rating 涨跌）：涨走数据蓝，与折线分段同色 */
  up?: boolean;
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
  const ref = useRef<HTMLDivElement | null>(null);
  const hide = useCallback(() => setTip(null), []);
  const api = useMemo<TipApi>(() => ({ show: setTip, hide }), [hide]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const half = el.offsetWidth / 2 + 6;
    el.style.left = `${Math.max(half, Math.min(window.innerWidth - half, tip.x))}px`;
    el.style.top = `${tip.y - 10}px`;
  }, [tip]);

  useEffect(() => {
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [hide]);

  return (
    <TipCtx.Provider value={api}>
      {children}
      {tip && (
        <div className="tip" ref={ref} role="tooltip" aria-hidden="false" style={{ left: tip.x, top: tip.y - 10 }}>
          <div className="tip__d">{tip.date}</div>
          <div className={`tip__v${tip.zero ? ' is-zero' : ''}${tip.up ? ' is-up' : ''}`}>{tip.value}</div>
        </div>
      )}
    </TipCtx.Provider>
  );
}
