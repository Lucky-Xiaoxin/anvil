import type { ReactNode } from 'react';
import type { SourceId, SourceState, SourceStatusDto, StatusDto } from '@anvil/shared';
import { SOURCE_NAME } from '../api.ts';
import { fmtInt, relativeTime } from '../format.ts';
import { Icon } from './ui.tsx';

export type View = 'dashboard' | 'master' | 'vp' | 'settings';

const TITLES: Record<View, string> = { dashboard: '仪表盘', master: '掌握图', vp: 'VP', settings: '设置' };
const DOT: Record<SourceState, string> = {
  ok: 'var(--ok)',
  stale: 'var(--warn)',
  down: 'var(--bad)',
  idle: '#39434F',
};

interface Props {
  view: View;
  onNavigate: (view: View) => void;
  status: StatusDto | null;
  /** 当前挂在屏上的源：顶栏说的、按钮动的都是它 */
  source: SourceId;
  busy: boolean;
  /** 最近一次同步新增的提交条数 */
  delta: number | null;
  onSync: () => void;
  tabs: ReactNode | null;
  children: ReactNode;
}

export function AppShell({ view, onNavigate, status, source, busy, delta, onSync, tabs, children }: Props) {
  const src: SourceStatusDto | null = source === 'xcpc' ? null : (status?.sources[source] ?? null);
  const configured = src?.configured ?? false;
  const dash = view === 'dashboard';

  return (
    <div className={`app${dash ? ` dash pf-${source}${source === 'xcpc' ? ' is-strong' : ''}` : ''}`}>
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
          {source === 'xcpc' ? (
            <>
              未接入
              <br />
              契约 <code>docs/09</code> §9
            </>
          ) : (
            <>
              <b className="num">{src ? fmtInt(src.counts.submissions) : '—'}</b> 条提交 ·{' '}
              <b className="num">{src ? fmtInt(src.counts.problems) : '—'}</b> 题
              <br />
              本地 <code>vault/anvil.db</code>
              <br />
              端口 <code>{window.location.port || '7788'}</code> · 不出网
            </>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <h2>{TITLES[view]}</h2>
          {source === 'xcpc' ? (
            <span className="chip" style={{ color: 'var(--text-mute)' }}>
              <i style={{ background: '#39434F' }} />
              未认领
            </span>
          ) : configured ? (
            <span className="chip">
              <i style={{ background: DOT[src!.status] }} />@{src?.handle}
            </span>
          ) : (
            <span className="chip" style={{ color: 'var(--text-mute)' }}>
              <i style={{ background: '#39434F' }} />
              未配置
            </span>
          )}
          {dash && configured && src ? (
            <span className="topbar__meta">
              <Icon
                id={busy ? 'i-sync' : src.status === 'ok' ? 'i-check' : 'i-warn'}
                style={{
                  width: 13,
                  height: 13,
                  color: busy ? 'var(--accent)' : src.status === 'ok' ? 'var(--ok)' : 'var(--warn)',
                }}
              />
              {delta !== null ? (
                <>
                  增量 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{fmtInt(delta)} 条新提交</b> ·{' '}
                </>
              ) : null}
              上次同步 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
                {relativeTime(src.lastSyncAt)}
              </b>
            </span>
          ) : null}
          <span className="topbar__spacer" />
          {dash ? (
            <button
              className={`btn btn-sync${busy ? ' is-busy' : ''}`}
              disabled={!configured || busy || source === 'xcpc'}
              title={source === 'xcpc' ? 'XCPC 本切片不实现同步' : undefined}
              onClick={onSync}
            >
              <Icon id="i-sync" />
              {busy ? '拉取中…' : '同步'} <span className="btn-src">{SOURCE_NAME[source]}</span>
            </button>
          ) : null}
        </div>
        {tabs}
        {children}
      </div>
    </div>
  );
}
