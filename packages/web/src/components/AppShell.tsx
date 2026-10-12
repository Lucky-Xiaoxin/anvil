import { useEffect, useState, type ReactNode } from 'react';
import type { SourceState, SourceStatusDto, StatusDto, SourceId, XcpcProfileDto } from '@anvil/shared';
import { SOURCE_NAME } from '../api.ts';
import { fmtInt, relativeTime } from '../format.ts';
import { medalRows, medalTotal, snapshotDate, snapshotDaysAgo } from './xcpc/derive.ts';
import { useTip } from '../tip.tsx';
import { Icon } from './ui.tsx';
import { loadRail, saveRail } from './arena/session.ts';

export type View = 'dashboard' | 'master' | 'arena' | 'settings';

const TITLES: Record<View, string> = { dashboard: '个人数据', master: '工坊', arena: '模拟榜单', settings: '设置' };
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
  /** 模拟榜单自带整条顶栏（计时 / 走带 / 封榜 pill），壳就不再补一条 */
  bare?: boolean;
  /** 目录场次：页脚在 arena 语境下要说这件事，而它只有目录屏拉得到（null = 还没拉到） */
  arenaCount: number | null;
  children: ReactNode;
}

export function AppShell({ view, onNavigate, status, source, xcpc, busy, delta, onSync, tabs, bare = false, arenaCount, children }: Props) {
  const { show, hide } = useTip();
  const [rail, setRail] = useState(() => loadRail(window.localStorage));
  useEffect(() => saveRail(window.localStorage, rail), [rail]);
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
  /** 收起态 navfoot 只留符号：一枚状态点 + 主计数（§1.2） */
  const railCount = isXcpc ? (claimed ? fmtInt(xcpc?.player.contests ?? 0) : '—') : src ? fmtInt(src.counts.submissions) : '—';
  /** 页脚按模块语境化（mock-04 v6）：arena 报榜单缓存、settings / master 报全局本地信息 */
  const port = window.location.port || '7788';
  const arenaN = arenaCount === null ? '—' : fmtInt(arenaCount);

  return (
    <div className={`app${dash ? ` dash pf-${source}${isXcpc ? ' is-strong' : ''}` : ''}${rail ? ' is-rail' : ''}`}>
      <aside className="nav">
        <div className="brand">
          <Icon id="i-anvil" />
          <div className="brand__txt">
            <div className="brand__name">ANVIL</div>
            <div className="brand__sub">铁砧</div>
          </div>
        </div>
        <div className="navlist">
          <button className="navitem" aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => onNavigate('dashboard')}>
            <Icon id="i-dash" />
            <span className="navtxt">个人数据</span>
            <span className="navlabel">
              个人数据
              <small>CF · AT · XCPC 三源</small>
            </span>
          </button>
          <button className="navitem navitem--locked" aria-current={view === 'master' ? 'page' : undefined} onClick={() => onNavigate('master')}>
            <Icon id="i-map" />
            <span className="navtxt">工坊</span>
            <Icon id="i-lock" className="lock" />
            <span className="navlabel">
              工坊
              <small>切片 5 · 未解锁</small>
            </span>
          </button>
          <button className="navitem" aria-current={view === 'arena' ? 'page' : undefined} onClick={() => onNavigate('arena')}>
            <Icon id="i-board" />
            <span className="navtxt">模拟榜单</span>
            <span className="navlabel">
              模拟榜单
              <small>目录 + 回放</small>
            </span>
          </button>
          <button className="navitem" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}>
            <Icon id="i-cog" />
            <span className="navtxt">设置</span>
            <span className="navlabel">设置</span>
          </button>
        </div>
        <div className="navfoot">
          <div className="navfoot__full">
            {view === 'arena' ? (
              <>
                目录 <b className="num">{arenaN}</b> 场 · 榜单本地缓存
                <br />
                源 <code>srk-collection</code> 社区快照
                <br />
                端口 <b className="num">{port}</b> · 不出网
              </>
            ) : view === 'dashboard' ? (
              isXcpc ? (
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
              )
            ) : (
              <>
                本地 <code>vault/</code> · 端口 <b className="num">{port}</b>
                <br />
                不出网 · 数据只在本机
              </>
            )}
          </div>
          <div className="navfoot__rail">
            {view === 'arena' ? (
              <>
                <i className="dot dot--big" style={{ background: DOT.idle }} />
                <b>{arenaN}</b>
                <span className="navlabel">
                  目录 {arenaN} 场
                  <small>vault/arena · 本地缓存</small>
                </span>
              </>
            ) : view === 'dashboard' ? (
              <>
                <i className="dot dot--big" style={{ background: DOT[state] }} />
                <b>{railCount}</b>
                <span className="navlabel">
                  {isXcpc ? 'XCPC 档案' : `${SOURCE_NAME[source]} 读数`}
                  <small>{isXcpc ? (claimed ? '社区快照 · official 口径' : '未认领档案') : 'vault/anvil.db · 本地'}</small>
                </span>
              </>
            ) : (
              <>
                <i className="dot dot--big" style={{ background: DOT.idle }} />
                <b>本地</b>
                <span className="navlabel">{`ANVIL · vault/ · 端口 ${port}`}</span>
              </>
            )}
          </div>
        </div>
        <button
          className="railbtn"
          aria-label={rail ? '展开侧栏' : '收起侧栏'}
          title={rail ? '展开侧栏' : '收起侧栏'}
          aria-pressed={rail}
          onClick={() => setRail(!rail)}
        >
          <svg viewBox="0 0 18 14" aria-hidden="true">
            <rect className="rb-out" x=".9" y=".9" width="16.2" height="12.2" rx="3.2" />
            <rect className="rb-bar" x="3.4" y="3.5" width="4" height="7" rx="1.4" />
          </svg>
        </button>
      </aside>

      <div className="main">
        {bare ? null : (
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
                    sub: '重名请对照学校',
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
        )}
        {tabs}
        {children}
      </div>
    </div>
  );
}
