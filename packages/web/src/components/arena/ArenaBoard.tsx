/**
 * 回放榜（docs/contracts/16 §5.2 / §5.3）：s2 跟比赛时钟，s3 跟时间轴滑条 —— 榜体同一份。
 *
 * 走钟每秒一次，但**榜只在分钟滚过的那一刻重建**（§4 性能口径）：356 队 × 13 题
 * 每秒重排全表是不可接受的，而读数本来就是分钟粒度。行组件 memo 化，
 * 于是 hover / 弹层 / 计时跳动都不会带着整张表重渲。
 *
 * v7 起这份榜体还多一行「我的成绩」幽灵（docs/contracts/20 §2）：顶栏常驻入口 + 录入面板
 * （`GhostPanel.tsx`）+ 引擎侧占名额注入；幽灵签名拼进 `minuteKey`，改了数字才重建得到。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkArenaRecordDto } from '@anvil/shared';
import { ApiError, getArenaContest, saveWorkArenaRecord } from '../../api.ts';
import { clockHMS, clockHM, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { useTip } from '../../tip.tsx';
import {
  bandRanges,
  buildBoard,
  buildModel,
  capAt,
  elapsedOf,
  finish as finishSession,
  inFreezeWindow,
  minutesOf,
  problemHeadState,
  type HeadState,
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
  type GhostSub,
  type Session,
  type SrkSolution,
  type TeamModel,
} from './engine.ts';
import type { LeafRow } from './catalog.ts';
import { GhostPanel } from './GhostPanel.tsx';
import { Popover, PopShell, resClass, type Anchor } from './pops.tsx';
import { arenaTitleOf, ghostToRecord, recordToGhost } from './record.ts';
import { clearGhost, clearSession, loadGhost, loadSession, saveGhost, saveSession, type GhostData, type Store } from './session.ts';

interface Props {
  row: LeafRow;
  /** false = 从目录「查看终榜」或结束后进回顾；true = 「开始模拟」开钟 */
  live: boolean;
  store: Store;
  onBack: () => void;
  /** 从工坊「回到回放」带进来的 record.json：幽灵、回顾位置与封榜视角以它为准 */
  initialRecord?: WorkArenaRecordDto | null;
}

type Load = { kind: 'loading' } | { kind: 'error'; text: string; missing: boolean } | { kind: 'ready'; model: ContestModel };

/** 三个弹层（docs/contracts/16 §5.2 + docs/contracts/20 §2.3）：提交明细 / 队伍 / 「我的成绩」面板 */
type Pop =
  | { anchor: Anchor; kind: 'sub'; ti: number; p: number }
  | { anchor: Anchor; kind: 'team'; ti: number }
  | { anchor: Anchor; kind: 'ghost' };

const pct = (ms: number, dur: number): string => `${(ms / dur) * 100}%`;

/** 幽灵签名：拼进 minuteKey，改了逐发就重建榜（不然只有分钟滚过才动） */
const ghostSig = (g: GhostData | null): string =>
  g === null
    ? 'none'
    : `${g.show ? 1 : 0}|${g.subs.map((s) => `${s.p}:${s.t}:${s.r}`).join(',')}`;

export function ArenaBoard({ row, live, store, onBack, initialRecord = null }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  /** 手动重试计数：CDN 暂时取不到时，界面上那一脚重试比回目录再进来快 */
  const [tryNo, setTryNo] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [review, setReview] = useState(initialRecord === null ? !live : initialRecord.view.mode === 'review');
  const [onlyFormal, setOnlyFormal] = useState(false);
  /** 回顾模式的封榜视角：默认关 = 解封视界（去回顾先给结果）；开 = 定格回看（封榜段只显 ?） */
  const [frozenView, setFrozenView] = useState(initialRecord?.view.frozenView ?? false);
  const [resumed, setResumed] = useState(false);
  /** 「我的成绩」的录入（docs/contracts/20 §2.1）：每场一条；从工坊带 record 时以 record 为准 */
  const initialGhost = initialRecord === null ? null : recordToGhost(initialRecord.ghost);
  const [ghost, setGhost] = useState<GhostData | null>(initialGhost ?? loadGhost(store, row.path));
  const restoredRef = useRef(initialRecord !== null);
  const [saveState, setSaveState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  /** 榜体滚动容器：顶栏读数「跳到自己」用它定位那一行 */
  const boardBox = useRef<HTMLDivElement | null>(null);
  const { show, hide } = useTip();

  /* ---------- 取数：进回放才拉那 1.5MB；失败给重试（jsDelivr 冷缓存会暂时 403） ---------- */
  useEffect(() => {
    let cancel = false;
    setLoad({ kind: 'loading' });
    void (async () => {
      try {
        const res = await getArenaContest(row.path);
        if (cancel) return;
        const model = buildModel(res.data as Parameters<typeof buildModel>[0]);
        if (model.duration <= 0) {
          setLoad({ kind: 'error', text: '本场快照的时长读不懂，无法回放', missing: false });
          return;
        }
        setLoad({ kind: 'ready', model });
      } catch (err) {
        if (cancel) return;
        const missing = err instanceof ApiError && err.kind === 'not-found';
        setLoad({ kind: 'error', text: messageOf(err), missing });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [row.path, tryNo]);

  /* ---------- 会话：有记录就续钟，没有就开新钟 ---------- */
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const duration = load.model.duration;
    if (restoredRef.current) {
      restoredRef.current = false;
      if (initialRecord !== null) {
        const viewMs = Math.max(0, Math.min(duration, initialRecord.view.viewMs));
        if (initialRecord.view.mode === 'review') {
          // 存档是回顾：停在保存位置，不落 localStorage 会话（避免目录误挂「回放中」）
          setSession({
            ...startSession(Date.now()),
            durationMs: duration,
            hold: true,
            paused: false,
            ended: true,
            scrubMs: viewMs,
            at: viewMs,
          });
          setReview(true);
          setElapsed(viewMs);
          return;
        }
        const paused = initialRecord.view.paused;
        const restored: Session = {
          started: Date.now() - viewMs,
          hold: paused,
          paused,
          ended: false,
          scrubMs: viewMs,
          at: viewMs,
          durationMs: duration,
        };
        setSession(restored);
        setReview(false);
        setElapsed(viewMs);
        saveSession(store, row.path, restored);
        return;
      }
    }
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
  }, [load.kind === 'ready' ? load.model.duration : 0, row.path, initialRecord]);

  /* 从工坊带进来的幽灵写回 localStorage：目录行与面板此后按同一份数据走 */
  useEffect(() => {
    if (initialRecord !== null) saveGhost(store, row.path, recordToGhost(initialRecord.ghost));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        if (next.session.ended) {
          /*
           * 钟走到终点：照「结束」按钮的落点走 —— 落回顾屏并清会话记录。
           * `tick` 到点时已经把 at / scrubMs 摆到 duration，这里不用再动。
           * 少了这一步，榜冻在回放屏、滑条不出现，目录那行还会挂着「回放中 · 5:00:00」。
           */
          setReview(true);
          clearSession(store, row.path);
        } else {
          saveSession(store, row.path, next.session);
        }
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
  /*
   * 封榜带：live 照旧（封榜段内定格）；回顾只在「封榜视角」开着且滑条落在封榜段内时显示 ——
   * 解封视界下格子已经显示真实结果，再挂「结果未知 N 格」就是自相矛盾。
   */
  const inFrz =
    model !== null &&
    (review
      ? frozenView && inFreezeWindow(viewMs, duration, model.freezeStart)
      : inFreezeWindow(elapsed, duration, model.freezeStart));

  /*
   * 幽灵行是否入榜：「展示我」开着 **且** 至少录了一发（docs/contracts/20 §2.4 验收 2）。
   * v8 起每发都自带判名与时刻，有一发就是一行成绩，不必再判"有没有填过内容"。
   */
  const ghostSubs: GhostSub[] | null = ghost !== null && ghost.show && ghost.subs.length > 0 ? ghost.subs : null;

  /* 分钟滚过才重建（回顾模式由滑条驱动，本来就是分钟粒度；封榜视角开关与幽灵录入也要立即重建） */
  const minuteKey = `${minutesOf(viewMs)}|${onlyFormal}|${review ? 'r' : 'l'}|${frozenView ? 'fz' : 'un'}|${Math.min(1, viewMs >= duration ? 1 : 0)}|${ghostSig(ghost)}`;
  const board: Board | null = useMemo(
    () => (model === null ? null : buildBoard(model, review ? viewMs : Math.min(viewMs, duration), onlyFormal, review && !frozenView, ghostSubs)),
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

  /* 两个弹层回调必须稳定：每秒走钟会重渲本组件，回调一旦新建就打穿下面 `CellView` / `BoardRowView` 的 memo */
  const openCellPop = useCallback((ev: React.MouseEvent, ti: number, p: number): void => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind: 'sub', ti, p, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);
  const openTeamPop = useCallback((ev: React.MouseEvent, ti: number): void => {
    const r = (ev.currentTarget as HTMLElement).closest('.brow')?.getBoundingClientRect();
    if (r === undefined) return;
    setPop({ kind: 'team', ti, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);

  /* ---------- 「我的成绩」：每次输入即存即重建（docs/contracts/20 §2.3 响应）；清除 = 删键 + 面板留空 ---------- */
  const onGhostChange = useCallback(
    (next: GhostData): void => {
      setGhost(next);
      saveGhost(store, row.path, next);
      setSaveState('idle');
      setSaveErr(null);
    },
    [row.path, store],
  );

  const onGhostClear = useCallback((): void => {
    clearGhost(store, row.path);
    setGhost({ show: true, subs: [] });
    setSaveState('idle');
    setSaveErr(null);
  }, [row.path, store]);

  /** 把这份「我的成绩 + 当前回放位置」写进工坊：服务端按 arenaPath 找/建 contest，再写 record.json */
  const saveRecord = useCallback(async (): Promise<void> => {
    if (ghost === null || ghost.subs.length === 0 || session === null) return;
    setSaveState('busy');
    setSaveErr(null);
    try {
      await saveWorkArenaRecord({
        arenaPath: row.path,
        title: arenaTitleOf(row),
        ghost: ghostToRecord(ghost),
        view: {
          mode: review ? 'review' : 'live',
          viewMs: review ? viewMs : elapsed,
          paused: session.paused,
          frozenView,
        },
      });
      setSaveState('saved');
    } catch (err) {
      setSaveState('error');
      setSaveErr(messageOf(err));
    }
  }, [ghost, session, row, review, viewMs, elapsed, frozenView]);

  const openGhostPop = (ev: React.MouseEvent): void => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind: 'ghost', anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  };

  /* 顶栏读数点一下 = 滚到榜上那一行并闪一下（几百行的榜里，"我在哪"不该靠滚） */
  const jumpToGhost = useCallback((): void => {
    const el = boardBox.current?.querySelector<HTMLElement>('.brow.is-ghost') ?? null;
    if (el === null) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('is-jump');
    void el.offsetWidth; // 重启同名动画要先断开
    el.classList.add('is-jump');
  }, []);

  if (load.kind === 'error') {
    return (
      <>
        <div className="topbar">
          <button className="btn btn--ghost btn--sm" onClick={onBack}>
            <Icon id="i-chev" className="flip" />
            回到目录
          </button>
          <span aria-hidden="true" className="vsep" />
          <h2 className="rbname">{row.name}</h2>
          <span className="topbar__spacer" />
        </div>
        <div className="content">
          <div className="catwrap">
            <div className="alert alert--err">
              <Icon id="i-plug" />
              <div>
                {load.missing ? (
                  <b>上游没有这份榜单</b>
                ) : (
                  <>
                    <b>榜单拉取失败</b> · {load.text} · 本地没有这一场的缓存
                  </>
                )}
              </div>
              <button className="alert__x" onClick={() => setTryNo((n) => n + 1)}>
                重试
              </button>
            </div>
            <p className="hint">
              {load.missing
                ? '目录里有这一场，但快照仓库里取不到对应文件 —— 不做假数填空，取不到就是空。'
                : '两条源都试过还不通才算取不到，隔一两秒点重试通常就好；缓存过的场次断网也照常回放。'}
            </p>
          </div>
        </div>
      </>
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
  /*
   * 榜脚「榜上 N 队」与列头「过 N / N 队」的分母都不含幽灵（docs/contracts/20 §2.2 三排除）：
   * 它占名次，但不是场上的一支队。
   */
  const teamCount = board.rows.length - (board.ghostTeam ? 1 : 0);
  /* 顶栏读数那一行的数据：名次随时钟与封榜视角变，题数 / 罚时进 tooltip（榜上本来就有） */
  const ghostRow = board.ghostTeam === null || board.ghostTeam === undefined ? null : board.rows.find((r) => r.ghost === true) ?? null;
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
      model.approx ? '本场快照无逐次提交 · 榜按终局判名近似重建' : '',
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
        {/* 常驻读数（v8）：只在幽灵真在榜上时出现，「展示我」关或一发未录就整块消失、不占位 */}
        {ghostRow === null ? null : (
          <button
            className="ghrank"
            onClick={jumpToGhost}
            title={`我的成绩 · ${ghostRow.solved} 题 / ${ghostRow.pen} 罚时 · 点击跳到榜上那一行`}
          >
            <i className="dot dot--ok" />我 <b>第 {ghostRow.rank} 名</b>
          </button>
        )}
        {/* 「我的成绩」入口常驻顶栏（live 与回顾同一份顶栏）：不随数据出现/消失，每场长相一致 */}
        <button className="btn btn--ghost btn--sm" aria-label="我的成绩" title="我的成绩 · 录入 VP 成绩，看自己在榜上的位置" onClick={openGhostPop}>
          <Icon id="i-user" />
        </button>
        {ghost !== null && ghost.subs.length > 0 ? (
          <button
            className="btn btn--sm"
            disabled={saveState === 'busy'}
            title="保存到工坊 · 写入比赛对象的 record.json（逐发成绩 + 当前回放位置）"
            onClick={() => void saveRecord()}
          >
            <Icon id="i-save" />
            {saveState === 'busy' ? '保存中…' : saveState === 'saved' ? '已保存' : '保存'}
          </button>
        ) : null}
        {saveErr !== null ? (
          <span className="tb-err" title={saveErr}>
            {saveErr}
          </span>
        ) : null}
        {model.approx ? (
          <span
            className="pill"
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              show({
                x: r.left + r.width / 2,
                y: r.bottom,
                below: true,
                date: '近似榜',
                value: '本场快照没有逐次提交',
                zero: false,
                sub: ['榜按终局判名 + 次数重建，逐发时刻上游未记', '所以格子只在判名那一刻出现，中间过程看不到'],
              });
            }}
            onMouseLeave={hide}
          >
            近似回放
          </span>
        ) : null}
        {review ? (
          <label className="switch">
            <input type="checkbox" checked={frozenView} onChange={(e) => setFrozenView(e.target.checked)} />
            封榜视角
          </label>
        ) : null}
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
              <span className="scrub__t" style={{ color: viewMs > model.freezeStart ? '#B4C0CF' : 'var(--accent-2)' }}>
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
                  {review ? '定格视角' : '封榜中'} · 名次定格在 <b>{freezeLabel}</b>
                </span>
                <span className="frost__r">
                  结果未知 {board.frzCells} 格 · 涉及 {board.frozenRows} 队
                </span>
              </div>
            ) : null}

            <div className="boardscroll" ref={boardBox} onMouseLeave={hide}>
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
                      value: model.bands.length > 0 ? `奖牌 = 正式队 ${bandRanges(model.bands)}` : '本场无奖牌规则',
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
                  <ProblemHead key={p.alias ?? i} problem={p} col={board.col[i] ?? { ac: 0, sub: 0, frz: 0, postAc: 0 }} rows={teamCount} cap={board.cap} model={model} board={board} index={i} />
                ))}
              </div>

              {board.rows.map((r) => (
                <BoardRowView
                  key={r.ti}
                  row={r}
                  team={r.ghost ? board.ghostTeam! : model.teams[r.ti]!}
                  problems={model.problems}
                  model={model}
                  onCell={openCellPop}
                  onTeam={openTeamPop}
                />
              ))}
            </div>

            <div className="board__foot">
              <span>
                榜上 <b>{teamCount}</b> 队 · 累计过题 <b>{board.solvedTotal}</b>
              </span>
              <span className="spacer" />
              {/* 列头四档图例：区分度靠颜色，读法在这里给一次，别处不再写解释 */}
              <span className="key key--head">
                <span className="key__i">
                  <i className="phk is-quiet" />
                  无人提交
                </span>
                <span className="key__i">
                  <i className="phk is-pending" />
                  待定
                </span>
                <span className="key__i">
                  <i className="phk is-noone" />
                  交而没过
                </span>
                <span className="key__i">
                  <i className="phk is-any" />
                  有人过
                </span>
                <span className="key__i">
                  <i className="phk is-late" />
                  封榜后才解开
                </span>
              </span>
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
        <Popover
          anchor={pop.anchor}
          viewport={{ w: window.innerWidth, h: window.innerHeight }}
          onClose={() => setPop(null)}
          width={pop.kind === 'ghost' ? 330 : 270}
          height={pop.kind === 'ghost' ? 500 : 260}
          label={pop.kind === 'ghost' ? '我的成绩' : '明细'}
          cls={pop.kind === 'ghost' ? 'pop--panel' : undefined}
        >
          {pop.kind === 'sub' ? (
            <SubPop model={model} ti={pop.ti} p={pop.p} viewMs={viewMs} cap={board.cap} ghost={ghost} />
          ) : pop.kind === 'team' ? (
            <TeamPop model={model} ti={pop.ti} board={board} />
          ) : (
            <GhostPanel problems={model.problems} durationMs={duration} data={ghost} onChange={onGhostChange} onClear={onGhostClear} />
          )}
        </Popover>
      ) : null}
    </>
  );
}

/* ---------- 列头 ---------- */

const HEAD_HINT: Record<HeadState, string> = {
  quiet: '全场无人提交',
  pending: '封榜段内有活动 · 结果未定',
  noone: '有人交 · 无人过',
  any: '封榜前已有人过',
  late: '直到封榜后才被解开',
};

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
  col: Board['col'][number];
  rows: number;
  cap: number;
  model: ContestModel;
  board: Board;
  index: number;
}) {
  const { show, hide } = useTip();
  const fb = board.rows.find((r) => r.cells[index]?.st === 'fb');
  const state = problemHeadState(col);
  const fbText =
    fb !== undefined
      ? `首杀 ${model.teams[fb.ti]?.org || model.teams[fb.ti]?.name || '队伍信息未收录'} · ${minutesOf(fb.cells[index]?.t ?? 0)}′`
      : col.ac > 0
        ? '当前视图无首杀'
        : cap >= model.duration
          ? '全场无人通过'
          : '尚无通过';
  return (
    <div
      className={`ph is-${state}`}
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
            HEAD_HINT[state],
            `交 ${col.sub} 次`,
            fbText,
            col.frz > 0 ? `另有 ${col.frz} 格封榜未定` : '',
            col.postAc > 0 && col.postAc < col.ac ? `其中 ${col.postAc} 队封榜后才过` : '',
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

const BoardRowView = memo(function BoardRowView(props: RowProps) {
  const { row, team, problems, model, onCell, onTeam } = props;
  const { show, hide } = useTip();

  const cellNodes = row.cells.map((c, p) => (
    <CellView key={p} cell={c} ti={team.ti} p={p} problem={problems[p] ?? {}} row={row} team={team} freezeStart={model.freezeStart} approx={model.approx} onCell={onCell} />
  ));

  const teamTip = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const title = team.name === '' ? team.org || '队伍信息未收录' : team.name;
    show({
      x: r.left + Math.min(r.width / 2, 150),
      y: r.top,
      date: team.org === '' || team.name === '' ? title : `${title} · ${team.org}`,
      value: `第 ${row.rank} 名 · 过 ${row.solved} 题 · 罚时 ${row.pen}`,
      zero: false,
      valueClass: row.medal ? `is-${row.medal}` : 'is-dim',
      /* 幽灵行没有机位可显示（`seat` 是「—」），小字改说录入来源 —— 别在 tip 里留个空 # */
      sub: row.ghost
        ? [`VP 手动录入${row.medal ? ` · ${row.medalTitle}` : ''}`, '点击看每题逐发']
        : [
            `机位 #${team.seat}${row.star ? ' · 打星不占奖牌' : row.medal ? ` · ${row.medalTitle}` : ' · 正式队'}`,
            team.members.length > 0 ? '点击查看队员' : '队员名单未收录 · 点击看队伍信息',
          ],
    });
  };

  return (
    <div
      className={`brow brow--body${row.medal ? ` m-${row.medal}` : ''}${row.star ? ' is-star' : ''}${row.ghost ? ' is-ghost' : ''}`}
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
        <span className={`c-team__n${row.ghost ? ' is-you' : ''}`}>{team.name}</span>
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
});

const CellView = memo(function CellView({
  cell,
  ti,
  p,
  problem,
  row,
  team,
  freezeStart,
  approx,
  onCell,
}: {
  cell: Cell;
  ti: number;
  p: number;
  problem: ContestModel['problems'][number];
  row: BoardRow;
  team: TeamModel;
  freezeStart: number;
  approx: boolean;
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
  sub.push(approx ? '点击查看判名与次数' : '点击查看逐次提交');

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

function SubPop({ model, ti, p, viewMs, cap, ghost }: { model: ContestModel; ti: number; p: number; viewMs: number; cap: number; ghost: GhostData | null }) {
  const problem = model.problems[p];
  /*
   * 幽灵行（`ti === -1`）：数据只在 `ghost` 里，**绝不查 `model.teams[-1]`**。
   * v8 起逐发都带判名与时刻，明细与真队同一套行式（封榜段内一样显 Frozen），不再另造读法。
   */
  if (ti === -1) {
    if (problem === undefined) return null;
    const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: '你 @我的成绩' };
    const rows = (ghost?.subs ?? [])
      .filter((s) => s.p === p && s.t * 60_000 <= viewMs)
      .sort((a, b) => a.t - b.t)
      .map((s) => ({ r: s.r, t: s.t * 60_000, frozen: s.t * 60_000 > cap }));
    return (
      <PopShell head={head}>
        {rows.length === 0 ? (
          <div className="hint">本题还没录。</div>
        ) : (
          <>
            {rows.map((x, i) => (
              <div className="pop__row" key={i}>
                <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.frozen ? 'Frozen' : x.r}</span>
                <span className="pop__tm num">{clockHMS(x.t)}</span>
                <span className="pop__lg">手动录入</span>
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
  const team = model.teams[ti];
  if (team === undefined || problem === undefined) return null;
  const list = subsUntil(team.subs[p] ?? [], viewMs, cap, team.verdicts[p]);
  /* 终局判名不是 FB 时，solutions 里残留的 FB 是重判前的旧标记，别拿它说「本题首杀」 */
  const verdict = team.verdicts[p];
  const fb = verdict === undefined || verdict === 'FB' ? team.subs[p]?.find((x) => x.result === 'FB') : undefined;
  const who = team.name === '' ? team.org || '队伍信息未收录' : team.org === '' ? team.name : `${team.name} @${team.org}`;
  const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: `${who}${fb !== undefined && toCap(fb) <= cap ? ' · 本题首杀' : ''}` };
  /*
   * 没有逐次提交时：只要这题有终局摘要就按摘要回吐，不能按整场 `approx` 一刀切。
   * 混合快照里也可能只有某队/某题缺 `solutions[]`；这里显示「本场未提交」会和格子自相矛盾。
   */
  if (list.length === 0) {
    const s = team.summaries[p];
    if (s === undefined || s.t > viewMs) return <PopShell head={head}><div className="hint">本场未提交。</div></PopShell>;
    const shown = s.unknown || s.t > cap;
    return (
      <PopShell head={head}>
        <div className="pop__row">
          <span className={shown ? 'res res--frz' : s.accepted ? 'res res--ac' : 'res res--bad'}>{shown ? 'Frozen' : s.accepted ? (s.fb ? 'FB' : 'AC') : '未过'}</span>
          <span className="pop__tm num">{clockHMS(s.t)}</span>
          <span className="pop__lg">{s.tries} 发</span>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>这题没有逐次提交记录，只有终局判名与总次数。</div>
      </PopShell>
    );
  }
  return (
    <PopShell head={head}>
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
    </PopShell>
  );
}

const toCap = (x: SrkSolution): number => toMs(x.time);

function TeamPop({ model, ti, board }: { model: ContestModel; ti: number; board: Board }) {
  const row = board.rows.find((r) => r.ti === ti);
  /* 幽灵行：队伍是引擎合成的（`board.ghostTeam`），队员与机位都没有 —— 一行说明代替 */
  if (ti === -1) {
    const g = board.ghostTeam;
    if (g === null || g === undefined) return null;
    return (
      <PopShell head={{ title: g.name, sub: g.org }}>
        <div className="pop__who">
          <div className="hint">VP 成绩手动录入，点格子看每题明细。</div>
        </div>
        <div className="pop__rule" />
        <div className="pop__kv">
          <span className="pop__k">Seat</span>
          <span className="pop__v num">{g.seat}</span>
        </div>
        <div className="pop__kv">
          <span className="pop__k">状态</span>
          <span className="pop__v">{row?.medal ? row.medalTitle : '正式队'}</span>
        </div>
      </PopShell>
    );
  }
  const team = model.teams[ti];
  if (team === undefined) return null;
  const title = team.name === '' ? team.org || '队伍信息未收录' : team.name;
  const head = { title, sub: team.name === '' || team.org === '' ? '' : team.org };
  return (
    <PopShell head={head}>
      <div className="pop__who">
        {team.members.length === 0 ? (
          <div className="hint">快照未收录队员名单。</div>
        ) : (
          team.members.map((m, i) => (
            <div className="pop__p" key={i}>
              <span className="av">{m.slice(0, 1)}</span>
              <span>{m}</span>
            </div>
          ))
        )}
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
