import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  DashboardDto,
  SourceId,
  StatusDto,
  SyncSourceId,
  SyncStateDto,
  SyncStatesDto,
} from '@anvil/shared';
import { getDashboard, getSyncStates, getStatus, startSync } from './api.ts';
import { messageOf, sleep } from './format.ts';
import { FLY, flyIn, flyNodes, flyOut, flySkipped } from './fly.ts';
import { AppShell, type View } from './components/AppShell.tsx';
import {
  ColdStart,
  Dashboard,
  LockedMaster,
  LockedVp,
  NoticeBar,
  Unconfigured,
  XcpcPlaceholder,
  type Notice,
} from './components/Dashboard.tsx';
import { Settings } from './components/Settings.tsx';
import { SourceTabs } from './components/SourceTabs.tsx';
import { Wizard } from './components/Wizard.tsx';
import { decideSwitch } from './switcher.ts';

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h === 'settings' || h === 'master' || h === 'vp' ? h : 'dashboard';
}

/** 服务端把任务丢了（进程重启）时，别把进度条永远挂在那儿 */
const IDLE_BEATS_BEFORE_GIVEUP = 3;

const nodeOf = (id: SourceId): HTMLElement | null => document.getElementById(`content-${id}`);

const patchStates = (all: SyncStatesDto, id: SyncSourceId, next: SyncStateDto): SyncStatesDto =>
  id === 'cf' ? { ...all, cf: next } : { ...all, at: next };

export function App() {
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [dashes, setDashes] = useState<Partial<Record<SyncSourceId, DashboardDto>>>({});
  const [states, setStates] = useState<SyncStatesDto | null>(null);
  const [today, setToday] = useState(() => new Date());
  const [view, setView] = useState<View>(viewFromHash);
  const [busy, setBusy] = useState<Record<SyncSourceId, boolean>>({ cf: false, at: false });
  const [delta, setDelta] = useState<{ source: SyncSourceId; stored: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  /** 真的挂在屏上的源；切换过程中它还是旧屏 */
  const [shown, setShown] = useState<SourceId>('cf');
  const shownRef = useRef<SourceId>('cf');
  const flyRef = useRef<{ anims: Animation[]; timer: number } | null>(null);
  const landRef = useRef(false);
  const seenRef = useRef<Set<SourceId>>(new Set());
  const scrollRef = useRef<Partial<Record<SourceId, number>>>({});
  const tabRefs = useRef<Partial<Record<SourceId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(
    () => () => {
      if (flyRef.current) {
        clearTimeout(flyRef.current.timer);
        for (const a of flyRef.current.anims) a.cancel();
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const s = await getStatus();
      const [cf, at] = await Promise.all([getDashboard('cf'), getDashboard('at')]);
      setStatus(s);
      setDashes({ cf, at });
      setToday(new Date());
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'err', text: `${messageOf(err)} · 只读本地缓存，不会再出网` });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 同步按源起跑：谁在跑只锁谁，AT 挂了不碍着 CF */
  const runSync = useCallback(
    async (source: SyncSourceId): Promise<SyncStateDto | null> => {
      if (busy[source]) return null;
      setBusy((b) => ({ ...b, [source]: true }));
      setNotice(null);
      setDelta(null);
      let final: SyncStateDto | null = null;
      try {
        let snap = await startSync(source);
        setStates(snap);
        let idleBeats = 0;
        while (snap[source].phase !== 'done' && snap[source].phase !== 'error') {
          await sleep(1000);
          snap = await getSyncStates();
          if (snap[source].phase === 'idle' && ++idleBeats >= IDLE_BEATS_BEFORE_GIVEUP) {
            snap = patchStates(snap, source, {
              ...snap[source],
              phase: 'error',
              error: '同步中断：本地服务重启过，再点一次同步',
            });
          }
          if (snap[source].phase !== 'idle') idleBeats = 0;
          setStates(snap);
        }
        final = snap[source];
        if (final.phase === 'error') {
          setNotice({ kind: 'err', text: `${final.error ?? '同步失败'} · 本地缓存的数据照旧显示` });
        } else {
          setDelta({ source, stored: final.stored });
        }
      } catch (err) {
        setNotice({ kind: 'err', text: `${messageOf(err)} · 本地缓存的数据照旧显示` });
      } finally {
        await refresh();
        setBusy((b) => ({ ...b, [source]: false }));
      }
      return final;
    },
    [busy, refresh],
  );

  const navigate = useCallback((next: View) => {
    window.location.hash = `/${next}`;
  }, []);

  const commit = (to: SourceId): void => {
    shownRef.current = to;
    /*
     * 换屏这一步**必须同步提交**（flushSync）。飞入的起始态（opacity 0 / 下移 / 缩 4%）
     * 是在 `useLayoutEffect` 里挂上去的，只有「换屏 + 挂动画」落在同一个任务里，
     * 浏览器才会只画出挂好动画的那一帧。若走普通 `setShown()`，React 18 会把这次更新
     * 排进调度器：这一帧一旦被让出去，落地屏就先以**终态**画一帧（卡片在原位置全部出现、
     * 闪一下），下一帧才被飞入动画拽回屏底重飞 —— 即 Chrome / Firefox 上概率性闪屏的来由
     * （Edge 的调度时机不同所以看不到）。`flushSync` 让 setShown 与随之而来的
     * `useLayoutEffect` 在同一个任务内跑完，任何浏览器都没机会插进这一帧。
     */
    flushSync(() => setShown(to));
  };

  /**
   * 源切换：旧卡飞出、新卡飞入（docs/09 §7）。
   *
   * **编排期间不接受任何切换请求**（用户 2026-10-05 拍板）：整段 1.39s / 1.48s 里点谁都不动，
   * 等这一轮跑完再响应下一次点击。早期版本做的是"立即落位 + 开播目标档"，但改道会让卡片在
   * 中间屏上先瞬移回原位再重飞（`flyOut` 的起始关键帧就是自然位），看上去正是"卡直接出现然后才飞" ——
   * 与其去治那个中间态，不如根本不进入它。
   */
  const select = useCallback((next: SourceId) => {
    const action = decideSwitch({ shown: shownRef.current, flying: flyRef.current !== null }, next);

    if (action.kind === 'ignore') return;

    if (action.kind === 'plain') {
      commit(next);
      return;
    }

    const fromId = action.from;
    const from = nodeOf(fromId);
    const canFly = from !== null && !flySkipped() && flyNodes(from).length > 0;
    // 没卡可飞就瞬切：走这条绝不能置 landRef，否则空屏上会挂一次没有意义的飞入
    if (!canFly) {
      seenRef.current.add(fromId);
      commit(next);
      return;
    }

    seenRef.current.add(fromId);
    from.classList.add('is-flying');
    scrollRef.current[fromId] = from.scrollTop;
    const { total, anims } = flyOut(from);
    const timer = window.setTimeout(() => {
      for (const a of anims) a.cancel();
      from.classList.remove('is-flying');
      flyRef.current = null;
      landRef.current = true;
      commit(next);
    }, total + FLY.handoff);
    flyRef.current = { anims, timer };
  }, []);

  /** 换屏刚落地的这一帧：飞入新屏（reduced-motion 直接留终态） */
  useLayoutEffect(() => {
    if (!landRef.current) return;
    landRef.current = false;
    const to = nodeOf(shown);
    if (!to) return;
    to.scrollTop = scrollRef.current[shown] ?? 0;
    tabRefs.current[shown]?.focus();
    if (flySkipped() || flyNodes(to).length === 0) return;
    to.classList.add('is-flying');
    const { total, anims } = flyIn(to);
    const timer = window.setTimeout(() => {
      for (const a of anims) a.cancel();
      to.classList.remove('is-flying');
      flyRef.current = null;
    }, total);
    flyRef.current = { anims, timer };
  }, [shown]);

  const active: SyncSourceId | null = shown === 'xcpc' ? null : shown;

  const tabs = view === 'dashboard' ? <SourceTabs current={shown} status={status} onSelect={select} tabRefs={tabRefs} /> : null;

  const screen = () => {
    if (view === 'master') {
      return (
        <div className="content">
          {notice ? <NoticeBar {...notice} /> : null}
          <LockedMaster wide />
        </div>
      );
    }
    if (view === 'vp') {
      return (
        <div className="content">
          {notice ? <NoticeBar {...notice} /> : null}
          <LockedVp wide />
        </div>
      );
    }
    if (view === 'settings') {
      const firstRun = status !== null && !status.sources.cf.configured && !status.sources.at.configured;
      if (firstRun || status === null) {
        return (
          <Wizard
            status={status}
            sync={states?.cf ?? null}
            onStatus={setStatus}
            onRun={() => runSync('cf')}
            onEnterDashboard={() => {
              navigate('dashboard');
              void refresh();
            }}
          />
        );
      }
      return (
        <Settings
          status={status}
          states={states}
          busy={busy}
          onStatus={setStatus}
          onRun={async (source) => {
            await runSync(source);
          }}
        />
      );
    }
    if (status && !status.sources.cf.configured && !status.sources.at.configured) {
      return <ColdStart dash={dashes.cf ?? null} status={status} today={today} notice={notice} onGoSettings={() => navigate('settings')} />;
    }
    if (active === null) return <XcpcPlaceholder />;
    const src = status?.sources[active] ?? null;
    if (src !== null && !src.configured) {
      return <Unconfigured source={active} onGoSettings={() => navigate('settings')} />;
    }
    const dash = dashes[active];
    if (dash) {
      return (
        <Dashboard
          source={active}
          dash={dash}
          today={today}
          notice={notice}
          firstPaint={!seenRef.current.has(active)}
          srcStatus={src}
          onSync={() => void runSync(active)}
        />
      );
    }
    return (
      <div className="content" id={`content-${active}`} role="tabpanel">
        {notice ? <NoticeBar {...notice} /> : <p className="hint">正在读 vault/anvil.db…</p>}
      </div>
    );
  };

  return (
    <AppShell
      view={view}
      onNavigate={navigate}
      status={status}
      source={shown}
      busy={active ? busy[active] : false}
      delta={delta && active && delta.source === active ? delta.stored : null}
      onSync={() => {
        if (active) void runSync(active);
      }}
      tabs={tabs}
    >
      {screen()}
    </AppShell>
  );
}
