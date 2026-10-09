/**
 * 赛事目录（docs/16 §5.1）：五类 → 年份 / 省 → 场次，带搜索、计数、三态与进行中标记。
 *
 * 诚实标注两处照 §2.3 原样：顶栏「目录 N 场 · 榜单来自官方快照」、卡底「来源 algoux/srk-collection
 * （社区快照）· 回放的是已打完的比赛」。
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ArenaCatalogDto } from '@anvil/shared';
import { getArenaCatalog } from '../../api.ts';
import { clockHMS, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { catalogHeadline, flattenLeaves, searchLeaves, toGroupNode, type GroupNode, type LeafRow } from './catalog.ts';
import { elapsedOf } from './engine.ts';
import { loadSession, listSessionPaths, type Store } from './session.ts';

interface Props {
  store: Store;
  /** 刷新目录后由父层重取；这里只报「进哪一场、什么模式」 */
  onEnter: (row: LeafRow, live: boolean) => void;
  /** 会话表版本号：从回放屏退回目录时 +1，让「回放中」标记立刻更新 */
  sessionEpoch: number;
}

const subLabel = (node: GroupNode): string =>
  node.kids.length > 0 ? (node.name === '省赛' ? '按省分组' : node.name === '校赛' ? '按学校' : '按年份') : '按场次';

export function ArenaCatalog({ store, onEnter, sessionEpoch }: Props) {
  const [dto, setDto] = useState<ArenaCatalogDto | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const fetchCatalog = useCallback(async (refresh: boolean): Promise<void> => {
    if (refresh) setBusy(true);
    else setState('loading');
    try {
      const res = await getArenaCatalog(refresh);
      setDto(res);
      setState('ready');
      setError('');
    } catch (err) {
      setError(messageOf(err));
      if (!refresh) setState('error');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void fetchCatalog(false);
  }, [fetchCatalog]);

  /* 会话表：路径 → 当前时刻。每秒走一次，只在真有进行中场次时挂定时器 */
  const sessions = useMemo(() => {
    const out = new Map<string, { elapsed: number; paused: boolean }>();
    for (const path of listSessionPaths(store)) {
      const s = loadSession(store, path);
      // 走完或已「结束」的场次不再算进行中：那一行的动作回到 开始模拟 / 查看终榜
      if (s === null || s.ended) continue;
      out.set(path, { elapsed: elapsedOf(s, s.durationMs || Number.MAX_SAFE_INTEGER, now), paused: s.paused });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessionEpoch, now]);

  useEffect(() => {
    if (sessions.size === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [sessions.size]);

  const leaves = useMemo(() => (dto === null ? [] : flattenLeaves(dto.tree)), [dto]);
  const hits = useMemo(() => (q.trim() === '' ? [] : searchLeaves(leaves, q)), [leaves, q]);
  const total = dto?.total ?? 0;

  const toggle = (key: string): void => setOpen((o) => ({ ...o, [key]: !o[key] }));

  const headline = state === 'loading' ? '目录加载中' : state === 'error' ? '目录不可达' : catalogHeadline(total);

  return (
    <>
      <div className="topbar">
        <h2>模拟榜单</h2>
        <span className="topbar__meta">
          {state === 'ready' ? (
            <>
              目录 <b className="num" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{total}</b> 场 · 榜单来自官方快照
            </>
          ) : (
            headline
          )}
        </span>
        <span className="topbar__spacer" />
        <button className={`btn btn-sync${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => void fetchCatalog(true)}>
          <Icon id="i-sync" />
          {busy ? '拉取目录…' : '刷新目录'}
        </button>
      </div>

      <div className="content">
        <div className="catwrap">
          <div className="srchline">
            <div className="search">
              <Icon id="i-search" />
              <input
                type="text"
                value={q}
                placeholder="赛事名过滤，如 上海 / CCPC / 江苏"
                aria-label="搜索赛事"
                autoComplete="off"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <span className="srchline__n">
              {state !== 'ready' ? (
                ''
              ) : q.trim() === '' ? (
                <>
                  收录 <b>{total}</b> 场 · {sessions.size > 0 ? <>进行中 <b>{sessions.size}</b> 场</> : '展开分组逐场列出'}
                </>
              ) : (
                <>
                  命中 <b>{hits.length}</b> / {total} 场
                </>
              )}
            </span>
          </div>

          <div className="cat">
            {state === 'loading' ? <Loading /> : null}
            {state === 'error' ? <Failed text={error} onRetry={() => void fetchCatalog(false)} /> : null}
            {state === 'ready' && q.trim() !== '' ? <Found hits={hits} q={q} sessions={sessions} onEnter={onEnter} /> : null}
            {state === 'ready' && q.trim() === '' ? (
              <>
                {(dto?.tree ?? []).map((n) => (
                  <GroupView
                    key={n.name}
                    node={toGroupNode(n, [])}
                    depth={0}
                    openState={open}
                    toggle={toggle}
                    sessions={sessions}
                    onEnter={onEnter}
                    top
                  />
                ))}
              </>
            ) : null}
          </div>

          <div className="cat__foot">
            <span>
              来源 <b>algoux/srk-collection</b>（社区快照）· 回放的是已打完的比赛
            </span>
            <span className="spacer" />
            {state === 'ready' ? <span>{fetchedLabel(dto?.fetchedAt ?? null)}</span> : null}
          </div>
        </div>
      </div>
    </>
  );
}

const fetchedLabel = (epoch: number | null): string =>
  epoch === null ? '' : `目录缓存于 ${new Date(epoch * 1000).toLocaleString('zh-CN', { hour12: false })}`;

function Loading() {
  return (
    <div style={{ padding: '10px 18px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="skel">
        <i />
        正在拉目录 <code>official/config.yaml</code>…
      </div>
      {Array.from({ length: 7 }, (_, i) => (
        <div className="skel skel--row" key={i} style={{ height: 30 }}>
          <span className="skbar" style={{ width: 88 }} />
          <span className="skbar" style={{ width: 62 }} />
          <span className="skbar" style={{ flex: 1 }} />
          <span className="skbar" style={{ width: 150 }} />
        </div>
      ))}
    </div>
  );
}

function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div style={{ padding: '16px 18px 20px' }}>
      <div className="alert alert--err">
        <Icon id="i-plug" />
        <div>
          <b>目录拉取失败</b>（{text}）
        </div>
        <button className="alert__x" onClick={onRetry}>
          重试
        </button>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        本地没有目录缓存 · 不做假清单填空 —— 取不到就是空。
      </p>
    </div>
  );
}

function Found({ hits, q, sessions, onEnter }: { hits: LeafRow[]; q: string; sessions: Map<string, { elapsed: number; paused: boolean }>; onEnter: Props['onEnter'] }) {
  return (
    <>
      <div className="cyear cyear--flat">
        <div className="cyear__in">
          <b className="cyear__y">搜索结果</b>
          <span className="cyear__n">{hits.length} 场</span>
          <span className="cyear__p">“{q}”</span>
        </div>
      </div>
      {hits.length === 0 ? (
        <div style={{ padding: '22px 18px 26px' }}>
          <div className="skel">
            <i style={{ borderTopColor: 'var(--text-mute)', animation: 'none' }} />
            目录里没有匹配的赛事 · 换一场站名或年份
          </div>
        </div>
      ) : (
        hits.map((r, i) => <Row key={r.path} row={r} alt={i % 2 === 1} path={r.group.join(' / ')} live={sessions.get(r.path) ?? null} onEnter={onEnter} />)
      )}
    </>
  );
}

interface GroupProps {
  node: GroupNode;
  depth: number;
  openState: Record<string, boolean>;
  toggle: (key: string) => void;
  sessions: Map<string, { elapsed: number; paused: boolean }>;
  onEnter: Props['onEnter'];
  top?: boolean;
  chain?: string;
}

/** 分组行：顶层是 `.cgrp`，下层是 `.cyear`；展开态按「类目名 → 组名」这条链记，不写进存储 */
const GroupView = memo(function GroupView({ node, depth, openState, toggle, sessions, onEnter, top = false, chain = '' }: GroupProps) {
  const key = chain === '' ? node.name : `${chain} / ${node.name}`;
  // 顶层五类默认展开，往下一律折起：394 行全摊开等于没有目录
  const open = openState[key] ?? depth === 0;
  const count = node.count;

  const head = top ? (
    <button className="cgrp" aria-expanded={open} onClick={() => toggle(key)}>
      <Icon id="i-chev" className="cgrp__cv" />
      <span className="cgrp__n">{node.name}</span>
      <span className="cgrp__k">{subLabel(node)}</span>
      <span className="cgrp__r">
        <b>{count}</b> 场
      </span>
    </button>
  ) : (
    <div className={`cyear${node.kids.length > 0 ? ' cyear--grp' : ' cyear--flat'}${node.leaves.length === 0 && node.kids.length === 0 ? ' cyear--void' : ''}`}>
      <div className="cyear__in" role="button" tabIndex={0} aria-expanded={open} onClick={() => toggle(key)} onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(key);
        }
      }}>
        <Icon id="i-chev" className="cgrp__cv" />
        <b className="cyear__y">{node.name}</b>
        <span className="cyear__n">{count} 场</span>
        {node.kids.length > 0 ? <span className="cyear__p">按省 · 年份</span> : null}
      </div>
    </div>
  );

  if (!open) return <>{head}</>;
  return (
    <>
      {head}
      <div className="cbody" style={{ ['--d' as string]: depth + 1 }}>
        {node.kids.map((k) => (
          <GroupView key={k.name} node={k} depth={depth + 1} openState={openState} toggle={toggle} sessions={sessions} onEnter={onEnter} chain={key} />
        ))}
        {node.leaves.map((r, i) => (
          <Row key={r.path} row={r} alt={i % 2 === 1} live={sessions.get(r.path) ?? null} onEnter={onEnter} />
        ))}
      </div>
    </>
  );
});

const TierBadge = memo(function TierBadge({ tier, label }: { tier: string; label: string }) {
  return <span className={`tier tier--${tier}`}>{label}</span>;
});

const Row = memo(function Row({ row, live, alt = false, path, onEnter }: { row: LeafRow; live: { elapsed: number; paused: boolean } | null; alt?: boolean; path?: string; onEnter: Props['onEnter'] }) {
  return (
    <div className={`crow${alt ? ' is-alt' : ''}${live ? ' is-live' : ''}`}>
      <span className="crow__d">{row.date}</span>
      <TierBadge tier={row.badge.tier} label={row.badge.label} />
      <span className="crow__t">
        {row.name}
        {path ? <u>{path}</u> : null}
      </span>
      <span className="crow__acts">
        {live !== null ? (
          <>
            <span className={`crow__live${live.paused ? ' is-paused' : ''}`}>
              <i className={`dot ${live.paused ? 'dot--idle' : 'dot--live'}`} />
              {live.paused ? '已暂停 ' : '回放中 '}
              <span className="num">{clockHMS(live.elapsed)}</span>
            </span>
            <button className="btn btn--xs" onClick={() => onEnter(row, true)}>
              回到回放
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--xs btn--go" onClick={() => onEnter(row, true)}>
              <Icon id="i-play" />
              开始模拟
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => onEnter(row, false)}>
              <Icon id="i-eye" />
              查看终榜
            </button>
          </>
        )}
      </span>
    </div>
  );
});
