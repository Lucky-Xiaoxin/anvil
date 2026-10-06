import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  DashboardDto,
  SourceId,
  StatusDto,
  SyncSourceId,
  SyncStateDto,
  SyncStatesDto,
  XcpcProfileDto,
} from '@anvil/shared';
import { getDashboard, getSyncStates, getStatus, getXcpc, refreshXcpc, startSync } from './api.ts';
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
  type Notice,
} from './components/Dashboard.tsx';
import { Settings } from './components/Settings.tsx';
import { SourceTabs } from './components/SourceTabs.tsx';
import { Wizard } from './components/Wizard.tsx';
import { XcpcClaim } from './components/xcpc/XcpcClaim.tsx';
import { XcpcDossier } from './components/xcpc/XcpcDossier.tsx';
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
  const [xcpc, setXcpc] = useState<XcpcProfileDto | null>(null);
  const [states, setStates] = useState<SyncStatesDto | null>(null);
  const [today, setToday] = useState(() => new Date());
  const [view, setView] = useState<View>(viewFromHash);
  const [busy, setBusy] = useState<Record<SourceId, boolean>>({ cf: false, at: false, xcpc: false });
  const [delta, setDelta] = useState<{ source: SyncSourceId; stored: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 认领成功后停在完成条上，等用户点「看档案」再切长卷 */
  const [claiming, setClaiming] = useState(false);

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
      const [cf, at, x] = await Promise.all([getDashboard('cf'), getDashboard('at'), getXcpc()]);
      setStatus(s);
      setDashes({ cf, at });
      setXcpc(x);
      setToday(new Date());
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'err', text: `${messageOf(err)} · 只读本地缓存，不会再出网` });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * XCPC 的「同步」= 拉快照（比版本后按需重拉），单请求往返、没有进度可报，
   * 所以它不进 /api/sync 的 runner（docs/14 §4）。提示条放在 refresh 之后落，
   * 免得被 refresh 清旧提示的那一步顺手抹掉。
   */
  const runXcpcRefresh = useCallback(async (): Promise<void> => {
    if (busy.xcpc) return;
    setBusy((b) => ({ ...b, xcpc: true }));
    setNotice(null);
    let next: Notice | null = null;
    try {
      const { updated, player, snapshotAt, fetchedAt, rankTotal } = await refreshXcpc();
      setXcpc({ player, snapshotAt, fetchedAt, rankTotal });
      next = { kind: 'ok', text: updated ? '已拉到新版快照' : '社区快照仍是这一版 · 数据没变' };
    } catch (err) {
      next = { kind: 'err', text: `${messageOf(err)} · 本地缓存的档案照旧显示` };
    } finally {
      await refresh();
      setBusy((b) => ({ ...b, xcpc: false }));
      setNotice(next);
    }
  }, [busy.xcpc, refresh]);

  /**
   * 认领 / 换人成功：档案立刻进屏，状态点与侧栏读数跟着 refresh。
   * `goDossier` 只在建领屏用 —— 停在完成条上等「看档案」；设置页换人就地完成。
   */
  const onClaimed = useCallback(
    (profile: XcpcProfileDto, goDossier: boolean) => {
      setXcpc(profile);
      setClaiming(goDossier);
      void refresh();
    },
    [refresh],
  );

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
    flushSync(() => {
      // 离开 XCPC 屏就把认领完成条收掉，下次回来直接落长卷
      if (to !== 'xcpc') setClaiming(false);
      setShown(to);
    });
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
    // 没卡可飞就瞬切：走这条绝不能置 landRef，否则空屏上会挂一次没有意义的飞入。
    // 但焦点交接不能跟着一起省掉 —— 换屏后旧 tab 已经 tabIndex=-1，焦点留在上面就丢了。
    if (!canFly) {
      seenRef.current.add(fromId);
      commit(next);
      tabRefs.current[next]?.focus();
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
          xcpc={xcpc}
          onStatus={setStatus}
          onRun={async (source) => {
            await runSync(source);
          }}
          onRunXcpc={async () => {
            await runXcpcRefresh();
          }}
          onClaimed={(p) => onClaimed(p, false)}
        />
      );
    }
    /*
     * XCPC 的判定必须在「一个 handle 都没配」之前：这一屏走认领、不走 handle，CF / AT 配没配与它无关。
     * 原先这条在下面，导致没配 handle 时点 XCPC / AT 也走 ColdStart，而 ColdStart 的面板 id
     * 写死 content-cf —— 飞出的卡落地时 `nodeOf(shown)` 取不到节点，于是没有飞入、没有焦点交接，
     * 卡还会在飞出段被 cancel 的瞬间弹回原位；`aria-controls` 也指向了不存在的面板。
     */
    if (active === null) {
      if (status === null) {
        return (
          <div className="content" id="content-xcpc" role="tabpanel">
            {notice ? <NoticeBar {...notice} /> : <p className="hint">正在读 vault/anvil.db…</p>}
          </div>
        );
      }
      // 没档案、或刚认领完还停在完成条上 → 认领屏；否则就是长卷
      if (claiming || xcpc === null) {
        return <XcpcClaim onClaimed={(p) => onClaimed(p, true)} onGoDossier={() => setClaiming(false)} />;
      }
      return (
        <XcpcDossier
          profile={xcpc}
          status={status.xcpc}
          firstPaint={!seenRef.current.has('xcpc')}
          notice={notice}
          onSync={() => void runXcpcRefresh()}
        />
      );
    }
    if (status && !status.sources.cf.configured && !status.sources.at.configured) {
      return (
        <ColdStart
          source={active}
          dash={dashes.cf ?? null}
          status={status}
          today={today}
          notice={notice}
          onGoSettings={() => navigate('settings')}
        />
      );
    }
    const src = status?.sources[active] ?? null;
    if (src !== null && !src.configured) {
      return <Unconfigured source={active} onGoSettings={() => navigate('settings')} />;
    }
    const dash = dashes[active];
    if (dash) {
      return (
        <Dashboard
          /*
           * key 让换源走「重新挂载」而不是「更新同一实例」：`Num` 的 `instant` 只在挂载那一次
           * 生效，不给 key 的话换屏回来 `mounted.current` 已是 true，四张卡的 count-up 会重播
           * 一遍（与 docs 里"换屏回来时图里已是终态"的口径相反），而且第一帧还会先画出上一个
           * 源的旧数字。
           */
          key={active}
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
      xcpc={xcpc}
      busy={busy[shown]}
      delta={delta && active && delta.source === active ? delta.stored : null}
      onSync={() => {
        if (active) void runSync(active);
        else void runXcpcRefresh();
      }}
      tabs={tabs}
    >
      {screen()}
    </AppShell>
  );
}
