/**
 * 赛事目录（docs/contracts/16 §5.1 + docs/contracts/29 §6.1）：五类 → 年份 / 省 → 场次。
 *
 * 每场按**当前草稿**显示进行中 / 已结束未保存，不拿“最新存档”替代当前练习；
 * 历史成绩入口只打开选择层，不为整个外部目录逐场发请求。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArenaCatalogDto } from '@anvil/shared';
import { ApiError, createArenaRecord, getArenaCatalog, getArenaContest, updateArenaRecord } from '../../api.ts';
import { clockHMS, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { catalogHeadline, flattenLeaves, searchLeaves, toGroupNode, type GroupNode, type LeafRow } from './catalog.ts';
import { elapsedOf } from './engine.ts';
import {
  applySaveSuccess,
  buildCreatePayload,
  buildUpdatePayload,
  canSaveDraft,
  draftSummary,
  finishDraft,
  isDirty,
  listDraftPaths,
  loadDraft,
  saveDraft,
  type ArenaDraft,
} from './draft.ts';
import { arenaTitleOf, firstSaveName, newRecordId } from './record.ts';
import {
  loadOpenGroups,
  loadScrollTop,
  saveOpenGroups,
  saveScrollTop,
  type Store,
} from './session.ts';
import { NameDialog } from './ArenaDialogs.tsx';
import type { ArenaEntry } from './Arena.tsx';
import type { ArenaEntryMode } from './ArenaBoard.tsx';

interface Props {
  store: Store;
  onEnter: (row: LeafRow, mode: ArenaEntryMode, opts?: { recordId?: string | null; openHistory?: boolean }) => void;
  /** 草稿 / 目录版本号 */
  sessionEpoch: number;
  onCount: (n: number) => void;
  entry: ArenaEntry | null;
  onEntryConsumed: () => void;
}

interface PrefetchState {
  cachedNow: Set<string>;
  busyPath: string | null;
  prefetchErr: { path: string; text: string } | null;
  onPrefetch: (path: string) => void;
}

interface DraftRowState {
  draft: ArenaDraft | null;
  saving: boolean;
  savedNow: boolean;
  err: string;
}

const subLabel = (node: GroupNode): string =>
  node.kids.length > 0 ? (node.name === '省赛' ? '按省分组' : node.name === '校赛' ? '按学校' : '按年份') : '按场次';

export function ArenaCatalog({ store, onEnter, sessionEpoch, onCount, entry, onEntryConsumed }: Props) {
  const [dto, setDto] = useState<ArenaCatalogDto | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [stale, setStale] = useState<{ message: string; fetchedAt: number } | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => loadOpenGroups(store));
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [cachedNow, setCachedNow] = useState<Set<string>>(() => new Set<string>());
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [prefetchErr, setPrefetchErr] = useState<{ path: string; text: string } | null>(null);
  const scrollBox = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);
  const [draftRev, setDraftRev] = useState(0);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState<Set<string>>(() => new Set<string>());
  const [saveErr, setSaveErr] = useState<{ path: string; text: string } | null>(null);
  const [nameState, setNameState] = useState<{ row: LeafRow; draft: ArenaDraft; initial: string } | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const [pruned, setPruned] = useState(0);
  const [sessionRev, setSessionRev] = useState(0);
  const dtoRef = useRef<ArenaCatalogDto | null>(null);

  const fetchCatalog = useCallback(
    async (refresh: boolean): Promise<void> => {
      if (refresh) setBusy(true);
      else setState('loading');
      setPruned(0);
      try {
        const res = await getArenaCatalog(refresh);
        dtoRef.current = res;
        setDto(res);
        setState('ready');
        setError('');
        setStale(res.stale === true ? { message: res.refreshError ?? '上游取不到新目录', fetchedAt: res.fetchedAt } : null);
        setPruned(res.pruned ?? 0);
        onCount(res.total);
      } catch (err) {
        const text = messageOf(err);
        setError(text);
        if (dtoRef.current === null) {
          setState('error');
          setStale(null);
        } else {
          setState('ready');
          setStale({ message: text, fetchedAt: dtoRef.current.fetchedAt });
        }
      } finally {
        setBusy(false);
      }
    },
    [onCount],
  );

  useEffect(() => {
    void fetchCatalog(false);
  }, [fetchCatalog]);

  /* 每场一份草稿：单键枚举，解析失败当没有（正式档另走接口） */
  const drafts = useMemo(() => {
    const out = new Map<string, ArenaDraft>();
    for (const path of listDraftPaths(store)) {
      const loaded = loadDraft(store, path);
      if (loaded.kind === 'draft') out.set(path, loaded.draft);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessionEpoch, draftRev, sessionRev]);

  const livePaths = useMemo(() => {
    const out = new Map<string, { elapsed: number; paused: boolean }>();
    for (const [path, d] of drafts) {
      if (d.phase !== 'running' || d.session === null) continue;
      out.set(path, { elapsed: elapsedOf(d.session, d.session.durationMs || Number.MAX_SAFE_INTEGER, now), paused: d.session.paused });
    }
    return out;
  }, [drafts, now]);

  useEffect(() => {
    if (livePaths.size === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [livePaths.size]);

  const endDraft = useCallback(
    (row: LeafRow): void => {
      const loaded = loadDraft(store, row.path);
      if (loaded.kind !== 'draft') return;
      const d = loaded.draft;
      if (d.phase !== 'running' || d.session === null) return;
      const span = d.session.durationMs;
      if (span <= 0) {
        setSaveErr({ path: row.path, text: '先打开本场加载榜单，才能结束并记录停止时间' });
        return;
      }
      const at = elapsedOf(d.session, span, Date.now());
      const next = finishDraft(d, span, at, Date.now());
      if (!saveDraft(store, row.path, next)) {
        setSaveErr({ path: row.path, text: '浏览器存储写不进去：结束状态没有保存' });
        return;
      }
      setSaveErr(null);
      setSessionRev((n) => n + 1);
      setDraftRev((n) => n + 1);
    },
    [store],
  );

  /* 目录行保存：有目标走更新（版本校验），无目标先开命名对话框 */
  const saveRow = useCallback(
    async (row: LeafRow, draft: ArenaDraft, name?: string): Promise<boolean> => {
      if (!canSaveDraft(draft)) {
        setSaveErr({ path: row.path, text: '还没有结束信息，不能保存' });
        return false;
      }
      setSavingPath(row.path);
      setSaveErr(null);
      try {
        if (draft.target !== null) {
          const payload = buildUpdatePayload(draft, {
            arenaPath: row.path,
            recordId: draft.target.recordId,
            expectedRevision: draft.target.revision,
          });
          if (payload === null) throw new Error('缺少结束信息');
          const res = await updateArenaRecord(payload);
          const next = applySaveSuccess(draft, res.record, res.revision);
          if (!saveDraft(store, row.path, next)) {
            setSaveErr({ path: row.path, text: '浏览器存储写不进去' });
            return false;
          }
          setSavedNow((prev) => new Set(prev).add(row.path));
          setDraftRev((n) => n + 1);
          setSessionRev((n) => n + 1);
          return true;
        }
        if (name === undefined) {
          setNameState({ row, draft, initial: firstSaveName() });
          return false;
        }
        const recordId = newRecordId();
        const payload = buildCreatePayload(draft, { arenaPath: row.path, contestTitle: arenaTitleOf(row), recordId, name });
        if (payload === null) throw new Error('缺少结束信息');
        const frozen: ArenaDraft = { ...draft, pendingSave: { recordId, payload } };
        if (!saveDraft(store, row.path, frozen)) {
          setSaveErr({ path: row.path, text: '浏览器存储写不进去：没有发送保存请求' });
          return false;
        }
        try {
          const res = await createArenaRecord(payload);
          const next = applySaveSuccess(frozen, res.record, res.revision);
          if (!saveDraft(store, row.path, next)) {
            setSaveErr({ path: row.path, text: '浏览器存储写不进去' });
            return false;
          }
          setSavedNow((prev) => new Set(prev).add(row.path));
          setDraftRev((n) => n + 1);
          setSessionRev((n) => n + 1);
          return true;
        } catch (err) {
          if (err instanceof ApiError && (err.kind === 'timeout' || err.kind === 'offline' || err.kind === 'aborted')) {
            setDraftRev((n) => n + 1);
            setSaveErr({ path: row.path, text: '保存结果未知：打开本场用「重试对账」确认' });
          } else {
            if (saveDraft(store, row.path, { ...frozen, pendingSave: null })) setDraftRev((n) => n + 1);
            setSaveErr({ path: row.path, text: messageOf(err) });
          }
          return false;
        }
      } catch (err) {
        setSaveErr({ path: row.path, text: messageOf(err) });
        return false;
      } finally {
        setSavingPath(null);
      }
    },
    [store],
  );

  const requestSaveRow = useCallback(
    (row: LeafRow): void => {
      const loaded = loadDraft(store, row.path);
      if (loaded.kind !== 'draft') return;
      const d = loaded.draft;
      if (d.pendingSave !== null) {
        setSaveErr({ path: row.path, text: '上次保存结果未确认：打开本场重试对账' });
        return;
      }
      if (d.target !== null) {
        void saveRow(row, d);
        return;
      }
      setSaveErr(null);
      setNameState({ row, draft: d, initial: firstSaveName() });
    },
    [saveRow, store],
  );

  /* 深链 / 工坊入口：指定档只读打开；无 record 时进当前练习（有草稿）或终榜 */
  const entryKey = entry === null ? null : `${entry.path}|${entry.recordId ?? ''}|${entry.restoreLegacy ? 'restore' : ''}`;
  useEffect(() => {
    if (entry === null || state !== 'ready') return;
    const row = flattenLeaves(dto?.tree ?? []).find((r) => r.path === entry.path);
    if (row === undefined) {
      setRestoreErr(`目录里找不到这场：${entry.path}`);
      onEntryConsumed();
      return;
    }
    if (entry.restoreLegacy) {
      onEnter(row, 'restore-legacy');
      onEntryConsumed();
      return;
    }
    if (entry.recordId !== null) {
      onEnter(row, 'record', { recordId: entry.recordId });
      onEntryConsumed();
      return;
    }
    const loaded = loadDraft(store, entry.path);
    onEnter(row, loaded.kind === 'draft' && loaded.draft.phase !== 'legacy-unconfirmed' ? 'practice' : 'review');
    onEntryConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, state, dto]);

  useEffect(() => {
    setRestoreErr(null);
  }, [entryKey]);

  const leaves = useMemo(() => (dto === null ? [] : flattenLeaves(dto.tree)), [dto]);
  const hits = useMemo(() => (q.trim() === '' ? [] : searchLeaves(leaves, q)), [leaves, q]);
  const total = dto?.total ?? 0;

  useEffect(() => {
    setSavedNow(new Set());
    setSaveErr(null);
    setNameState(null);
  }, [sessionEpoch]);

  /* 工坊「回到回放」/ 深链：目录就绪后按路径找行（上面 effect 已处理），这里保留错误提示 */

  const prefetch = useCallback(async (path: string): Promise<void> => {
    setBusyPath(path);
    setPrefetchErr(null);
    try {
      await getArenaContest(path);
      setCachedNow((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
    } catch (err) {
      setPrefetchErr({ path, text: messageOf(err) });
    } finally {
      setBusyPath(null);
    }
  }, []);

  const onPrefetch = useCallback(
    (path: string): void => {
      void prefetch(path);
    },
    [prefetch],
  );

  const pf = useMemo<PrefetchState>(() => ({ cachedNow, busyPath, prefetchErr, onPrefetch }), [cachedNow, busyPath, prefetchErr, onPrefetch]);

  const toggle = (key: string): void =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveOpenGroups(store, next);
      return next;
    });

  useEffect(() => {
    if (state !== 'ready') return;
    const el = scrollBox.current;
    if (el === null) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = loadScrollTop(store);
    });
    return () => cancelAnimationFrame(id);
  }, [state, store]);

  const onScroll = useCallback((): void => {
    if (q.trim() !== '') return;
    const el = scrollBox.current;
    if (el === null) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => saveScrollTop(store, el.scrollTop), 150);
  }, [q, store]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const headline = state === 'loading' ? '目录加载中' : state === 'error' ? '目录不可达' : catalogHeadline(total);

  const rowState = (row: LeafRow): DraftRowState => {
    const draft = drafts.get(row.path) ?? null;
    return {
      draft,
      saving: savingPath === row.path,
      savedNow: savedNow.has(row.path),
      err: saveErr?.path === row.path ? saveErr.text : '',
    };
  };

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

      <div className="content" ref={scrollBox} onScroll={onScroll}>
        <div className="catwrap">
          {restoreErr !== null ? (
            <div className="alert alert--warn" role="status" style={{ marginBottom: 12 }}>
              <Icon id="i-warn" />
              <div>{restoreErr}</div>
            </div>
          ) : null}
          {stale !== null ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>
                <b>刷新失败</b>，正在显示旧缓存 · {fetchedLabel(stale.fetchedAt)}
                <div className="cat-stale__reason">{stale.message}</div>
              </div>
              <button className="alert__x" type="button" disabled={busy} onClick={() => void fetchCatalog(true)}>
                重试
              </button>
            </div>
          ) : null}
          <div className="srchline">
            <div className="search">
              <Icon id="i-search" />
              <input type="text" value={q} placeholder="赛事名过滤，如 上海 / CCPC / 江苏" aria-label="搜索赛事" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
            </div>
            <span className="srchline__n">
              {state !== 'ready' ? (
                ''
              ) : q.trim() === '' ? (
                <>
                  收录 <b>{total}</b> 场 · {livePaths.size > 0 ? <>进行中 <b>{livePaths.size}</b> 场</> : '展开分组逐场列出'}
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
            {state === 'ready' && q.trim() !== '' ? (
              <Found hits={hits} q={q} livePaths={livePaths} rowState={rowState} onEnter={onEnter} onEndDraft={endDraft} onSaveDraft={requestSaveRow} pf={pf} />
            ) : null}
            {state === 'ready' && q.trim() === '' ? (
              <>
                {(dto?.tree ?? []).map((n) => (
                  <GroupView
                    key={n.name}
                    node={toGroupNode(n, [])}
                    depth={0}
                    openState={open}
                    toggle={toggle}
                    livePaths={livePaths}
                    rowState={rowState}
                    onEnter={onEnter}
                    onEndDraft={endDraft}
                    onSaveDraft={requestSaveRow}
                    pf={pf}
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
            {pruned > 0 ? <span>已清理 {pruned} 个过期缓存</span> : null}
            <span className="spacer" />
            {state === 'ready' ? <span>{fetchedLabel(dto?.fetchedAt ?? null)}</span> : null}
          </div>
        </div>
      </div>

      {nameState !== null ? (
        <NameDialog
          title="保存成绩"
          sub="这是第一次保存这份草稿；名称默认本地日期时间，可修改。"
          initial={nameState.initial}
          confirmLabel="保存"
          busy={nameBusy}
          error={saveErr?.path === nameState.row.path ? saveErr.text : null}
          onCancel={() => setNameState(null)}
          onConfirm={(name) => {
            const state = nameState;
            setNameBusy(true);
            void saveRow(state.row, state.draft, name).then((ok) => {
              setNameBusy(false);
              if (ok) setNameState(null);
            });
          }}
        />
      ) : null}
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
          <b>目录拉取失败</b>（无可用缓存；{text}）
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

const prefetchOf = (r: LeafRow, pf: PrefetchState): { cached: boolean; busy: boolean; err: string } => ({
  cached: r.cached === true || pf.cachedNow.has(r.path),
  busy: pf.busyPath === r.path,
  err: pf.prefetchErr?.path === r.path ? pf.prefetchErr.text : '',
});

function Found({
  hits,
  q,
  livePaths,
  rowState,
  onEnter,
  onEndDraft,
  onSaveDraft,
  pf,
}: {
  hits: LeafRow[];
  q: string;
  livePaths: Map<string, { elapsed: number; paused: boolean }>;
  rowState: (row: LeafRow) => DraftRowState;
  onEnter: Props['onEnter'];
  onEndDraft: (row: LeafRow) => void;
  onSaveDraft: (row: LeafRow) => void;
  pf: PrefetchState;
}) {
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
        hits.map((r, i) => (
          <Row
            key={r.path}
            row={r}
            alt={i % 2 === 1}
            path={r.group.join(' / ')}
            live={livePaths.get(r.path) ?? null}
            state={rowState(r)}
            onEnter={onEnter}
            onEndDraft={onEndDraft}
            onSaveDraft={onSaveDraft}
            {...prefetchOf(r, pf)}
            onPrefetch={pf.onPrefetch}
          />
        ))
      )}
    </>
  );
}

interface GroupProps {
  node: GroupNode;
  depth: number;
  openState: Set<string>;
  toggle: (key: string) => void;
  livePaths: Map<string, { elapsed: number; paused: boolean }>;
  rowState: (row: LeafRow) => DraftRowState;
  onEnter: Props['onEnter'];
  onEndDraft: (row: LeafRow) => void;
  onSaveDraft: (row: LeafRow) => void;
  pf: PrefetchState;
  top?: boolean;
  chain?: string;
}

const GroupView = memo(function GroupView({
  node,
  depth,
  openState,
  toggle,
  livePaths,
  rowState,
  onEnter,
  onEndDraft,
  onSaveDraft,
  pf,
  top = false,
  chain = '',
}: GroupProps) {
  const key = chain === '' ? node.name : `${chain} / ${node.name}`;
  const open = openState.has(key);
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
      <div
        className="cyear__in"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggle(key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(key);
          }
        }}
      >
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
          <GroupView
            key={k.name}
            node={k}
            depth={depth + 1}
            openState={openState}
            toggle={toggle}
            livePaths={livePaths}
            rowState={rowState}
            onEnter={onEnter}
            onEndDraft={onEndDraft}
            onSaveDraft={onSaveDraft}
            pf={pf}
            chain={key}
          />
        ))}
        {node.leaves.map((r, i) => (
          <Row
            key={r.path}
            row={r}
            alt={i % 2 === 1}
            live={livePaths.get(r.path) ?? null}
            state={rowState(r)}
            onEnter={onEnter}
            onEndDraft={onEndDraft}
            onSaveDraft={onSaveDraft}
            {...prefetchOf(r, pf)}
            onPrefetch={pf.onPrefetch}
          />
        ))}
      </div>
    </>
  );
});

const TierBadge = memo(function TierBadge({ tier, label }: { tier: string; label: string }) {
  return <span className={`tier tier--${tier}`}>{label}</span>;
});

interface RowProps {
  row: LeafRow;
  live: { elapsed: number; paused: boolean } | null;
  state: DraftRowState;
  alt?: boolean;
  path?: string;
  onEnter: Props['onEnter'];
  onEndDraft: (row: LeafRow) => void;
  onSaveDraft: (row: LeafRow) => void;
  cached: boolean;
  busy: boolean;
  err: string;
  onPrefetch: (path: string) => void;
}

const Row = memo(function Row({ row, live, state, alt = false, path, onEnter, onEndDraft, onSaveDraft, cached, busy, err, onPrefetch }: RowProps) {
  const draft = state.draft;
  const saving = state.saving;
  const finished = draft !== null && draft.phase === 'finished';
  const running = draft !== null && draft.phase === 'running' && live !== null;
  const canSave = finished && canSaveDraft(draft) && (draft.target === null || isDirty(draft));
  const errText = err !== '' ? err : state.err;
  const status = draft === null ? null : draftSummary(draft);
  return (
    <div className={`crow${alt ? ' is-alt' : ''}${running ? ' is-live' : ''}${draft !== null ? ' has-draft' : ''}`}>
      <span className="crow__d">{row.date}</span>
      <TierBadge tier={row.badge.tier} label={row.badge.label} />
      <span className="crow__t">
        {row.name}
        {path ? <u>{path}</u> : null}
        {status !== null ? <i className={`crow__status${draft !== null && isDirty(draft) ? ' is-dirty' : ''}`}>{status}</i> : null}
      </span>
      <span className="crow__acts">
        {running ? (
          <>
            <span className={`crow__live${live.paused ? ' is-paused' : ''}`}>
              <i className={`dot ${live.paused ? 'dot--idle' : 'dot--live'}`} />
              {live.paused ? '已暂停 ' : '进行中 '}
              <span className="num">{clockHMS(live.elapsed)}</span>
            </span>
            <button className="btn btn--xs" onClick={() => onEnter(row, 'practice')}>
              回到练习
            </button>
            <button className="btn btn--xs btn--ghost" title="结束本次练习；结束状态会记进当前草稿，不会自动保存正式档" onClick={() => onEndDraft(row)}>
              结束
            </button>
            <button className="btn btn--xs btn--ghost" title="只读看终榜，不改当前练习" onClick={() => onEnter(row, 'review')}>
              查看终榜
            </button>
          </>
        ) : draft !== null ? (
          <>
            <button className="btn btn--xs btn--go" onClick={() => onEnter(row, 'practice')}>
              <Icon id="i-eye" />
              {finished ? '查看成绩' : '查看录入'}
            </button>
            <button className="btn btn--xs btn--ghost" title="只读看终榜，不改当前草稿" onClick={() => onEnter(row, 'review')}>
              查看终榜
            </button>
            {canSave ? (
              <button className="btn btn--xs" disabled={saving} onClick={() => onSaveDraft(row)} title="保存到工坊；已有目标时只更新那一档">
                <Icon id="i-save" />
                {saving ? '保存中…' : state.savedNow ? '已保存' : '保存成绩'}
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button className="btn btn--xs btn--go" onClick={() => onEnter(row, 'practice')}>
              <Icon id="i-play" />
              开始模拟
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => onEnter(row, 'review')}>
              <Icon id="i-eye" />
              查看终榜
            </button>
            {cached ? (
              <span className="crow__cache">
                <i className="dot dot--ok" />
                本地
              </span>
            ) : (
              <button className="btn btn--xs btn--ghost" disabled={busy} title="把这一场的榜单快照先拉到本地缓存" onClick={() => onPrefetch(row.path)}>
                <Icon id="i-sync" />
                {busy ? '拉取中…' : '预拉取'}
              </button>
            )}
          </>
        )}
        <button className="btn btn--xs btn--ghost" title="历史成绩 · 查看 / 编辑这场保存过的成绩" onClick={() => onEnter(row, 'review', { openHistory: true })}>
          <Icon id="i-clock" />
          历史成绩
        </button>
      </span>
      {errText === '' ? null : (
        <span className="crow__err" title={errText}>
          {errText}
        </span>
      )}
    </div>
  );
});
