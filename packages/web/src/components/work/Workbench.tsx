import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkKind, WorkObjectDetailDto, WorkTreeDto } from '@anvil/shared';
import {
  ApiError,
  getWorkObject,
  getWorkTree,
  initWork,
  openWork,
  restoreWork,
  rescanWork,
  trashWork,
  updateWork,
} from '../../api.ts';
import { messageOf } from '../../format.ts';
import { NoticeBar } from '../Dashboard.tsx';
import { Icon } from '../ui.tsx';
import { TagTree } from './TagTree.tsx';
import { WorkCreate, type WorkDialog } from './WorkCreate.tsx';
import { WorkDetail } from './WorkDetail.tsx';
import { WorkImport } from './WorkImport.tsx';
import { WorkList } from './WorkList.tsx';
import { KIND_NAME, KIND_ORDER, filterWorkObjects, kindCounts } from './derive.ts';
import { importResultSummary } from './import-derive.ts';

interface Notice {
  kind: 'err' | 'ok' | 'warn';
  text: string;
}

interface SetupState {
  kind: string;
  message: string;
}

const SETUP_KINDS = new Set(['workspace-unconfigured', 'workspace-uninitialized', 'root-missing', 'root-invalid', 'root-version']);

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

export function Workbench() {
  const [tree, setTree] = useState<WorkTreeDto | null>(null);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [archived, setArchived] = useState(false);
  const [kindFilter, setKindFilter] = useState<WorkKind | 'all'>('all');
  const [nodeFilter, setNodeFilter] = useState<string | null>(null);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkObjectDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [trashView, setTrashView] = useState(false);
  const [dialog, setDialog] = useState<WorkDialog | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setDetailLoading(true);
    try {
      const next = await getWorkObject(id);
      setDetail(next);
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setNotice({ kind: 'err', text: api.message });
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /** 模板保存后刷新详情 / 文件列表，但不走整块 loading，避免编辑器卸载重挂、丢掉「已保存」 */
  const refreshDetailQuietly = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await getWorkObject(id);
      setDetail((prev) => (prev?.id === id ? next : prev));
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setNotice({ kind: 'err', text: api.message });
    }
  }, []);

  const load = useCallback(
    async (archivedNext: boolean, rescan: boolean, selectId?: string | null): Promise<WorkTreeDto | null> => {
      setLoading(true);
      try {
        const next = await getWorkTree({ archived: archivedNext, rescan });
        setTree(next);
        setSetup(null);
        setNotice(null);
        if (selectId !== undefined) {
          const exists = selectId !== null && next.objects.some((o) => o.id === selectId);
          setSelectedId(exists ? selectId : null);
          if (exists && selectId !== null) void loadDetail(selectId);
          else setDetail(null);
        } else {
          const exists = selectedId !== null && next.objects.some((o) => o.id === selectedId);
          if (!exists) {
            setSelectedId(null);
            setDetail(null);
          }
        }
        return next;
      } catch (error) {
        const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
        if (SETUP_KINDS.has(api.kind)) {
          setSetup({ kind: api.kind, message: api.message });
          setTree(null);
          setDetail(null);
          setSelectedId(null);
        } else {
          setNotice({ kind: 'err', text: api.message });
        }
        return null;
      } finally {
        setLoading(false);
      }
    },
    [loadDetail, selectedId],
  );

  useEffect(() => {
    void load(false, true);
    // 只在首次进入工坊时建索引；archived 切换走下面的显式调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTrash = (): void => {
    if (trashView) {
      setTrashView(false);
      return;
    }
    setTrashView(true);
    setSelectedId(null);
    setDetail(null);
    setNodeFilter(null);
    setLabelFilter(null);
    setKindFilter('all');
  };

  const selectObject = (id: string): void => {
    setTrashView(false);
    setSelectedId(id);
    void loadDetail(id);
  };

  const afterMutation = async (label: string, make: () => Promise<WorkObjectDetailDto>): Promise<void> => {
    if (busy !== null) return;
    setBusy(label);
    setNotice(null);
    try {
      const made = await make();
      const next = await load(archived, false);
      if (next !== null && next.objects.some((o) => o.id === made.id)) {
        setSelectedId(made.id);
        setDetail(made);
      } else {
        setSelectedId(null);
        setDetail(null);
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
    setBusy('rescan');
    setNotice(null);
    try {
      const summary = await rescanWork();
      await load(archived, false);
      if (selectedId !== null) void loadDetail(selectedId);
      setNotice({ kind: 'ok', text: `扫描完成：${summary.objects} 个对象 · 未登记 ${summary.unregistered} · 错误 ${summary.errors}` });
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setNotice({ kind: 'err', text: api.message });
    } finally {
      setBusy(null);
    }
  };

  const toggleArchived = (): void => {
    const next = !archived;
    setArchived(next);
    setTrashView(false);
    setSelectedId(null);
    setDetail(null);
    void load(next, false);
  };

  const filtered = useMemo(
    () => filterWorkObjects(tree?.objects ?? [], tree?.taxonomy ?? null, { kind: kindFilter, nodeId: nodeFilter, label: labelFilter, query }),
    [tree, kindFilter, nodeFilter, labelFilter, query],
  );
  const counts = useMemo(() => kindCounts(tree?.objects ?? []), [tree]);
  const parentTitle = detail?.parentId === undefined || detail?.parentId === null ? null : (tree?.objects.find((o) => o.id === detail.parentId)?.title ?? null);

  if (setup !== null) {
    return (
      <div className="content wk-page">
        <RootSetup
          setup={setup}
          onReady={(next) => {
            setTree(next);
            setSetup(null);
            setArchived(false);
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

      {tree.taxonomyError !== null ? (
        <div className="alert alert--warn" role="status">
          <Icon id="i-warn" />
          <div>
            <b>词表坏了</b> · 对象照常列出，标签编辑已禁用
            <br />
            {tree.taxonomyError}
          </div>
        </div>
      ) : null}

      {importOpen ? (
        <WorkImport
          onClose={() => {
            // 即使从「继续导入」直接离开，也要刷新：之前可能已经成功导入过对象
            setImportOpen(false);
            void load(archived, false);
          }}
          onImported={(objectId, result) => {
            setImportOpen(false);
            setArchived(false);
            void (async () => {
              const next = await load(false, false, objectId === null ? undefined : objectId);
              if (next === null) return;
              const summary = importResultSummary(result);
              setNotice({ kind: summary.level, text: summary.text });
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

            <div className="wk-sec__title wk-sec__title--tree">
              <span>标签树</span>
            </div>
            <TagTree
              taxonomy={tree.taxonomy}
              error={tree.taxonomyError}
              selected={nodeFilter}
              onSelect={(id) => {
                setNodeFilter(id);
                setTrashView(false);
              }}
            />

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
              taxonomy={tree.taxonomy}
              selectedId={selectedId}
              onSelect={selectObject}
              unregistered={tree.unregistered}
              errors={tree.errors}
              trash={tree.trash}
              trashView={trashView}
              busyId={busy}
              filterKey={`${kindFilter}|${nodeFilter ?? ''}|${labelFilter ?? ''}|${query}`}
              onAdopt={(target) => setDialog({ mode: 'adopt', target })}
              onRestore={(id) => {
                setTrashView(false);
                void afterMutation('restore', () => restoreWork(id));
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
                  <p className="wk-hint">删除只进回收站，不做硬删。恢复按原路径移回，路径被占时会拒绝。</p>
                </div>
                <div className="wk-empty">共 <b>{tree.trash.length}</b> 项。中间列表里点「恢复」。</div>
              </div>
            ) : detailLoading ? (
              <div className="wk-empty">正在读对象…</div>
            ) : detail !== null ? (
              <WorkDetail
                detail={detail}
                taxonomy={tree.taxonomy}
                taxonomyError={tree.taxonomyError}
                parentTitle={parentTitle}
                busy={busy}
                onRetitle={(title) => {
                  if (detail !== null) void afterMutation('retitle', () => updateWork({ id: detail.id, title }));
                }}
                onTags={(tags) => {
                  if (detail !== null) void afterMutation('tags', () => updateWork({ id: detail.id, tags }));
                }}
                onLabels={(labels: string[]) => {
                  if (detail !== null) void afterMutation('labels', () => updateWork({ id: detail.id, labels }));
                }}
                onArchive={(next) => {
                  if (detail !== null) void afterMutation('archive', () => updateWork({ id: detail.id, archived: next }));
                }}
                onTrash={() => {
                  if (detail === null) return;
                  const id = detail.id;
                  void (async () => {
                    setBusy('trash');
                    try {
                      await trashWork(id);
                      setSelectedId(null);
                      setDetail(null);
                      await load(archived, false);
                      setNotice({ kind: 'ok', text: '已移入回收站' });
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
                  window.location.hash = `/arena?path=${encodeURIComponent(arenaPath)}`;
                }}
                onSelectTag={(id) => {
                  setNodeFilter(id);
                  setTrashView(false);
                }}
                onFilterLabel={(label) => setLabelFilter(label)}
                onTemplateSaved={() => {
                  if (detail !== null) void refreshDetailQuietly(detail.id);
                  void load(archived, false);
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
          tree={tree}
          dialog={dialog}
          onDone={(title, id) => {
            setDialog(null);
            setTrashView(false);
            // 在「看归档」里新建 / 登记出来的是未归档对象，先切回活动视图再拉树，否则会“保存成功但看不见”
            setArchived(false);
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
