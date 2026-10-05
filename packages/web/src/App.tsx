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
  const wantRef = useRef<SourceId>('cf');
  const flyRef = useRef<{ anims: Animation[]; timer: number } | null>(null);
  const landRef = useRef(false);
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

  const commit = (to: SourceId, flush = false): void => {
    shownRef.current = to;
    if (flush) flushSync(() => setShown(to));
    else setShown(to);
  };

  const cancelFly = (): void => {
    const f = flyRef.current;
    if (!f) return;
    clearTimeout(f.timer);
    for (const a of f.anims) a.cancel();
    flyRef.current = null;
  };

  /**
   * 源切换：旧卡飞出、新卡飞入（docs/09 §7）。
   * 切换中改道 → 当前动画立即落位，直接开播目标档，不排队等待。
   */
  const select = useCallback((next: SourceId) => {
    // 目标没变（连点同一个 tab 就是这种）→ 忽略，让正在播的编排走完，别把它快进成"没有动效"
    if (next === wantRef.current) return;
    if (flyRef.current) {
      const mid = wantRef.current;
      cancelFly();
      nodeOf(shownRef.current)?.classList.remove('is-flying');
      commit(mid, true);
    }
    wantRef.current = next;
    const fromId = shownRef.current;
    const from = nodeOf(fromId);
    if (!from || flySkipped() || flyNodes(from).length === 0) {
      commit(next);
      return;
    }
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
    /*
     * 三屏常驻 DOM，切换只翻 hidden（照视觉稿的结构：CF / AT / XCPC 都在文档里，靠 hidden 切）。
     * 飞入的卡因此不是「本帧刚插入的节点」—— Gecko 会先给新节点画一帧基础样式再挂上动画，
     * 那就是 Firefox 上「原位闪一下 → 消失 → 才飞入」的来由；Chromium 同帧起好动画所以看不出。
     */
    if (status === null) {
      return (
        <div className="content" id="content-cf" role="tabpanel">
          {notice ? <NoticeBar {...notice} /> : <p className="hint">正在读 vault/anvil.db…</p>}
        </div>
      );
    }
    const firstRun = !status.sources.cf.configured && !status.sources.at.configured;
    const screenFor = (id: SyncSourceId) => {
      const hidden = shown !== id;
      if (id === 'cf' && firstRun) {
        return (
          <ColdStart
            dash={dashes.cf ?? null}
            status={status}
            today={today}
            notice={notice}
            onGoSettings={() => navigate('settings')}
            hidden={hidden}
          />
        );
      }
      const src = status.sources[id];
      if (!src.configured) return <Unconfigured source={id} onGoSettings={() => navigate('settings')} hidden={hidden} />;
      const dash = dashes[id];
      if (!dash) {
        return (
          <div className="content" id={`content-${id}`} role="tabpanel" hidden={hidden}>
            {notice ? <NoticeBar {...notice} /> : <p className="hint">正在读 vault/anvil.db…</p>}
          </div>
        );
      }
      return (
        <Dashboard
          source={id}
          dash={dash}
          today={today}
          notice={notice}
          srcStatus={src}
          onSync={() => void runSync(id)}
          hidden={hidden}
        />
      );
    };
    return (
      <>
        {screenFor('cf')}
        {screenFor('at')}
        <XcpcPlaceholder hidden={shown !== 'xcpc'} />
      </>
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
