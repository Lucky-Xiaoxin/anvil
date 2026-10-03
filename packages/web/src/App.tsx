import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardDto, StatusDto } from '@anvil/shared';
import { ApiError, getDashboard, getSyncState, getStatus, startSync } from './api.ts';
import { sleep } from './format.ts';
import { AppShell, type View } from './components/AppShell.tsx';
import { ColdStart, Dashboard, LockedMaster, LockedVp, NoticeBar, type Notice } from './components/Dashboard.tsx';
import { Wizard } from './components/Wizard.tsx';

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h === 'settings' || h === 'master' || h === 'vp' ? h : 'dashboard';
}

export function App() {
  const today = useMemo(() => new Date(), []);
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [dash, setDash] = useState<DashboardDto | null>(null);
  const [view, setView] = useState<View>(viewFromHash);
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
      setStatus(await getStatus());
      setDash(await getDashboard());
      setNotice(null);
      return true;
    } catch (err) {
      setNotice({ kind: 'err', text: `${messageOf(err)} · 只读本地缓存，不会再出网` });
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSync = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setDelta(null);
    setNotice(null);
    let failure: string | null = null;
    try {
      let state = await startSync();
      while (state.phase !== 'done' && state.phase !== 'error') {
        await sleep(1000);
        state = await getSyncState();
      }
      setDelta(state.stored);
      if (state.phase === 'error') failure = state.error ?? '同步失败';
    } catch (err) {
      failure = messageOf(err);
    }
    await refresh();
    if (failure) setNotice({ kind: 'err', text: `${failure} · 本地缓存的数据照旧显示` });
    setBusy(false);
  }, [busy, refresh]);

  const navigate = useCallback((next: View) => {
    window.location.hash = `/${next}`;
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
          onStatus={setStatus}
          onSynced={() => void refresh()}
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
    return <div className="content" />;
  };

  return (
    <AppShell view={view} onNavigate={navigate} status={status} busy={busy} delta={delta} onSync={() => void onSync()}>
      {content()}
    </AppShell>
  );
}
