import { useMemo, type CSSProperties } from 'react';
import { signedDelta, type RatingPointDto } from '@anvil/shared';
import { useTip } from '../tip.tsx';

const W = 660;
const H = 168;
const PL = 46;
const PR = 56;
const PT = 28;
const PB = 16;

export function RatingChart({ series }: { series: RatingPointDto[] }) {
  const { show, hide } = useTip();

  const g = useMemo(() => {
    const n = Math.max(1, series.length - 1);
    const last = series.length - 1;
    const lo = series.reduce((m, p) => Math.min(m, p.newRating), Number.POSITIVE_INFINITY);
    const hi = series.reduce((m, p) => Math.max(m, p.newRating), Number.NEGATIVE_INFINITY);
    const min = Math.floor((lo - 60) / 50) * 50;
    const max = Math.ceil((hi + 60) / 50) * 50;
    const span = (W - PL - PR) / n;
    const X = (i: number) => PL + i * span;
    const Y = (v: number) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);
    let pi = 0;
    series.forEach((p, i) => {
      if (p.newRating > series[pi]!.newRating) pi = i;
    });
    const grid: number[] = [];
    const step = 100 * Math.max(1, Math.ceil((max - min) / 600));
    for (let v = min; v <= max; v += step) if (v > min && v < max) grid.push(v);
    const candidates = [0, Math.round(n / 3), Math.round((2 * n) / 3), last];
    const axis: number[] = [];
    for (const i of candidates) if (!axis.some((j) => series[j]!.ts === series[i]!.ts)) axis.push(i);
    return { X, Y, pi, grid, span, last, axis };
  }, [series]);

  if (series.length === 0) return null;

  const start = series[0]!;
  const last = series[g.last]!;
  const peak = series[g.pi]!;

  const place = (x: number, y: number): CSSProperties => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

  return (
    <>
      <div className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`近 ${series.length} 场 rating 折线：${start.newRating} 到 ${last.newRating}，最高 ${peak.newRating}`}
        >
          {g.grid.map((v) => (
            <g key={v}>
              <line
                x1={PL}
                x2={W - PR}
                y1={g.Y(v)}
                y2={g.Y(v)}
                stroke="#222A36"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text x={PL - 9} y={g.Y(v) + 3.4} textAnchor="end" fill="#6C7A8C" fontSize={10} fontFamily="Consolas, monospace">
                {v}
              </text>
            </g>
          ))}

          {/* 起点以下压暗：那是已经离开的地方 */}
          <rect
            x={PL}
            y={g.Y(start.newRating)}
            width={W - PL - PR}
            height={H - PB - g.Y(start.newRating)}
            fill="rgba(76,201,240,.035)"
          />

          {/* 分段着色：涨 = 数据蓝，跌 = 琥珀 */}
          {series.slice(0, -1).map((p, s) => {
            const up = series[s + 1]!.newRating >= p.newRating;
            return (
              <line
                key={`s${s}`}
                x1={g.X(s)}
                y1={g.Y(p.newRating)}
                x2={g.X(s + 1)}
                y2={g.Y(series[s + 1]!.newRating)}
                stroke={up ? '#4CC9F0' : '#F5A524'}
                strokeWidth={1.9}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          <line
            x1={g.X(g.pi)}
            x2={g.X(g.pi)}
            y1={g.Y(peak.newRating) + 7}
            y2={H - PB}
            stroke="rgba(245,165,36,.30)"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={g.X(g.pi)}
            cy={g.Y(peak.newRating)}
            r={4.4}
            fill="#0A0C10"
            stroke="#F5A524"
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
          />

          {series.map((p, i) =>
            i === g.pi || i === g.last ? null : (
              <circle
                key={`p${i}`}
                cx={g.X(i)}
                cy={g.Y(p.newRating)}
                r={2.1}
                fill={p.delta >= 0 ? '#4CC9F0' : '#F5A524'}
                opacity={0.75}
              />
            ),
          )}
          <circle cx={g.X(g.last)} cy={g.Y(last.newRating)} r={9} fill="rgba(245,165,36,.14)" />
          <circle
            cx={g.X(g.last)}
            cy={g.Y(last.newRating)}
            r={4}
            fill="#F5A524"
            stroke="#0A0C10"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />

          {series.map((p, i) => (
            <rect
              key={`h${i}`}
              className="hit"
              x={g.X(i) - g.span / 2}
              y={0}
              width={g.span}
              height={H}
              onMouseEnter={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                const suffix = i === 0 ? ' · 起点' : `  ${signedDelta(p.delta)}`;
                show({
                  x: box.left + box.width / 2,
                  y: box.top + (g.Y(p.newRating) / H) * box.height,
                  date: `${p.contestName} · ${p.ts}`,
                  value: `${p.newRating}${suffix}${i === g.pi ? ' · 峰值' : ''}`,
                  zero: false,
                  up: p.delta >= 0,
                });
              }}
              onMouseLeave={hide}
            />
          ))}
        </svg>
        <div className="chart__peak" style={place(g.X(g.pi), g.Y(peak.newRating))}>
          峰值 {peak.newRating}
        </div>
        <div className="chart__now" style={place(g.X(g.last), g.Y(last.newRating))}>
          {last.newRating}
        </div>
      </div>
      <div className="chart__x">
        {g.axis.map((i) => (
          <span key={i}>{series[i]?.ts}</span>
        ))}
      </div>
    </>
  );
}
