import type { ReactNode } from 'react';
import type { SourceState, SourceStatusDto, StatusDto, SourceId, XcpcProfileDto } from '@anvil/shared';
import { SOURCE_NAME } from '../api.ts';
import { fmtInt, relativeTime } from '../format.ts';
import { medalRows, medalTotal, snapshotDate, snapshotDaysAgo } from './xcpc/derive.ts';
import { useTip } from '../tip.tsx';
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
  /** 长卷的场数与奖牌数要从档案里读，status 只带读数不带这些 */
  xcpc: XcpcProfileDto | null;
  busy: boolean;
  /** 最近一次同步新增的提交条数；XCPC 没有提交粒度 → null */
  delta: number | null;
  onSync: () => void;
  tabs: ReactNode | null;
  children: ReactNode;
}

export function AppShell({ view, onNavigate, status, source, xcpc, busy, delta, onSync, tabs, children }: Props) {
  const { show, hide } = useTip();
  const x = status?.xcpc ?? null;
  const isXcpc = source === 'xcpc';
  const src: SourceStatusDto | null = isXcpc ? null : (status?.sources[source] ?? null);
  const claimed = x?.claimed ?? false;
  /** 「能同步」：CF / AT 看有没有填 handle，XCPC 看有没有认领 */
  const ready = isXcpc ? claimed : (src?.configured ?? false);
  const state: SourceState = isXcpc ? (x?.status ?? 'idle') : (src?.status ?? 'idle');
  const dash = view === 'dashboard';
  const name = x?.key === undefined || x?.key === null ? '' : x.key.split('@')[0] ?? '';
  const days = snapshotDaysAgo(x?.snapshotAt ?? null);

  return (
    <div className={`app${dash ? ` dash pf-${source}${isXcpc ? ' is-strong' : ''}` : ''}`}>
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
          {isXcpc ? (
            claimed ? (
              <>
                <b className="num">{fmtInt(xcpc?.player.contests ?? 0)}</b> 场参赛 ·{' '}
                <b className="num">{xcpc === null ? '—' : medalTotal(medalRows(xcpc.player.medals))}</b> 枚奖牌
                <br />
                源 <code>heimaom</code> 社区快照
                <br />
                数据版本 <code>{snapshotDate(x?.snapshotAt ?? null)}</code>
              </>
            ) : (
              <>
                未认领档案
                <br />
                源 <code>heimaom</code> 社区快照
                <br />
                口径 <code>official</code>
              </>
            )
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
          {isXcpc ? (
            claimed ? (
              <span
                className="chip"
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  show({
                    x: r.left + r.width / 2,
                    y: r.bottom,
                    below: true,
                    zero: false,
                    date: '档案 key',
                    value: x?.key ?? '',
                    valueClass: 'is-dim',
                    sub: '官方榜口径 · 重名请对照学校',
                  });
                }}
                onMouseLeave={hide}
              >
                <i style={{ background: DOT[state] }} />
                {name}
              </span>
            ) : (
              <span className="chip" style={{ color: 'var(--text-mute)' }}>
                <i style={{ background: DOT.idle }} />
                未认领
              </span>
            )
          ) : ready ? (
            <span className="chip">
              <i style={{ background: DOT[state] }} />@{src?.handle}
            </span>
          ) : (
            <span className="chip" style={{ color: 'var(--text-mute)' }}>
              <i style={{ background: DOT.idle }} />
              未配置
            </span>
          )}
          {dash && isXcpc && claimed ? (
            <span className="topbar__meta">
              <Icon
                id={busy ? 'i-sync' : state === 'ok' ? 'i-check' : 'i-warn'}
                style={{ width: 13, height: 13, color: busy ? 'var(--accent)' : state === 'ok' ? 'var(--ok)' : 'var(--warn)' }}
              />
              数据版本 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{snapshotDate(x?.snapshotAt ?? null)}</b>
              <span className="mute">{days === null ? '' : ` · 生成 ${days} 天前`}</span>
              <span className="vsep" aria-hidden="true" />
              上次同步 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{relativeTime(x?.fetchedAt ?? null)}</b>
            </span>
          ) : dash && !isXcpc && ready && src ? (
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
              disabled={!ready || busy}
              title={!ready && isXcpc ? '认领后才能拉快照' : undefined}
              onClick={onSync}
            >
              <Icon id="i-sync" />
              {busy ? (isXcpc ? '拉取' : '拉取中…') : '同步'} <span className="btn-src">{SOURCE_NAME[source]}</span>
              {busy && isXcpc ? '…' : null}
            </button>
          ) : null}
        </div>
        {tabs}
        {children}
      </div>
    </div>
  );
}
