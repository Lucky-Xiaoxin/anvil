/**
 * 回放榜（docs/16 §5.2 / §5.3）：s2 跟比赛时钟，s3 跟时间轴滑条 —— 榜体同一份。
 *
 * 走钟每秒一次，但**榜只在分钟滚过的那一刻重建**（§4 性能口径）：356 队 × 13 题
 * 每秒重排全表是不可接受的，而读数本来就是分钟粒度。行组件 memo 化，
 * 于是 hover / 弹层 / 计时跳动都不会带着整张表重渲。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getArenaContest } from '../../api.ts';
import { clockHMS, clockHM, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { useTip } from '../../tip.tsx';
import {
  buildBoard,
  buildModel,
  capAt,
  elapsedOf,
  finish as finishSession,
  inFreezeWindow,
  minutesOf,
  pause as pauseSession,
  startSession,
  subsUntil,
  tick,
  toMs,
  unpause as unpauseSession,
  type Board,
  type BoardRow,
  type Cell,
  type ContestModel,
  type Session,
  type SrkSolution,
  type TeamModel,
} from './engine.ts';
import type { LeafRow } from './catalog.ts';
import { Popover, PopShell, resClass, type Anchor } from './pops.tsx';
import { clearSession, loadSession, saveSession, type Store } from './session.ts';

interface Props {
  row: LeafRow;
  /** false = 从目录「查看终榜」或结束后进回顾；true = 「开始模拟」开钟 */
  live: boolean;
  store: Store;
  onBack: () => void;
}

type Load = { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'ready'; model: ContestModel };

interface Pop {
  anchor: Anchor;
  kind: 'sub';
  ti: number;
  p: number;
}

interface PopTeam {
  anchor: Anchor;
  kind: 'team';
  ti: number;
}

const pct = (ms: number, dur: number): string => `${(ms / dur) * 100}%`;

export function ArenaBoard({ row, live, store, onBack }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [session, setSession] = useState<Session | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [review, setReview] = useState(!live);
  const [onlyFormal, setOnlyFormal] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [pop, setPop] = useState<Pop | PopTeam | null>(null);
  const { show, hide } = useTip();

  /* ---------- 取数：进回放才拉那 1.5MB ---------- */
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const res = await getArenaContest(row.path);
        if (cancel) return;
        const model = buildModel(res.data as Parameters<typeof buildModel>[0]);
        setLoad({ kind: 'ready', model });
      } catch (err) {
        if (!cancel) setLoad({ kind: 'error', text: messageOf(err) });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [row.path]);

  /* ---------- 会话：有记录就续钟，没有就开新钟 ---------- */
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const duration = load.model.duration;
    const prev = loadSession(store, row.path);
    if (prev === null) {
      const s = { ...startSession(Date.now()), durationMs: duration };
      /*
       * 「查看终榜」不是「开始模拟」：没有钟在走，就不落会话记录 ——
       * 否则目录那一行会凭空挂上「回放中」，而它其实只是被人看了一眼终榜。
       */
      if (live) {
        setSession(s);
        setReview(false);
        saveSession(store, row.path, s);
      } else {
        setSession(finishSession(s, duration));
        setReview(true);
      }
      return;
    }
    const withDur: Session = { ...prev, durationMs: duration };
    if (live && !prev.hold) setResumed(true);
    setSession(withDur);
    setReview(prev.hold && prev.ended ? true : !live);
    saveSession(store, row.path, withDur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind === 'ready' ? load.model.duration : 0, row.path]);

  /* ---------- 走钟：每秒一次，分钟才重建 ---------- */
  useEffect(() => {
    if (session === null || load.kind !== 'ready') return;
    const duration = load.model.duration;
    let s = session;
    const run = (): void => {
      const next = tick(s, duration, Date.now());
      s = next.session;
      setElapsed(next.elapsed);
      if (next.session !== session) {
        setSession(next.session);
        saveSession(store, row.path, next.session);
      }
    };
    run();
    const id = window.setInterval(run, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.started, session?.hold, session?.durationMs, load.kind === 'ready']);

  const model = load.kind === 'ready' ? load.model : null;
  const duration = model?.duration ?? 0;
  const viewMs = review ? (session?.scrubMs ?? duration) : elapsed;
  const inFrz = model !== null && !review && inFreezeWindow(elapsed, duration, model.freezeStart);

  /* 分钟滚过才重建（回顾模式由滑条驱动，本来就是分钟粒度） */
  const minuteKey = `${minutesOf(viewMs)}|${onlyFormal}|${review ? 'r' : 'l'}|${Math.min(1, viewMs >= duration ? 1 : 0)}`;
  const board: Board | null = useMemo(
    () => (model === null ? null : buildBoard(model, review ? viewMs : Math.min(viewMs, duration), onlyFormal)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, minuteKey],
  );

  /* ---------- 操作 ---------- */
  const patch = useCallback(
    (next: Session): void => {
      setSession(next);
      if (next.ended && next.hold) clearSession(store, row.path);
      else saveSession(store, row.path, next);
    },
    [row.path, store],
  );

  const togglePause = (): void => {
    if (session === null || model === null) return;
    const e = elapsedOf(session, model.duration, Date.now());
    patch(session.paused ? unpauseSession(session, e, Date.now()) : pauseSession(session, e));
  };

  const end = (): void => {
    if (session === null || model === null) return;
    patch(finishSession(session, model.duration));
    setReview(true);
    setResumed(false);
    setElapsed(model.duration);
  };

  const scrub = (minutes: number): void => {
    if (session === null || model === null) return;
    patch({ ...session, scrubMs: minutes * 60_000 });
  };

  const jump = (to: '0' | 'freeze' | 'end'): void => {
    if (model === null) return;
    scrub(to === '0' ? 0 : to === 'end' ? minutesOf(model.duration) : minutesOf(model.freezeStart) + 1);
  };

  /* ---------- 弹层 ---------- */
  useEffect(() => {
    if (pop === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pop]);

  const openCellPop = (ev: React.MouseEvent, ti: number, p: number): void => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind: 'sub', ti, p, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  };
  const openTeamPop = (ev: React.MouseEvent, ti: number): void => {
    const r = (ev.currentTarget as HTMLElement).closest('.brow')?.getBoundingClientRect();
    if (r === undefined) return;
    setPop({ kind: 'team', ti, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  };

  if (load.kind === 'error') {
    return (
      <div className="content">
        <div className="catwrap">
          <div className="alert alert--err">
            <Icon id="i-plug" />
            <div>
              <b>榜单拉取失败</b> · {load.text} · 本地没有这一场的缓存
            </div>
            <button className="alert__x" onClick={onBack}>
              回目录
            </button>
          </div>
          <p className="hint">
            不拿假数填空 · 取不到就空着。已缓存过的场次即使 CDN 不可达也照常回放（docs/16 §2.1）。
          </p>
        </div>
      </div>
    );
  }

  if (model === null || board === null || session === null) {
    return (
      <div className="content">
        <div className="catwrap">
          <div className="skel">
            <i />
            正在拉取本场榜单 <code>official/…</code>（约 1.5 MB）…
          </div>
        </div>
      </div>
    );
  }

  const frozen = board.cap < viewMs || inFrz;
  const freezeLabel = clockHM(model.freezeStart);
  const nameTip = {
    x: 0,
    y: 0,
    date: model.title,
    value: row.name === '' ? row.path : `${row.date} ${row.name}`.trim(),
    zero: false,
    valueClass: 'is-dim',
    sub: [
      `开赛 ${model.startAt}`,
      `封榜 ${freezeLabel}（${model.freezeDeclared ? '本场声明' : '本场未声明 · 按缺省最后 60 分钟'}）`,
      `时长 ${clockHM(duration)} · ${model.teams.length} 队（正式 ${model.teams.filter((t) => !t.star).length} · 打星 ${model.teams.filter((t) => t.star).length}）`,
    ],
  };

  return (
    <>
      <div className="topbar">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <Icon id="i-chev" className="flip" />
          回到目录
        </button>
        <span aria-hidden="true" className="vsep" />
        <h2
          className="rbname"
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            show({ ...nameTip, x: r.left + Math.min(r.width / 2, 180), y: r.bottom, below: true });
          }}
          onMouseLeave={hide}
        >
          {model.title}
        </h2>
        {review ? (
          <span className={`pill pill--over${viewMs >= duration ? '' : ' is-mid'}`}>
            {viewMs >= duration ? '终榜回顾' : inFreezeWindow(viewMs, duration, model.freezeStart) ? '回顾 · 封榜段' : '回顾模式'}
          </span>
        ) : (
          <>
            <span className={`clock${session.paused ? ' is-paused' : ''}`}>
              <i className={`dot ${session.paused || elapsed >= duration ? 'dot--idle' : 'dot--live'}`} />
              <b>{clockHMS(elapsed)}</b>
            </span>
            <span className="transport">
              <button className="tbtn" aria-label={session.paused ? '继续' : '暂停'} title={session.paused ? '继续' : '暂停'} onClick={togglePause}>
                <Icon id={session.paused ? 'i-play' : 'i-pause'} />
              </button>
              <button className="tbtn" aria-label="结束模拟" title="结束模拟" onClick={end}>
                <Icon id="i-stop" />
              </button>
            </span>
            {inFrz ? <span className="pill">封榜中 · 剩 {clockHMS(duration - elapsed)}</span> : null}
            {session.paused ? <span className="pill">已暂停</span> : null}
          </>
        )}
        <span className="topbar__spacer" />
        <label className="switch">
          <input type="checkbox" checked={onlyFormal} onChange={(e) => setOnlyFormal(e.target.checked)} />
          仅正式队
        </label>
      </div>

      <div className="content content--fit">
        <div className="simcol">
          {resumed && !review ? (
            <div className="alert alert--ok">
              <Icon id="i-check" />
              <div>
                会话已续 · 从 <code>{clockHMS(elapsed)}</code> 接着走（刷新按开始时刻续钟）
              </div>
              <button className="alert__x" onClick={() => setResumed(false)}>
                知道了
              </button>
            </div>
          ) : null}

          {review ? (
            <div className="scrub">
              <span className="scrub__lab">回放</span>
              <span className="scrub__t" style={{ color: viewMs > model.freezeStart ? undefined : 'var(--accent-2)' }}>
                {clockHMS(viewMs)}
              </span>
              <span className="tl">
                <span className="tl__rail" />
                <span className="tl__fill" style={{ width: pct(viewMs, duration) }} />
                <span className="tl__frz" style={{ left: pct(model.freezeStart, duration), right: 0 }} />
                <span className="tl__mk" style={{ left: pct(model.freezeStart, duration) }}>
                  <span>封榜 {freezeLabel}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={minutesOf(duration)}
                  step={1}
                  value={minutesOf(viewMs)}
                  aria-label="时间轴"
                  onChange={(e) => scrub(Number(e.target.value))}
                />
              </span>
              <span className="scrub__acts">
                <button className="btn btn--xs btn--ghost" onClick={() => jump('0')}>
                  起点
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => jump('freeze')}>
                  封榜
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => jump('end')}>
                  终榜
                </button>
              </span>
            </div>
          ) : null}

          <div className="boardwrap" style={{ ['--np' as string]: model.problems.length }}>
            {inFrz ? (
              <div
                className="frost"
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  show({
                    x: r.left + 220,
                    y: r.bottom,
                    below: true,
                    date: `封榜段 = 最后 ${clockHM(duration - model.freezeStart)}`,
                    value: `定格在 ${freezeLabel}`,
                    zero: false,
                    valueClass: 'is-dim',
                    sub: ['段内提交只显时刻与次数，判名显示 ?', `名次与罚时定格在 ${freezeLabel} · 终局自动解封`],
                  });
                }}
                onMouseLeave={hide}
              >
                <Icon id="i-noflag" />
                <span>
                  封榜中 · 名次定格在 <b>{freezeLabel}</b>
                </span>
                <span className="frost__r">
                  结果未知 {board.frzCells} 格 · 涉及 {board.frozenRows} 队
                </span>
              </div>
            ) : null}

            <div className="boardscroll" onMouseLeave={hide}>
              <div className="brow bhead">
                <div
                  className="h-r"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({
                      x: r.left + 40,
                      y: r.bottom,
                      below: true,
                      date: '名次 R#',
                      value: model.bands.length > 0 ? `金银铜 ${model.bands.map((b) => b.upTo).join(' / ')}` : '本场无奖牌规则',
                      zero: model.bands.length === 0,
                      sub: ['全场位置 · 打星队占位不计奖牌', '并列同名次、其后跳号'],
                    });
                  }}
                >
                  R#
                </div>
                <div
                  className="h-s"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 20, y: r.bottom, below: true, date: '学校排名 S#', value: '每校头队', zero: false, sub: ['只标各校最好的一支', '打星队不计'] });
                  }}
                >
                  S#
                </div>
                <div className="h-org">Organization</div>
                <div className="h-team">Team</div>
                <div
                  className="h-sol"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 24, y: r.bottom, below: true, date: '过题 Slv', value: frozen ? `定格在 ${freezeLabel}` : '实时', zero: false, sub: [`封榜段内定格在 ${freezeLabel}`] });
                  }}
                >
                  Slv
                </div>
                <div
                  className="h-pen"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 30, y: r.bottom, below: true, date: '罚时 Pen', value: 'AC 分钟 + 20 × 失败', zero: false, sub: ['过题前的失败次数', 'CE 不罚'] });
                  }}
                >
                  Pen
                </div>
                {model.problems.map((p, i) => (
                  <ProblemHead key={p.alias ?? i} problem={p} col={board.col[i] ?? { ac: 0, sub: 0, frz: 0 }} rows={board.rows.length} cap={board.cap} model={model} board={board} index={i} />
                ))}
              </div>

              {board.rows.map((r) => (
                <BoardRowView
                  key={r.ti}
                  row={r}
                  team={model.teams[r.ti] as TeamModel}
                  problems={model.problems}
                  model={model}
                  onCell={openCellPop}
                  onTeam={openTeamPop}
                />
              ))}
            </div>

            <div className="board__foot">
              <span>
                榜上 <b>{board.rows.length}</b> 队 · 累计过题 <b>{board.solvedTotal}</b>
              </span>
              <span className="spacer" />
              <span className="key">
                <span className="key__i">
                  <i className="key__s key__s--pen">−</i>罚时
                </span>
                <span className="key__i">
                  <i className="key__s key__s--ac">✓</i>AC
                </span>
                <span className="key__i">
                  <i className="key__s key__s--fb">✦</i>首杀
                </span>
                <span className="key__i">
                  <i className="key__s key__s--frz">?</i>冻结
                </span>
                <span className="key__i">
                  <i className="key__s key__s--post" />封榜后
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {pop !== null ? (
        <Popover anchor={pop.anchor} viewport={{ w: window.innerWidth, h: window.innerHeight }} onClose={() => setPop(null)}>
          {pop.kind === 'sub' ? (
            <SubPop model={model} ti={pop.ti} p={pop.p} viewMs={viewMs} cap={board.cap} />
          ) : (
            <TeamPop model={model} ti={pop.ti} board={board} />
          )}
        </Popover>
      ) : null}
    </>
  );
}

/* ---------- 列头 ---------- */

const ProblemHead = memo(function ProblemHead({
  problem,
  col,
  rows,
  cap,
  model,
  board,
  index,
}: {
  problem: ContestModel['problems'][number];
  col: { ac: number; sub: number; frz: number };
  rows: number;
  cap: number;
  model: ContestModel;
  board: Board;
  index: number;
}) {
  const { show, hide } = useTip();
  const fb = board.rows.find((r) => r.cells[index]?.st === 'fb');
  return (
    <div
      className={`ph${col.ac === 0 ? ' is-zero' : ''}`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        show({
          x: r.left + r.width / 2,
          y: r.bottom,
          below: true,
          date: `${problem.alias ?? ''} · ${problem.title ?? ''}`,
          value: `${col.ac} / ${rows} 队过`,
          zero: col.ac === 0,
          sub: [
            fb ? `首杀 ${model.teams[fb.ti]?.org ?? ''} · ${minutesOf(fb.cells[index]?.t ?? 0)}′` : cap >= model.duration ? '全场无人通过' : '尚无通过',
            `交 ${col.sub} 次`,
            col.frz > 0 ? `另有 ${col.frz} 格封榜未定` : '',
          ].filter((s) => s !== ''),
        });
      }}
      onMouseLeave={hide}
    >
      <b>{problem.alias}</b>
      <i>{col.ac}</i>
    </div>
  );
});

/* ---------- 一行 ---------- */

interface RowProps {
  row: BoardRow;
  team: TeamModel;
  problems: ContestModel['problems'];
  model: ContestModel;
  onCell: (ev: React.MouseEvent, ti: number, p: number) => void;
  onTeam: (ev: React.MouseEvent, ti: number) => void;
}

function BoardRowView(props: RowProps) {
  const { row, team, problems, model, onCell, onTeam } = props;
  const { show, hide } = useTip();

  const cellNodes = row.cells.map((c, p) => (
    <CellView key={p} cell={c} ti={team.ti} p={p} problem={problems[p] ?? {}} row={row} team={team} freezeStart={model.freezeStart} onCell={onCell} />
  ));

  const teamTip = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    show({
      x: r.left + Math.min(r.width / 2, 150),
      y: r.top,
      date: `${team.name} · ${team.org}`,
      value: `第 ${row.rank} 名 · 过 ${row.solved} 题 · 罚时 ${row.pen}`,
      zero: false,
      valueClass: row.medal ? `is-${row.medal}` : 'is-dim',
      sub: [`机位 #${team.seat}${row.star ? ' · 打星不占奖牌' : row.medal ? ` · ${row.medalTitle}` : ' · 正式队'}`, '点击查看队员'],
    });
  };

  return (
    <div
      className={`brow brow--body${row.medal ? ` m-${row.medal}` : ''}${row.star ? ' is-star' : ''}`}
      onMouseEnter={teamTip}
      onMouseLeave={hide}
      onClick={(e) => {
        hide();
        onTeam(e, team.ti);
      }}
    >
      <div className="c-r">
        <b>{row.rank}</b>
      </div>
      <div className="c-s">{row.srank === '' ? '' : <b>{row.srank}</b>}</div>
      <div className="c-org">{team.org}</div>
      <div className="c-team">
        <span className="c-team__n">{team.name}</span>
        {row.star ? <span className="c-team__star">★</span> : null}
      </div>
      <div className="c-sol">
        <b>{row.solved}</b>
      </div>
      <div className="c-pen">
        <b>{row.pen}</b>
      </div>
      {cellNodes}
    </div>
  );
}

const CellView = memo(function CellView({
  cell,
  ti,
  p,
  problem,
  row,
  team,
  freezeStart,
  onCell,
}: {
  cell: Cell;
  ti: number;
  p: number;
  problem: ContestModel['problems'][number];
  row: BoardRow;
  team: TeamModel;
  freezeStart: number;
  onCell: (ev: React.MouseEvent, ti: number, p: number) => void;
}) {
  const { show, hide } = useTip();
  if (cell.st === 'none') return <div className="pcell is-none" />;

  const readout = (): { value: string; cls: string } => {
    if (cell.st === 'ac') return { value: `AC ${minutesOf(cell.t)}′ ×${cell.n}${cell.post ? ' · 封榜后' : ''}`, cls: 'is-ok' };
    if (cell.st === 'fb') return { value: `首杀 ${minutesOf(cell.t)}′${cell.post ? ' · 封榜后' : ''}`, cls: 'is-ok' };
    if (cell.st === 'pen') return { value: `未过 −${cell.n} · 末次 ${minutesOf(cell.t)}′${cell.post ? ' · 封榜后' : ''}`, cls: 'is-bad' };
    if (cell.st === 'ce') return { value: `CE · 不罚 · ${minutesOf(cell.t)}′`, cls: 'is-zero' };
    return { value: `封榜 ?${cell.n} · 末次 ${minutesOf(cell.t)}′`, cls: 'is-zero' };
  };
  const tip = readout();
  const sub: string[] = [];
  if (cell.post) sub.push('发生在封榜段 · 不计入定格名次');
  sub.push(`${team.name} · 第 ${row.rank} 名`);
  sub.push('点击查看逐次提交');

  return (
    <div
      className={`pcell is-${cell.st} is-hit${cell.post ? ' is-post' : ''}`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        show({ x: r.left + r.width / 2, y: r.top, date: `${problem.alias ?? ''} · ${problem.title ?? ''}`, value: tip.value, zero: tip.cls === 'is-zero', valueClass: tip.cls, sub });
      }}
      onMouseLeave={hide}
      onClick={(e) => {
        e.stopPropagation();
        hide();
        onCell(e, ti, p);
      }}
    >
      <span className="pcell__b">
        <span className="pcell__t">{minutesOf(cell.t)}</span>
        <span className="pcell__n">{cell.st === 'ac' ? (cell.n > 1 ? `×${cell.n}` : '') : cell.st === 'fb' ? 'FB' : cell.st === 'pen' ? `−${cell.n}` : cell.st === 'ce' ? 'CE' : `?${cell.n}`}</span>
        {cell.post ? <i className="pcell__dot" /> : null}
      </span>
    </div>
  );
});

/* ---------- 弹层内容 ---------- */

function SubPop({ model, ti, p, viewMs, cap }: { model: ContestModel; ti: number; p: number; viewMs: number; cap: number }) {
  const team = model.teams[ti];
  const problem = model.problems[p];
  if (team === undefined || problem === undefined) return null;
  const list = subsUntil(team.subs[p] ?? [], viewMs, cap);
  const fb = team.subs[p]?.find((x) => x.result === 'FB');
  const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: `${team.name} @${team.org}${fb !== undefined && toCap(fb) <= cap ? ' · 本题首杀' : ''}` };
  return (
    <PopShell head={head}>
      {list.length === 0 ? (
        <div className="hint">本场未提交。</div>
      ) : (
        <>
          {list.map((x, i) => (
            <div className="pop__row" key={i}>
              <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.frozen ? 'Frozen' : x.r}</span>
              <span className="pop__tm num">{clockHMS(x.t)}</span>
              <span className="pop__lg">{x.language}</span>
            </div>
          ))}
          <div className="hint" style={{ marginTop: 8 }}>
            {viewMs > model.freezeStart && viewMs < model.duration ? '封榜段内结果未公开，一律显示 Frozen · ' : ''}
            罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）
          </div>
        </>
      )}
    </PopShell>
  );
}

const toCap = (x: SrkSolution): number => toMs(x.time);

function TeamPop({ model, ti, board }: { model: ContestModel; ti: number; board: Board }) {
  const team = model.teams[ti];
  if (team === undefined) return null;
  const row = board.rows.find((r) => r.ti === ti);
  const head = { title: team.name, sub: team.org };
  return (
    <PopShell head={head}>
      <div className="pop__who">
        {team.members.map((m, i) => (
          <div className="pop__p" key={i}>
            <span className="av">{m.slice(0, 1)}</span>
            <span>{m}</span>
          </div>
        ))}
      </div>
      <div className="pop__rule" />
      <div className="pop__kv">
        <span className="pop__k">Seat</span>
        <span className="pop__v num">#{team.seat}</span>
      </div>
      <div className="pop__kv">
        <span className="pop__k">状态</span>
        <span className="pop__v">{team.star ? <span className="tgtag">打星</span> : row?.medal ? `${row.medalTitle}` : '正式队'}</span>
      </div>
    </PopShell>
  );
}
