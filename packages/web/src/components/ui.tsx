import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { levelOf, type ActivityCellDto, type MonthBucketDto } from '@anvil/shared';
import { fmtInt, prefersReduced } from '../format.ts';
import { useTip } from '../tip.tsx';

export function Icon({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  return (
    <svg aria-hidden="true" className={className} style={style}>
      <use href={`#${id}`} />
    </svg>
  );
}

/** 主数字：count-up ≤600ms；reduced-motion 或页面隐藏时直接落终值 */
export function Num({ to, className }: { to: number | null | undefined; className?: string }) {
  const [text, setText] = useState('—');

  useLayoutEffect(() => {
    if (to === null || to === undefined) {
      setText('—');
      return;
    }
    if (prefersReduced() || document.hidden) {
      setText(fmtInt(to));
      return;
    }
    const duration = 560;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setText(fmtInt(Math.round(to * (1 - Math.pow(1 - p, 3)))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);

  return <span className={className}>{text}</span>;
}

export function Delta({ text, tone }: { text: string | null | undefined; tone: number | null | undefined }) {
  const n = tone ?? 0;
  const cls = `delta${n > 0 ? ' delta--up' : n < 0 ? ' delta--down' : ''}`;
  return <span className={cls}>{text ?? '—'}</span>;
}

/** 近 6 个月迷你柱状：涨跌看柱形，细节看 hover */
export function MonthlyBars({ months }: { months: MonthBucketDto[] }) {
  const { show, hide } = useTip();
  const max = months.reduce((m, x) => Math.max(m, x.solved), 0);
  return (
    <div className="mbars" role="img" aria-label="近 6 个月过题柱状图">
      {months.map((m) => (
        <div
          key={m.month}
          className={`mbar${m.partial ? ' mbar--partial' : ''}`}
          aria-label={`${m.month} ${m.solved} 题${m.partial ? ' 进行中' : ''}`}
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            show({
              x: r.left + r.width / 2,
              y: r.top,
              date: m.month,
              value: `${m.solved} 题${m.partial ? ' · 进行中' : ''}`,
              zero: m.solved === 0,
            });
          }}
          onMouseLeave={hide}
        >
          <i style={{ height: `${max > 0 ? (m.solved / max) * 100 : 0}%` }} />
          <b />
        </div>
      ))}
    </div>
  );
}

export function StreakTicks({ activity }: { activity: ActivityCellDto[] }) {
  const last = activity.slice(-14);
  return (
    <div className="ticks" aria-hidden="true">
      {last.map((c, i) => (
        <i
          key={c.day}
          data-l={levelOf(c.solved)}
          className={i === last.length - 1 ? 'today' : undefined}
        />
      ))}
    </div>
  );
}
