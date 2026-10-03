import { useCallback, useEffect, useState } from 'react';
import type { DashboardDto, StatusDto, SyncStateDto } from '@anvil/shared';
import { getDashboard, getSyncState, getStatus, startSync } from './api.ts';
import { messageOf, sleep } from './format.ts';
import { AppShell, type View } from './components/AppShell.tsx';
import { ColdStart, Dashboard, LockedMaster, LockedVp, NoticeBar, type Notice } from './components/Dashboard.tsx';
import { Wizard } from './components/Wizard.tsx';

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h === 'settings' || h === 'master' || h === 'vp' ? h : 'dashboard';
}

/** 服务端把任务丢了（进程重启）时，别把进度条永远挂在那儿 */
const IDLE_BEATS_BEFORE_GIVEUP = 3;

export function App() {
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [dash, setDash] = useState<DashboardDto | null>(null);
  const [today, setToday] = useState(() => new Date());
  const [view, setView] = useState<View>(viewFromHash);
  const [sync, setSync] = useState<SyncStateDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [delta, setDelta] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = [await getStatus(), await getDashboard()];
      setStatus(s);
      setDash(d);
      setToday(new Date());
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'err', text: `${messageOf(err)} · 只读本地缓存，不会再出网` });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 同步由 App 拥有：谁起跑都一样——顶栏按钮同步进入忙态，切页也不丢跟踪 */
  const runSync = useCallback(async (): Promise<SyncStateDto> => {
    setBusy(true);
    setDelta(null);
    setNotice(null);
    let state: SyncStateDto;
    try {
      state = await startSync();
      setSync(state);
      let idleBeats = 0;
      while (state.phase !== 'done' && state.phase !== 'error') {
        await sleep(1000);
        state = await getSyncState();
        if (state.phase === 'idle' && ++idleBeats >= IDLE_BEATS_BEFORE_GIVEUP) {
          state = { ...state, phase: 'error', error: '同步中断：本地服务重启过，再点一次同步' };
        }
        setSync(state);
        if (state.phase !== 'idle') idleBeats = 0;
      }
    } finally {
      await refresh();
      setBusy(false);
    }
    setDelta(state.stored);
    if (state.phase === 'error') {
      setNotice({ kind: 'err', text: `${state.error ?? '同步失败'} · 本地缓存的数据照旧显示` });
    }
    return state;
  }, [refresh]);

  const syncNow = useCallback(async () => {
    if (busy) return;
    try {
      await runSync();
    } catch (err) {
      setNotice({ kind: 'err', text: `${messageOf(err)} · 本地缓存的数据照旧显示` });
    }
  }, [busy, runSync]);

  const navigate = useCallback((next: View) => {
    window.location.hash = `/${next}`;
  }, []);

  /** 换 handle 之后上一轮的进度就不相干了 */
  const changeHandle = useCallback((next: StatusDto) => {
    setStatus(next);
    setSync(null);
  }, []);

  const content = () => {
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
      return (
        <Wizard
          status={status}
          sync={sync}
          onStatus={changeHandle}
          onRun={runSync}
          onEnterDashboard={() => {
            navigate('dashboard');
            void refresh();
          }}
        />
      );
    }
    if (status && !status.configured) {
      return (
        <ColdStart dash={dash} status={status} today={today} notice={notice} onGoSettings={() => navigate('settings')} />
      );
    }
    if (dash) return <Dashboard dash={dash} today={today} notice={notice} />;
    return <div className="content">{notice ? <NoticeBar {...notice} /> : <p className="hint">正在读 vault/anvil.db…</p>}</div>;
  };

  return (
    <AppShell view={view} onNavigate={navigate} status={status} busy={busy} delta={delta} onSync={() => void syncNow()}>
      {content()}
    </AppShell>
  );
}
