import type { ReactNode } from 'react';
import type { StatusDto } from '@anvil/shared';
import { fmtInt, relativeTime } from '../format.ts';
import { Icon } from './ui.tsx';

export type View = 'dashboard' | 'master' | 'vp' | 'settings';

const TITLES: Record<View, string> = { dashboard: '仪表盘', master: '掌握图', vp: 'VP', settings: '设置' };

interface Props {
  view: View;
  onNavigate: (view: View) => void;
  status: StatusDto | null;
  busy: boolean;
  /** 最近一次同步新增的提交条数 */
  delta: number | null;
  onSync: () => void;
  children: ReactNode;
}

export function AppShell({ view, onNavigate, status, busy, delta, onSync, children }: Props) {
  const configured = status?.configured ?? false;

  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">
          <Icon id="i-anvil" />
          <div>
            <div className="brand__name">ANVIL</div>
            <div className="brand__sub">铁砧</div>
          </div>
        </div>
        <div className="navlist">
          <button className="navitem" aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => onNavigate('dashboard')}>
            <Icon id="i-dash" />
            仪表盘
          </button>
          <button className="navitem navitem--locked" aria-current={view === 'master' ? 'page' : undefined} onClick={() => onNavigate('master')}>
            <Icon id="i-map" />
            掌握图
            <Icon id="i-lock" className="lock" />
          </button>
          <button className="navitem navitem--locked" aria-current={view === 'vp' ? 'page' : undefined} onClick={() => onNavigate('vp')}>
            <Icon id="i-vp" />
            VP
            <Icon id="i-lock" className="lock" />
          </button>
          <button className="navitem" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}>
            <Icon id="i-cog" />
            设置
          </button>
        </div>
        <div className="navfoot">
          <b className="num">{status ? fmtInt(status.counts.submissions) : '—'}</b> 条提交 ·{' '}
          <b className="num">{status ? fmtInt(status.counts.problems) : '—'}</b> 题<br />
          本地 <code>vault/anvil.db</code>
          <br />
          端口 <code>{window.location.port || '7788'}</code> · 不出网
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <h2>{TITLES[view]}</h2>
          {configured ? (
            <span className="chip">
              <i />@{status?.handle}
            </span>
          ) : (
            <span className="chip" style={{ color: 'var(--text-mute)' }}>
              <i style={{ background: 'var(--text-mute)' }} />
              未配置
            </span>
          )}
          {view === 'dashboard' && configured ? (
            <span className="topbar__meta">
              <Icon
                id={busy ? 'i-sync' : 'i-check'}
                style={{ width: 13, height: 13, color: busy ? 'var(--accent)' : 'var(--ok)' }}
              />
              {delta !== null ? (
                <>
                  增量 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{fmtInt(delta)} 条新提交</b> ·
                </>
              ) : null}
              上次同步 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
                {relativeTime(status?.lastSyncAt ?? null)}
              </b>
            </span>
          ) : null}
          <span className="topbar__spacer" />
          {view === 'dashboard' ? (
            <button className={`btn btn-sync${busy ? ' is-busy' : ''}`} disabled={!configured || busy} onClick={onSync}>
              <Icon id="i-sync" />
              {busy ? '拉取中…' : '同步'}
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
