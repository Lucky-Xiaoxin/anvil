import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkKind, WorkObjectDetailDto, WorkObjectDto, WorkTrashDto, WorkTreeDto } from '@anvil/shared';
import {
  ApiError,
  getWorkObject,
  getWorkTree,
  initWork,
  openWork,
  purgeWorkTrash,
  restoreArenaRecord,
  restoreWork,
  rescanWork,
  trashWork,
  updateWork,
} from '../../api.ts';
import { messageOf } from '../../format.ts';
import { NoticeBar } from '../Dashboard.tsx';
import { Icon } from '../ui.tsx';
import { WorkCreate, type WorkDialog } from './WorkCreate.tsx';
import { WorkDetail } from './WorkDetail.tsx';
import { WorkImport } from './WorkImport.tsx';
import { WorkList } from './WorkList.tsx';
import { KIND_NAME, KIND_ORDER, filterWorkObjects, kindCounts } from './derive.ts';
import { importResultSummary } from './import-derive.ts';
import { createLatestGate } from './latest.ts';

interface Notice {
  kind: 'err' | 'ok' | 'warn';
  text: string;
}

export interface MasterEntry {
  objectId: string;
  panel: 'problems' | null;
}

interface Props {
  /** 深链 `#/master?object=...&panel=problems`：只在活动视图里定位；归档 / 回收站按不可用处理 */
  entry: MasterEntry | null;
  onEntryConsumed: () => void;
}

interface SetupState {
  kind: string;
  message: string;
}

const SETUP_KINDS = new Set(['workspace-unconfigured', 'workspace-uninitialized', 'root-missing', 'root-invalid', 'root-version']);
const LEAVE_MARKS_TEXT = '标记尚未保存：离开会丢掉本地未提交的修改。继续？';

function RootSetup({ setup, onReady }: { setup: SetupState; onReady: (tree: WorkTreeDto) => void }) {
  const [path, setPath] = useState('');
  const [confirm, setConfirm] = useState<{ path: string; entries: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(confirmExisting: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const tree = await initWork(path.trim(), confirmExisting);
      onReady(tree);
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      if (api.kind === 'root-not-empty') {
        setConfirm({ path: path.trim(), entries: api.entries ?? 0 });
      } else {
        setErr(api.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wk-setup-wrap">
      <div className="card wk-setup rise">
        <span className="label label--accent">Workshop</span>
        <h3 className="wk-setup__title">先把工坊的受管根定下来</h3>
        <p className="wk-setup__msg">{setup.message}</p>
        <label className="wk-field">
          <span className="wk-label">受管根（绝对路径）</span>
          <input
            className="input"
            value={path}
            placeholder="E:/ANVIL-Work"
            spellCheck={false}
            title="支持 / 与 \；可直接粘贴资源管理器「复制为路径」的带引号路径"
            onChange={(e) => {
              setPath(e.target.value);
              setConfirm(null);
              setErr(null);
            }}
            onBlur={() => {
              setPath((p) => p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/'));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run(false);
            }}
          />
          <span className="wk-hint">/ 与 \ 都行；资源管理器「复制为路径」的引号会自动去掉。</span>
        </label>
        <ul className="wk-setup__rules">
          <li>只创建 <code>.anvil/</code> 与 contests / practice / templates / notes 四个顶层目录。</li>
          <li>不移动、不改名、不删除根里已有的任何文件。</li>
          <li>根目录不能位于本仓库或 <code>vault/</code> 内；初始化后路径不可由界面更改。</li>
        </ul>
        {confirm !== null ? (
          <div className="alert alert--warn" role="status">
            <Icon id="i-warn" />
            <div>
              <b>这个目录里已经有 {confirm.entries} 项</b>
              <br />
              确认初始化只会补 `.anvil/` 与四个顶层目录，不会搬动已有内容。
            </div>
          </div>
        ) : null}
        {err !== null ? <div className="alert alert--err" role="status">{err}</div> : null}
        <div className="wk-setup__actions">
          {confirm === null ? (
            <button className="btn btn--primary" disabled={busy || path.trim() === ''} onClick={() => void run(false)}>
              {busy ? '初始化中…' : '初始化工作区'}
            </button>
          ) : (
            <button className="btn btn--primary" disabled={busy} onClick={() => void run(true)}>
              {busy ? '初始化中…' : '确认初始化（不搬动已有文件）'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Workbench({ entry, onEntryConsumed }: Props) {
  const [tree, setTree] = useState<WorkTreeDto | null>(null);
  /** 全量对象（活动 + 归档两个视图合并，27 §5.3）：关联状态 / 关联展示统一走这一份派生 */
  const [allObjects, setAllObjects] = useState<WorkObjectDto[]>([]);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [archived, setArchived] = useState(false);
  const [kindFilter, setKindFilter] = useState<WorkKind | 'all'>('all');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkObjectDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 详情请求序号：快速连点两个对象时，只让最后一次响应落地 */
  const detailSeq = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  /** 树请求序号 + 取消：快速切活动 / 归档时只让最后一次响应落地 */
  const treeGate = useMemo(createLatestGate, []);
  const treeAbort = useRef<AbortController | null>(null);
  const selectionGate = useMemo(createLatestGate, []);
  /** 当前视图 / 选中项的同步镜像：异步响应回来时按“此刻”判定，不用闭包里的旧值 */
  const archivedRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const detailRef = useRef<WorkObjectDetailDto | null>(null);
  detailRef.current = detail;
  const [busy, setBusy] = useState<string | null>(null);
  /** 题目标记有未落盘修改：切对象 / 切视图前确认，不静默丢（30 §6.2） */
  const marksUnsaved = useRef(false);
  /** 只确认、不清标志：调用方失败或对话框被取消时面板还在，保护必须继续生效 */
  const confirmLeaveMarks = useCallback((): boolean => {
    if (!marksUnsaved.current) return true;
    return window.confirm(LEAVE_MARKS_TEXT);
  }, []);
  /** 确认并清标志：只给「确认后一定会卸载面板 / 路由离开」的入口用，避免 App 的 hashchange 守卫二次弹窗 */
  const canLeaveMarks = useCallback((): boolean => {
    if (!confirmLeaveMarks()) return false;
    marksUnsaved.current = false;
    (window as unknown as { __anvilMarksUnsaved?: boolean }).__anvilMarksUnsaved = false;
    return true;
  }, [confirmLeaveMarks]);
  const [trashView, setTrashView] = useState(false);
  const [dialog, setDialog] = useState<WorkDialog | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const clearDetail = useCallback((): void => {
    detailSeq.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
    setDetailLoading(false);
    setDetail(null);
  }, []);

  const setSelected = useCallback((id: string | null): void => {
    selectionGate.invalidate();
    selectedIdRef.current = id;
    setSelectedId(id);
  }, [selectionGate]);

  const setViewArchived = useCallback((next: boolean): void => {
    archivedRef.current = next;
    setArchived(next);
  }, []);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    const seq = ++detailSeq.current;
    detailAbort.current?.abort();
    const abort = new AbortController();
    detailAbort.current = abort;
    setDetailLoading(true);
    try {
      const next = await getWorkObject(id, abort.signal);
      if (seq !== detailSeq.current) return;
      setDetail(next);
    } catch (error) {
      if (seq !== detailSeq.current) return;
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      if (api.kind === 'aborted') return;
      setNotice({ kind: 'err', text: api.message });
      setDetail(null);
    } finally {
      if (detailAbort.current === abort) detailAbort.current = null;
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  /** 模板保存后刷新详情 / 文件列表，但不走整块 loading，避免编辑器卸载重挂、丢掉「已保存」 */
  const refreshDetailQuietly = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await getWorkObject(id);
      if (selectedIdRef.current !== id) return;
      setDetail((prev) => (prev?.id === id ? next : prev));
    } catch (error) {
      if (selectedIdRef.current !== id) return;
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setNotice({ kind: 'err', text: api.message });
    }
  }, []);

  const load = useCallback(
    async (archivedNext: boolean, rescan: boolean, selectId?: string | null): Promise<WorkTreeDto | null> => {
      const token = treeGate.begin();
      const selectionToken = selectionGate.begin();
      treeAbort.current?.abort();
      const abort = new AbortController();
      treeAbort.current = abort;
      setLoading(true);
      setNotice(null);
      try {
        // 当前视图带 rescan（首次进入）；对面视图只读一份，用来拼全量 byId（27 §5.3）
        const [next, other] = await Promise.all([
          getWorkTree({ archived: archivedNext, rescan, signal: abort.signal }),
          getWorkTree({ archived: !archivedNext, signal: abort.signal }),
        ]);
        if (!treeGate.isCurrent(token)) return null;
        setTree(next);
        setAllObjects([...next.objects, ...other.objects]);
        setSetup(null);
        if (selectId !== undefined && selectionGate.isCurrent(selectionToken)) {
          const exists = selectId !== null && next.objects.some((o) => o.id === selectId);
          setSelected(exists ? selectId : null);
          if (exists && selectId !== null) void loadDetail(selectId);
          else clearDetail();
        } else {
          // 选中项以响应回来时的用户操作为准：加载期间新点的对象不应该被清掉
          const current = selectedIdRef.current;
          const exists = current !== null && next.objects.some((o) => o.id === current);
          setSelected(exists ? current : null);
          if (!exists) clearDetail();
        }
        return next;
      } catch (error) {
        if (!treeGate.isCurrent(token)) return null;
        const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
        if (api.kind === 'aborted') return null;
        if (SETUP_KINDS.has(api.kind)) {
          setSetup({ kind: api.kind, message: api.message });
          setTree(null);
          clearDetail();
          setSelected(null);
        } else {
          setNotice({ kind: 'err', text: api.message });
        }
        return null;
      } finally {
        if (treeAbort.current === abort) treeAbort.current = null;
        if (treeGate.isCurrent(token)) setLoading(false);
      }
    },
    [clearDetail, loadDetail, selectionGate, setSelected, treeGate],
  );

  useEffect(() => {
    void load(false, true);
    // 只在首次进入工坊时建索引；archived 切换走下面的显式调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 深链（30 §6.4）：只在活动视图定位；归档 / 回收站 / 不存在一律不可用，停在列表 */
  /** 记录已处理的那一个 entry 对象（App 每次 hashchange 都会新建）；同 key 的新深链仍会重新处理 */
  const entryHandled = useRef<MasterEntry | null>(null);
  const focusAfterDetail = useRef<{ objectId: string; panel: 'problems' } | null>(null);
  useEffect(() => {
    if (entry === null) return;
    // 未初始化 / 根不可用：走设置引导，深链不追加班（30 §6.4）
    if (setup !== null) {
      onEntryConsumed();
      return;
    }
    if (tree === null || loading) return;
    if (entryHandled.current === entry) return;
    const exists = tree.objects.some((obj) => obj.id === entry.objectId && obj.kind === 'contest');
    if (!exists) {
      entryHandled.current = entry;
      setNotice({ kind: 'err', text: '这场比赛不可用' });
      onEntryConsumed();
      return;
    }
    // 同一个对象已经在看：只定位，不重载详情（重载会卸载面板、丢掉未保存的标记）
    if (entry.objectId === selectedIdRef.current && detailRef.current?.id === entry.objectId) {
      entryHandled.current = entry;
      setTrashView(false);
      if (entry.panel === 'problems') {
        const el = document.getElementById('wk-problems');
        if (el !== null) {
          el.scrollIntoView({ block: 'start' });
          el.focus({ preventScroll: true });
        } else {
          focusAfterDetail.current = { objectId: entry.objectId, panel: 'problems' };
        }
      }
      onEntryConsumed();
      return;
    }
    if (!canLeaveMarks()) {
      // 用户选择保留本地修改：地址栏退回当前对象，避免 URL 与界面不一致
      entryHandled.current = entry;
      onEntryConsumed();
      const current = selectedIdRef.current;
      window.history.replaceState(null, '', current === null ? '#/master' : `#/master?object=${encodeURIComponent(current)}`);
      return;
    }
    entryHandled.current = entry;
    setTrashView(false);
    setSelected(entry.objectId);
    void loadDetail(entry.objectId);
    if (entry.panel === 'problems') focusAfterDetail.current = { objectId: entry.objectId, panel: 'problems' };
    onEntryConsumed();
  }, [entry, tree, loading, setup, loadDetail, onEntryConsumed, setSelected, canLeaveMarks]);

  useEffect(() => {
    const target = focusAfterDetail.current;
    if (target === null || detail === null || detail.id !== target.objectId) return;
    const el = document.getElementById('wk-problems');
    if (el === null) return;
    focusAfterDetail.current = null;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }, [detail]);

  useEffect(
    () => () => {
      treeGate.invalidate();
      treeAbort.current?.abort();
      detailSeq.current += 1;
      detailAbort.current?.abort();
    },
    [treeGate],
  );

  const openTrash = (): void => {
    if (trashView) {
      setTrashView(false);
      return;
    }
    if (!canLeaveMarks()) return;
    setTrashView(true);
    setSelected(null);
    clearDetail();
    setPendingOnly(false);
    setLabelFilter(null);
    setKindFilter('all');
  };

  const selectObject = (id: string): void => {
    // 点当前行不重载：重载会卸载标记面板，白白丢掉未保存的本地修改
    if (id === selectedIdRef.current && detailRef.current?.id === id) return;
    if (!canLeaveMarks()) return;
    setTrashView(false);
    setSelected(id);
    void loadDetail(id);
  };

  const afterMutation = async (label: string, make: () => Promise<WorkObjectDetailDto>): Promise<void> => {
    if (busy !== null) return;
    // 改标题 / 标签 / 归档 / 关联完成后会重载详情、卸载标记面板（30 §6.2）
    if (!confirmLeaveMarks()) return;
    const viewAtStart = archivedRef.current;
    const selectionAtStart = selectedIdRef.current;
    setBusy(label);
    setNotice(null);
    try {
      const made = await make();
      const next = await load(archivedRef.current, false);
      // 用户在这次操作期间切了视图或换了选中项：别用旧操作的完成态抢回去
      if (next !== null && archivedRef.current === viewAtStart && selectedIdRef.current === selectionAtStart) {
        if (next.objects.some((o) => o.id === made.id)) {
          clearDetail();
          setSelected(made.id);
          setDetail(made);
        } else {
          setSelected(null);
          clearDetail();
        }
      }
      setNotice({ kind: 'ok', text: '已保存' });
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setNotice({ kind: 'err', text: api.message });
    } finally {
      setBusy(null);
    }
  };

  const rescan = async (): Promise<void> => {
    if (busy !== null) return;
    // 重新扫描后会重载选中对象详情，标记面板会重新挂载（30 §6.2）
    if (!confirmLeaveMarks()) return;
    setBusy('rescan');
    setNotice(null);
    try {
      const summary = await rescanWork();
      const next = await load(archivedRef.current, false);
      if (next !== null && selectedIdRef.current !== null) void loadDetail(selectedIdRef.current);
      setNotice({ kind: 'ok', text: `扫描完成：${summary.objects} 个对象 · 未登记 ${summary.unregistered} · 错误 ${summary.errors}` });
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setNotice({ kind: 'err', text: api.message });
    } finally {
      setBusy(null);
    }
  };

  const toggleArchived = (): void => {
    if (!canLeaveMarks()) return;
    const next = !archivedRef.current;
    setViewArchived(next);
    setTrashView(false);
    setSelected(null);
    clearDetail();
    void load(next, false);
  };

  const filtered = useMemo(
    () => filterWorkObjects(tree?.objects ?? [], { kind: kindFilter, label: labelFilter, query, pendingOnly }),
    [tree, kindFilter, labelFilter, query, pendingOnly],
  );
  const counts = useMemo(() => kindCounts(tree?.objects ?? []), [tree]);
  const allById = useMemo(() => new Map(allObjects.map((obj) => [obj.id, obj])), [allObjects]);
  /** 活动比赛（跨视图口径）：新建 / 登记对话框的关联选择器只列活动比赛（27 §5.2） */
  const activeContests = useMemo(() => allObjects.filter((obj) => obj.kind === 'contest' && !obj.effectiveArchived), [allObjects]);
  const parentTitle = detail === null || detail.parentId === null ? null : (allById.get(detail.parentId)?.title ?? null);

  if (setup !== null) {
    return (
      <div className="content wk-page">
        <RootSetup
          setup={setup}
          onReady={(next) => {
            setTree(next);
            setAllObjects(next.objects);
            setSetup(null);
            setViewArchived(false);
            setNotice({ kind: 'ok', text: '工作区已初始化' });
          }}
        />
      </div>
    );
  }

  if (loading && tree === null) {
    return (
      <div className="content">
        <p className="hint">正在读取受管工作区…</p>
      </div>
    );
  }

  if (tree === null) {
    return (
      <div className="content">
        <p className="hint">{notice?.text ?? '工作区还没准备好。'}</p>
      </div>
    );
  }

  return (
    <div className="content wk-page">
      {notice !== null ? <NoticeBar {...notice} onClose={() => setNotice(null)} /> : null}
      <div className="wk-top">
        <div className="wk-top__root" title={tree.root}>
          <span className="wk-label">受管根</span>
          <code>{tree.root.split(/[\\/]/).filter(Boolean).pop() ?? tree.root}</code>
        </div>
        <span className="wk-top__stamp">扫描于 {timeOf(tree.scannedAt)}</span>
        <span className="wk-top__spacer" />
        <label className="switch">
          <input type="checkbox" checked={archived} onChange={toggleArchived} />
          看归档
        </label>
        <button className={`btn btn--sm${busy === 'rescan' ? ' is-busy' : ''}`} disabled={busy !== null} onClick={() => void rescan()}>
          <Icon id="i-sync" />
          重新扫描
        </button>
        <button
          className={`btn btn--sm${importOpen ? ' is-on' : ''}`}
          disabled={busy !== null || importOpen}
          onClick={() => {
            // 打开导入会把整块工作区换成导入页，标记面板立即卸载
            if (!canLeaveMarks()) return;
            setNotice(null);
            setImportOpen(true);
          }}
        >
          <Icon id="i-folder" />
          导入旧代码
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy !== null} onClick={() => setDialog({ mode: 'create' })}>
          <Icon id="i-plus" />
          新建
        </button>
      </div>

      {importOpen ? (
        <WorkImport
          onClose={() => {
            // 即使从「继续导入」直接离开，也要刷新：之前可能已经成功导入过对象
            setImportOpen(false);
            void load(archivedRef.current, false);
          }}
          onImported={(objectId, result) => {
            setImportOpen(false);
            setViewArchived(false);
            void (async () => {
              await load(false, false, objectId === null ? undefined : objectId);
              const summary = importResultSummary(result);
              setNotice((current) => current?.kind === 'err' ? current : { kind: summary.level, text: summary.text });
            })();
          }}
        />
      ) : (
      <div className="wk-grid">
        <aside className="wk-col wk-col--left">
          <div className="wk-col__body">
            <div className="wk-sec__title">
              <span>对象类型</span>
            </div>
            <div className="wk-kinds">
              <button
                className={`wk-kindrow${kindFilter === 'all' ? ' is-on' : ''}`}
                onClick={() => {
                  setTrashView(false);
                  setKindFilter('all');
                }}
              >
                <span>全部</span>
                <b className="num">{counts.all}</b>
              </button>
              {KIND_ORDER.filter((kind) => kind !== 'problem' || counts.problem > 0).map((kind) => (
                <button
                  key={kind}
                  className={`wk-kindrow${kindFilter === kind ? ' is-on' : ''}`}
                  onClick={() => {
                    setTrashView(false);
                    setKindFilter(kindFilter === kind ? 'all' : kind);
                  }}
                >
                  <span>{KIND_NAME[kind]}</span>
                  <b className="num">{counts[kind]}</b>
                </button>
              ))}
            </div>

            <button className={`wk-trashbtn${trashView ? ' is-on' : ''}`} onClick={openTrash}>
              <Icon id="i-trash" />
              <span>回收站</span>
              <b className="num">{tree.trash.length}</b>
            </button>
          </div>
        </aside>

        <section className="wk-col wk-col--mid">
          {trashView ? (
            <div className="wk-search wk-search--plain">
              <Icon id="i-trash" />
              <span>回收站</span>
            </div>
          ) : (
            <div className="wk-search">
              <Icon id="i-search" />
              <input
                value={query}
                placeholder="搜标题 / 标签 / 路径"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索对象"
              />
              <button
                className={`wk-chip wk-chip--filter${pendingOnly ? ' is-on' : ''}`}
                aria-pressed={pendingOnly}
                title="只列还有待补题的比赛"
                onClick={() => {
                  setPendingOnly((v) => !v);
                  setTrashView(false);
                }}
              >
                有待补题
              </button>
              {labelFilter !== null ? (
                <button className="wk-chip wk-chip--filter" onClick={() => setLabelFilter(null)}>
                  {labelFilter} <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
          )}
          <div className="wk-col__body">
            <WorkList
              objects={filtered}
              allObjects={tree.objects}
              allById={allById}
              selectedId={selectedId}
              emptyText={pendingOnly ? '没有待补题' : undefined}
              onSelect={selectObject}
              unregistered={tree.unregistered}
              errors={tree.errors}
              trash={tree.trash}
              trashView={trashView}
              busyId={busy}
              filterKey={`${kindFilter}|${pendingOnly ? 'p' : ''}|${labelFilter ?? ''}|${query}`}
              onAdopt={(target) => setDialog({ mode: 'adopt', target })}
              onRestoreEntry={(item) => {
                setTrashView(false);
                setBusy('restore');
                setNotice(null);
                void (async () => {
                  try {
                    if (item.entryType === 'object') await restoreWork(item.id);
                    else await restoreArenaRecord(item.id);
                    await load(archivedRef.current, false);
                    setNotice({ kind: 'ok', text: item.entryType === 'object' ? '对象已恢复' : '成绩存档已恢复' });
                  } catch (error) {
                    const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
                    setNotice({ kind: 'err', text: api.message });
                  } finally {
                    setBusy(null);
                  }
                })();
              }}
              onPurge={() => {
                if (busy !== null) return;
                setBusy('purge-trash');
                setNotice(null);
                void (async () => {
                  try {
                    const result = await purgeWorkTrash();
                    await load(archivedRef.current, false);
                    setNotice({ kind: 'ok', text: `已清空回收站（${result.removed} 项）` });
                  } catch (error) {
                    const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
                    setNotice({ kind: 'err', text: api.message });
                  } finally {
                    setBusy(null);
                  }
                })();
              }}
            />
          </div>
        </section>

        <aside className="wk-col wk-col--right">
          <div className="wk-col__body">
            {trashView ? (
              <div className="wk-detail">
                <div className="wk-detail__head">
                  <div className="wk-detail__title">
                    <span>回收站</span>
                  </div>
                  <p className="wk-hint">删除只进回收站；恢复按原路径移回，路径被占时会拒绝。清空会永久删除全部条目。</p>
                </div>
                <div className="wk-empty">
                  共 <b>{tree.trash.length}</b> 项。中间列表里点「恢复」，或清空回收站。
                </div>
              </div>
            ) : detailLoading ? (
              <div className="wk-empty">正在读对象…</div>
            ) : detail !== null ? (
              <WorkDetail
                detail={detail}
                problemTags={tree.problemTags}
                parentTitle={parentTitle}
                objects={allObjects}
                busy={busy}
                onRetitle={(title) => {
                  if (detail !== null) void afterMutation('retitle', () => updateWork({ id: detail.id, title }));
                }}
                onLabels={(labels: string[]) => {
                  if (detail !== null) void afterMutation('labels', () => updateWork({ id: detail.id, labels }));
                }}
                onArchive={(next) => {
                  if (detail !== null) void afterMutation('archive', () => updateWork({ id: detail.id, archived: next }));
                }}
                onSetParent={(parentId) => {
                  if (detail !== null) void afterMutation('link', () => updateWork({ id: detail.id, parentId }));
                }}
                onSelectObject={(id) => selectObject(id)}
                onOpenArenaRecord={(recordId) => {
                  if (detail === null || detail.links.arenaPath === undefined || !canLeaveMarks()) return;
                  window.location.hash = `/arena?path=${encodeURIComponent(detail.links.arenaPath)}&record=${encodeURIComponent(recordId)}`;
                }}
                onRestoreArenaLegacy={() => {
                  if (detail === null || detail.links.arenaPath === undefined || !canLeaveMarks()) return;
                  window.location.hash = `/arena?path=${encodeURIComponent(detail.links.arenaPath)}&legacy=restore`;
                }}
                onRecordsChanged={() => {
                  void load(archivedRef.current, false);
                }}
                onProblemMarksChanged={() => {
                  void load(archivedRef.current, false);
                }}
                onProblemMarksUnsaved={(unsaved) => {
                  marksUnsaved.current = unsaved;
                }}
                onTrash={() => {
                  // 回收失败时面板还在，确认后不清标志，保护继续生效
                  if (detail === null || !confirmLeaveMarks()) return;
                  const id = detail.id;
                  void (async () => {
                    setBusy('trash');
                    try {
                      await trashWork(id);
                      if (selectedIdRef.current === id) {
                        setSelected(null);
                        clearDetail();
                      }
                      const next = await load(archivedRef.current, false);
                      if (next !== null) setNotice({ kind: 'ok', text: '已移入回收站' });
                    } catch (error) {
                      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
                      setNotice({ kind: 'err', text: api.message });
                    } finally {
                      setBusy(null);
                    }
                  })();
                }}
                onOpen={(relPath, app) => {
                  if (detail === null) return;
                  void openWork(detail.id, relPath, app).catch((error: unknown) => {
                    const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
                    setNotice({ kind: 'err', text: api.message });
                  });
                }}
                onOpenArena={(arenaPath) => {
                  if (!canLeaveMarks()) return;
                  window.location.hash = `/arena?path=${encodeURIComponent(arenaPath)}`;
                }}
                onFilterLabel={(label) => setLabelFilter(label)}
                onTemplateSaved={() => {
                  if (detail !== null) void refreshDetailQuietly(detail.id);
                  void load(archivedRef.current, false);
                }}
              />
            ) : (
              <div className="wk-empty">从中间选一个对象，标签、文件与打开入口都在这儿。</div>
            )}
          </div>
        </aside>
      </div>
      )}

      {dialog !== null ? (
        <WorkCreate
          contests={activeContests}
          dialog={dialog}
          onDone={(title, id) => {
            setDialog(null);
            // 新建/登记已经落盘；这里才真正切换对象。标记未保存时先确认，取消就留在当前对象
            if (!confirmLeaveMarks()) {
              void load(archivedRef.current, false);
              setNotice({ kind: 'ok', text: `已保存「${title}」` });
              return;
            }
            setTrashView(false);
            // 在「看归档」里新建 / 登记出来的是未归档对象，先切回活动视图再拉树，否则会“保存成功但看不见”
            setViewArchived(false);
            void (async () => {
              await load(false, false, id);
              setNotice({ kind: 'ok', text: `已保存「${title}」` });
            })();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function timeOf(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
