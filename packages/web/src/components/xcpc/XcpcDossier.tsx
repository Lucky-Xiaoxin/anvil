/**
 * 档案长卷（docs/14 §5.3）：名衔 → 荣誉陈列 → 阶梯轨迹 → 队名墙 → 逐场编年 → 卷脚。
 * 一整卷是一个飞行单元（.dossier），组件全部自绘：阶梯是 SVG、勋章是 CSS。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { type MouseEvent } from 'react';
import { signedDelta } from '@anvil/shared';
import type { XcpcHistoryRow, XcpcPlayerDto, XcpcProfileDto, XcpcStatusDto, XcpcTier } from '@anvil/shared';
import { fmtInt } from '../../format.ts';
import { useTip, type TipData } from '../../tip.tsx';
import { Delta, Icon, Num } from '../ui.tsx';
import { NoticeBar, type Notice } from '../Dashboard.tsx';
import {
  METAL_NAME,
  TIER_NAME,
  bestRank,
  careerSpan,
  chronicleChapters,
  dayOf,
  isUp,
  medalRows,
  medalTotal,
  monthOf,
  pctFrom,
  rowPct,
  snapshotDate,
  snapshotDaysAgo,
  teamRuns,
  timeline,
  type MedalDisc,
  type Timeline,
  type TimelinePoint,
} from './derive.ts';

/** 读数一律先取整；千分位沿用 CF / AT 那把尺（≥10 000 才分节） */
const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : fmtInt(Math.round(n));

const ROUND = ' · ';

/** 分一律取整显示，差值也一样 —— 上游是浮点，直接减会读出 −40.99999999999985 */
const deltaText = (delta: number | null): string | undefined => (delta === null ? undefined : signedDelta(Math.round(delta)));

/** 罚时比 / 首 A / 末小时：不是官方榜字段，打星行也有前两个 */
function penaltyLine(row: XcpcHistoryRow, withLastHour: boolean): string | null {
  if (row.dirt === null && row.firstATime === null) return null;
  const parts = [`罚时比 ${row.dirt === null ? '—' : row.dirt.toFixed(2)}`, `首 A ${row.firstATime === null ? '—' : `${fmt(row.firstATime)}′`}`];
  if (withLastHour && row.lastHourSolved !== null) parts.push(`末小时 ${row.lastHourSolved} 题`);
  return parts.join(' · ');
}

/** 浮层内容由调用方给，锚点坐标由 `at()` 量；`zero` 可选（打星行要压成灰字） */
type TipSpec = Omit<TipData, 'x' | 'y' | 'zero'> & { zero?: boolean };

function useAnchor() {
  const { show, hide } = useTip();
  const at = (spec: TipSpec) => (e: MouseEvent<Element>) => {
    const r = e.currentTarget.getBoundingClientRect();
    show({ ...spec, zero: spec.zero ?? false, x: r.left + r.width / 2, y: r.top });
  };
  return { at, hide, show };
}

/* ---------- 1. 名衔 ---------- */

function Mast({ player, profile, animate }: { player: XcpcPlayerDto; profile: XcpcProfileDto; animate: boolean }) {
  const { at, hide } = useAnchor();
  const best = bestRank(player.history);
  const span = careerSpan(player.history);
  const total = profile.rankTotal;
  const pct = total === null ? null : pctFrom(Math.round(player.officialRank), Math.round(total));

  return (
    <header className="mast">
      <Icon id="i-anvil" className="mast__wm" />
      <div className="mast__l">
        <span className="label label--pf">XCPC · 官方榜</span>
        <h2
          className="mast__name"
          onMouseEnter={at({
            date: '档案 key',
            value: player.key,
            valueClass: 'is-dim',
            sub: '重名请对照学校区分',
          })}
          onMouseLeave={hide}
        >
          {player.name}
        </h2>
        <div className="mast__school">{player.org}</div>
        <div className="mast__key">key {player.key}</div>
      </div>
      <div className="mast__r">
        <span className="label">当前分</span>
        <b className="mast__num">
          <Num to={Math.round(player.officialRating)} instant={!animate} />
        </b>
        <div className="mast__rank">
          官方榜 <b><Num to={Math.round(player.officialRank)} instant={!animate} /></b> / {fmt(total)}
          {pct !== null ? `${ROUND}${pct}` : ''}
        </div>
      </div>
      <div className="mast__strip">
        <div className="mcell">
          <span className="label">参赛场次</span>
          <b className="mcell__v">
            <Num to={player.contests} instant={!animate} /> 场
          </b>
        </div>
        <div className="mcell">
          <span className="label">最佳名次</span>
          <b
            className="mcell__v"
            onMouseEnter={at({
              date: '最佳名次',
              value: best === null ? '无官方榜名次' : `第 ${fmt(best.rank)} 名`,
              valueClass: best === null ? 'is-mute' : undefined,
              sub: best === null ? undefined : `${best.title}${ROUND}${fmt(best.teams)} 队`,
            })}
            onMouseLeave={hide}
          >
            {best === null ? '—' : `第 ${fmt(best.rank)} 名`}
          </b>
        </div>
        <div className="mcell">
          <span className="label">生涯跨度</span>
          <b
            className="mcell__v mcell__v--span"
            onMouseEnter={at({
              date: '生涯跨度',
              value: span === null ? '—' : `${span.from}${ROUND}→${ROUND}${span.to}`,
              valueClass: 'is-dim',
              sub: span === null ? undefined : `${span.days} 天 · ${span.months} 个月`,
            })}
            onMouseLeave={hide}
          >
            {span === null ? '—' : `${monthOf(span.from)} → ${monthOf(span.to)}`}
          </b>
        </div>
      </div>
    </header>
  );
}

/* ---------- 2. 荣誉陈列 ---------- */

function Disc({ tier, disc }: { tier: XcpcTier; disc: MedalDisc }) {
  const { at, hide } = useAnchor();
  const metal = METAL_NAME[disc.metal];
  return (
    <span
      className={`medal medal--${disc.metal}${tier === 'final' ? ' medal--final' : ''}`}
      onMouseEnter={at({
        date: `${TIER_NAME[tier] ?? tier} · ${metal}`,
        value: `${metal} 共 ${disc.ofSameMetal} 枚`,
        valueClass: `is-${disc.metal}`,
      })}
      onMouseLeave={hide}
    >
      <span className="medal__d" />
    </span>
  );
}

function Vitrine({ player }: { player: XcpcPlayerDto }) {
  const rows = medalRows(player.medals);
  const total = medalTotal(rows);

  return (
    <section className="sect">
      <div className="sect__h">
        <span className="label label--pf">Honors</span>
        <h3 className="sect__t">荣誉陈列</h3>
        <span className="sect__rule" aria-hidden="true" />
        <span className="card__note">
          共 <b>{total}</b> 枚
        </span>
      </div>
      <div className="vitrine">
        {rows.length === 0 ? (
          <div className="vrow" style={{ padding: '6px 0' }}>
            <span className="mnone">—</span>
          </div>
        ) : (
          rows.map((row) => (
            <div className={`vrow${row.weight}`} key={row.tier}>
              <div className="vrow__t">{row.name}</div>
              <div className="vrow__discs">
                {row.discs.map((disc, i) => (
                  <Disc tier={row.tier} disc={disc} key={`${row.tier}-${i}`} />
                ))}
                {row.hidden > 0 ? <FoldMore tier={row.name} hidden={row.hidden} /> : null}
              </div>
              <div className="vrow__n">{row.total} 枚</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** 折叠计数 chip：一枚 = 一块奖牌，摆到 12 枚就收，剩下的报数 */
function FoldMore({ tier, hidden }: { tier: string; hidden: number }) {
  const { at, hide } = useAnchor();
  return (
    <span
      className="medal-more"
      onMouseEnter={at({ date: `${tier} · 折叠`, value: `另有 ${hidden} 枚`, valueClass: 'is-dim' })}
      onMouseLeave={hide}
    >
      {`+${hidden}`}
    </span>
  );
}

/* ---------- 3. 阶梯轨迹（SVG 自绘） ---------- */

const H = 238;
const PL = 46;
const PR = 58;
const PT = 30;
const PB = 28;
const FALLBACK_W = 760;

/** 命中区与浮层的落点：打星点没有 y，钉在中段（docs/14 §5.3） */
function pointTip(point: TimelinePoint): TipSpec {
  const { row, delta } = point;
  const date = `${row.title} · ${dayOf(row.startAt)}`;
  if (row.star) {
    return {
      date,
      value: '打星场 · 官方榜无成绩',
      zero: true,
      sub: `过 ${row.solved} 题${ROUND}${row.teamName}`,
    };
  }
  const rank = `第 ${fmt(row.rank)} 名 / ${fmt(row.teams)} 队${ROUND}${rowPct(row) ?? '—'}`;
  const sub = row.perf === null ? [rank] : [rank, `Perf ${fmt(row.perf)}${ROUND}队名 ${row.teamName}`];
  return {
    date,
    value: fmt(row.ratingAfter),
    delta: deltaText(delta),
    deltaUp: isUp(delta),
    valueClass: isUp(delta) ? 'is-up' : 'is-down',
    sub,
  };
}

function Ridge({ tl, animate }: { tl: Timeline; animate: boolean }) {
  const { show, hide } = useTip();
  const host = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(FALLBACK_W);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth) || FALLBACK_W;
      setW((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 一场 rated 都没有就没有台阶可画（docs/14 §5.3 边界）
  if (tl.rated.length === 0) {
    return <div className="skel">没有 rated 场次</div>;
  }

  const g = ridgeGeometry(tl, W);
  const last = tl.rated[tl.rated.length - 1]!;
  const place = (x: number, y: number) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

  return (
    <div className="ridge" ref={host}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`rating 阶梯 ${tl.rated.length} 场：${fmt(tl.first)} 到 ${fmt(tl.last)}，打星 ${tl.starCount} 场虚钉不入线`}
      >
        <defs>
          <linearGradient id="rgPf" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="s0" />
            <stop offset="1" className="s1" />
          </linearGradient>
        </defs>

        {g.grid.map((v) => (
          <g key={`g${v}`}>
            <line x1={PL} x2={W - PR} y1={g.Y(v)} y2={g.Y(v)} stroke="#222A36" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={PL - 9} y={g.Y(v) + 3.4} textAnchor="end" fill="#6C7A8C" fontSize={10} fontFamily="Consolas, monospace">
              {v}
            </text>
          </g>
        ))}

        {g.area === null ? null : <path d={g.area} fill="url(#rgPf)" stroke="none" />}
        {g.step === null ? null : (
          <path d={g.step} fill="none" stroke="#46566A" strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        )}

        <line x1={PL} x2={W - PR} y1={g.BASELINE} y2={g.BASELINE} stroke="#2A3441" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {g.ticks.map((x, i) => (
          <line
            key={`t${i}`}
            x1={x}
            x2={x}
            y1={g.BASELINE}
            y2={g.BASELINE + 5}
            stroke="#2A3441"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* 打星虚钉：不入线，但占一个场次位 */}
        {g.pins.map((pin) => (
          <g key={`s${pin.index}`}>
            <line
              x1={pin.x}
              x2={pin.x}
              y1={PT + 16}
              y2={g.BASELINE}
              stroke="#39434F"
              strokeWidth={1}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
            <text x={pin.x} y={PT + 10} textAnchor="middle" fill="#6C7A8C" fontSize={9.5} fontFamily="Consolas, monospace">
              打星
            </text>
          </g>
        ))}

        {g.marks.map((mark) => (
          <rect
            key={`m${mark.index}`}
            x={mark.x - 2.7}
            y={mark.y - 2.7}
            width={5.4}
            height={5.4}
            transform={`rotate(45 ${mark.x} ${mark.y})`}
            fill={mark.up ? '#4CC9F0' : '#F5A524'}
            opacity={0.9}
          />
        ))}
        <circle cx={g.X(last.index)} cy={g.Y(last.rating ?? 0)} r={10} fill="rgba(245,165,36,.14)" />
        <rect
          x={g.X(last.index) - 3.4}
          y={g.Y(last.rating ?? 0) - 3.4}
          width={6.8}
          height={6.8}
          transform={`rotate(45 ${g.X(last.index)} ${g.Y(last.rating ?? 0)})`}
          fill="#F5A524"
          stroke="#0A0C10"
          strokeWidth={1.4}
          vectorEffect="non-scaling-stroke"
        />

        {g.hits.map((hit) => (
          <rect
            key={`h${hit.index}`}
            className="hit"
            x={hit.x}
            y={0}
            width={hit.w}
            height={H}
            onMouseEnter={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const point = tl.points[hit.index]!;
              const tip = pointTip(point);
              const y = point.rating === null ? PT + 50 : g.Y(point.rating);
              show({ ...tip, zero: tip.zero ?? false, x: box.left + box.width / 2, y: box.top + (y / H) * box.height });
            }}
            onMouseLeave={hide}
          />
        ))}
      </svg>
      <div className="ridge__now" style={place(g.X(last.index), g.Y(last.rating ?? 0))}>
        <Num to={Math.round(tl.last ?? 0)} instant={!animate} />
      </div>
      <div className="ridge__x">
        {g.axis.map((index) => (
          <span key={`x${index}`}>{`第 ${index + 1} 场`}</span>
        ))}
      </div>
    </div>
  );
}

/** 台阶几何：一场 rated 时只给点，不画线也不除零 */
function ridgeGeometry(tl: Timeline, W: number) {
  const N = tl.points.length;
  const lo = tl.rated.reduce((m, p) => Math.min(m, p.rating ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  const hi = tl.rated.reduce((m, p) => Math.max(m, p.rating ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  const min = Math.floor((lo - 40) / 50) * 50;
  const max = Math.ceil((hi + 40) / 50) * 50;
  const BASELINE = H - PB;
  const span = N > 1 ? (W - PL - PR) / (N - 1) : 0;
  const X = (index: number) => (N > 1 ? PL + index * span : PL + (W - PL - PR) / 2);
  const Y = (v: number) => (max === min ? PT : PT + (1 - (v - min) / (max - min)) * (H - PT - PB));

  const pts = tl.rated.map((p) => ({ index: p.index, x: X(p.index), y: Y(p.rating ?? 0) }));
  let step: string | null = null;
  let area: string | null = null;
  if (pts.length > 1) {
    // 步进：横到下一场再竖直落阶；打星位被直接跨接
    step = `M${pts[0]!.x},${pts[0]!.y}`;
    for (let k = 1; k < pts.length; k++) {
      step += ` L${pts[k]!.x},${pts[k - 1]!.y} L${pts[k]!.x},${pts[k]!.y}`;
    }
    area = `${step} L${pts[pts.length - 1]!.x},${BASELINE} L${pts[0]!.x},${BASELINE} Z`;
  }

  const grid: number[] = [];
  for (let v = min + 100; v < max; v += 100) grid.push(v);

  const marks = tl.rated.map((p) => ({ index: p.index, x: X(p.index), y: Y(p.rating ?? 0), up: isUp(p.delta) }));
  const pins = tl.points.filter((p) => p.rating === null).map((p) => ({ index: p.index, x: X(p.index) }));
  const colW = N > 1 ? span : W - PL - PR;
  const hits = tl.points.map((p) => ({ index: p.index, x: N > 1 ? X(p.index) - span / 2 : PL, w: colW }));

  // x 刻度四枚：第 1 / ⌈N/3⌉ / ⌈2N/3⌉ / N 场（docs/14 §5.3，按 1 起的场次序号）
  const axis: number[] = [];
  for (const label of [1, Math.ceil(N / 3), Math.ceil((2 * N) / 3), N]) {
    const i = Math.max(0, Math.min(N - 1, label - 1));
    if (!axis.includes(i)) axis.push(i);
  }

  return { X, Y, BASELINE, grid, step, area, marks, pins, hits, axis, ticks: tl.points.map((p) => X(p.index)) };
}

/* ---------- 4. 队名墙 ---------- */

function Banners({ player }: { player: XcpcPlayerDto }) {
  const { at, hide } = useAnchor();
  const runs = teamRuns(player.history);
  const contests = player.history.length;

  return (
    <section className="sect">
      <div className="sect__h">
        <span className="label label--pf">Teams</span>
        <h3 className="sect__t">队名墙</h3>
        <span className="sect__rule" aria-hidden="true" />
        <span className="card__note">
          <b>{runs.length}</b> 支 · {contests} 场
        </span>
      </div>
      <div className="banners">
        {runs.map((run, i) => {
          const first = run.rows[0]!;
          const last = run.rows[run.rows.length - 1]!;
          return (
            <button
              type="button"
              className="banner"
              key={`${run.name}-${i}`}
              onMouseEnter={at({
                date: `番号 · ${run.name}`,
                value: `${run.rows.length} 场 · ${monthOf(first.startAt)} → ${monthOf(last.startAt)}`,
                valueClass: 'is-dim',
                sub:
                  run.best === null
                    ? '全部场次打星 · 无官方榜名次'
                    : `最佳 第 ${fmt(run.best.rank)} 名 / ${fmt(run.best.teams)} 队 · ${dayOf(run.best.startAt)}`,
              })}
              onMouseLeave={hide}
            >
              <div className="banner__n">{run.name}</div>
              <div className="banner__meta">
                <b className="banner__c">
                  {run.rows.length}
                  <u> 场</u>
                </b>
                <span className="banner__era">
                  {monthOf(first.startAt)} → {monthOf(last.startAt)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ---------- 5. 逐场编年 ---------- */

function chronTip(row: XcpcHistoryRow, point: TimelinePoint): TipSpec {
  const date = `${row.title} · ${dayOf(row.startAt)}`;
  const penalty = penaltyLine(row, !row.star);
  if (row.star) {
    const sub = [`过 ${row.solved} 题${ROUND}${row.teamName}`];
    if (penalty !== null) sub.push(penalty);
    return { date, value: '打星场 · 官方榜无成绩', zero: true, sub };
  }
  const sub = [`第 ${fmt(row.rank)} 名 / ${fmt(row.teams)} 队${ROUND}${rowPct(row) ?? '—'}`, `Perf ${fmt(row.perf)}${ROUND}${row.teamName}`];
  if (penalty !== null) sub.push(penalty);
  return {
    date,
    value: fmt(row.ratingAfter),
    delta: deltaText(point.delta),
    deltaUp: isUp(point.delta),
    valueClass: isUp(point.delta) ? 'is-up' : 'is-down',
    sub,
  };
}

function Chronicle({ player }: { player: XcpcPlayerDto }) {
  const { at, hide } = useAnchor();
  const chapters = useMemo(() => chronicleChapters(player), [player]);

  return (
    <section className="sect">
      <div className="sect__h">
        <span className="label label--pf">Chronicle</span>
        <h3 className="sect__t">逐场编年</h3>
        <span className="sect__rule" aria-hidden="true" />
        <span className="card__note">
          <b>{player.history.length}</b> 场 · 最新在上
        </span>
      </div>
      <div className="chronwrap">
        <table className="chron">
          <thead>
            <tr>
              <th style={{ width: 146 }}>日期</th>
              <th>比赛</th>
              <th style={{ width: 158 }}>队名</th>
              <th className="r" style={{ width: 126 }}>
                名次 ÷ 队数
              </th>
              <th className="r" style={{ width: 58 }}>
                过题
              </th>
              <th className="r" style={{ width: 72 }}>
                Perf
              </th>
              <th className="r" style={{ width: 122 }}>
                赛后分 ±
              </th>
            </tr>
          </thead>
          <tbody>
            {chapters.map((chapter) => (
              <FragmentChapter key={chapter.year} chapter={chapter} at={at} hide={hide} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 表格的 <tbody> 只能是 <tr>，所以年份小节行与它的战绩行平铺在同一层 */
function FragmentChapter({
  chapter,
  at,
  hide,
}: {
  chapter: ReturnType<typeof chronicleChapters>[number];
  at: ReturnType<typeof useAnchor>['at'];
  hide: () => void;
}) {
  return (
    <>
      <tr className="yrow">
        <td colSpan={7}>
          <div className="yrow__in">
            <b className="yrow__y">{chapter.year}</b>
            <span className="yrow__n">{chapter.count} 场</span>
            {chapter.ratedFrom === null || chapter.ratedTo === null ? null : (
              <span className="yrow__r">
                {fmt(chapter.ratedFrom)} → {fmt(chapter.ratedTo)}
              </span>
            )}
          </div>
        </td>
      </tr>
      {chapter.rows.map(({ row, point }) => (
        <tr className={row.star ? 'is-star' : undefined} key={`${row.contestId}-${point.index}`} onMouseEnter={at(chronTip(row, point))} onMouseLeave={hide}>
          <td className="chron__date">
            <b className="num">{dayOf(row.startAt)}</b>
            <span className="chron__idx">{`#${point.index + 1}`}</span>
          </td>
          <td>
            <div className="chron__race">
              {row.tier === null ? (
                <span className="tgtag">—</span>
              ) : (
                <span className={`tier tier--${row.tier}`}>{TIER_NAME[row.tier]}</span>
              )}
              {row.online ? <span className="tgtag">网络赛</span> : null}
              {row.star ? <span className="tgtag tgtag--star">打星</span> : null}
              <span className="chron__title">{row.title}</span>
            </div>
          </td>
          <td className="chron__team">{row.teamName}</td>
          {row.star ? (
            <td className="r chron__cell--star">—</td>
          ) : (
            <td className="r">
              <div className="chron__rank">
                <span>
                  <b className="num">{fmt(row.rank)}</b>
                  <span className="chron__slash">/</span>
                  <span className="num">{fmt(row.teams)}</span>
                </span>
                <span className="chron__sub">{rowPct(row) ?? '—'}</span>
              </div>
            </td>
          )}
          <td className="r">
            <b className="num">{row.solved}</b>
          </td>
          <td className={row.star ? 'r chron__cell--star' : 'r'}>{row.star ? '—' : <b className="num">{fmt(row.perf)}</b>}</td>
          <td className={row.star ? 'r chron__cell--star' : 'r'}>
            {row.star ? (
              '—'
            ) : (
              <>
                <b className="num">{fmt(row.ratingAfter)}</b>
                {point.delta === null ? null : <Delta text={deltaText(point.delta)} tone={point.delta ?? 0} />}
              </>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

/* ---------- 降级条 ---------- */

function XcpcDegrade({ status, onSync }: { status: XcpcStatusDto; onSync: () => void }) {
  const date = snapshotDate(status.snapshotAt);
  if (status.status === 'down') {
    return (
      <div className="alert alert--err rise" role="status">
        <Icon id="i-plug" />
        <div>
          <b>XCPC 快照暂不可达</b> · 下面是本地缓存（<code>{date}</code>）· 取不到的槽位显示 <b>—</b>
          <br />
          {status.error}
        </div>
        <button className="alert__x" onClick={onSync}>
          重试
        </button>
      </div>
    );
  }
  if (status.status === 'stale') {
    const days = snapshotDaysAgo(status.snapshotAt);
    return (
      <div className="alert alert--warn rise" role="status">
        <Icon id="i-warn" />
        <div>
          <b>{`快照已 ${days ?? '—'} 天未更新`}</b> · 社区版本仍是 <code>{date}</code> · 新档期以生成方时间为准
        </div>
        <button className="alert__x" onClick={onSync}>
          立即同步
        </button>
      </div>
    );
  }
  return null;
}

/* ---------- 长卷 ---------- */

interface Props {
  profile: XcpcProfileDto;
  status: XcpcStatusDto;
  /** 首次挂上这屏才播 count-up（与 CF / AT 一致） */
  firstPaint: boolean;
  notice: Notice | null;
  onSync: () => void;
}

export function XcpcDossier({ profile, status, firstPaint, notice, onSync }: Props) {
  const player = profile.player;
  const tl = useMemo(() => timeline(player.history), [player]);
  const animate = firstPaint;

  return (
    <div className="content cx" id="content-xcpc" role="tabpanel">
      {notice ? <NoticeBar {...notice} /> : null}
      <XcpcDegrade status={status} onSync={onSync} />

      <div className="dossier">
        <span className="dossier__tl" aria-hidden="true" />
        <Mast player={player} profile={profile} animate={animate} />
        <Vitrine player={player} />

        <section className="sect">
          <div className="sect__h">
            <span className="label label--pf">Trajectory</span>
            <h3 className="sect__t">rating 阶梯</h3>
            <span className="sect__rule" aria-hidden="true" />
            <span className="card__note">
              <b style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{fmt(tl.first)}</b> → <b>{fmt(tl.last)}</b> ·{' '}
              <Delta text={deltaText(tl.totalDelta)} tone={tl.totalDelta} />
            </span>
          </div>
          <Ridge tl={tl} animate={animate} />
          {tl.rated.length === 0 ? null : <div className="sect__foot">悬停看日期与名次</div>}
        </section>

        <Banners player={player} />
        <Chronicle player={player} />

        <footer className="dossier__foot">
          来源 xcpcrating 社区数据（非官方）· 官方榜单口径 · 数据版本 {snapshotDate(profile.snapshotAt)}
        </footer>
      </div>
    </div>
  );
}
