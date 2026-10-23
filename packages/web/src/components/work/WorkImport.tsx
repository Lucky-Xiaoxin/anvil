import { useMemo, useState } from 'react';
import type {
  WorkImportCandidateDto,
  WorkImportPlanDto,
  WorkImportResultDto,
  WorkImportResultUnitDto,
} from '@anvil/shared';
import { ApiError, commitWorkImport, scanWorkImport } from '../../api.ts';
import { fmtInt, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { fileSize } from './derive.ts';
import {
  batchDisabledMap,
  batchImportSummary,
  buildBatchImportTree,
  buildCommitItems,
  duplicateLabel,
  importScopeLabel,
  initialBatchImportState,
  isAutoSkipDuplicate,
  middleEllipsis,
  setImportKeepDuplicate,
  setImportTitle,
  setBatchImportSelected,
  validateBatchImportState,
  type BatchImportTreeNode,
  type ImportItemState,
  type ImportState,
} from './import-derive.ts';

interface Props {
  onClose: () => void;
  /** 成功后回工坊：有成功项时默认选中第一件 */
  onImported: (objectId: string | null) => void;
}

type Phase = 'source' | 'preview' | 'result';
type Busy = 'scan' | 'commit' | null;

const errorOf = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(messageOf(err)));

function normalizePath(input: string): string {
  return input.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
}

function Badges({ item }: { item: WorkImportCandidateDto }) {
  const duplicate = duplicateLabel(item);
  return (
    <span className="wk-import__badges">
      <span className={item.scope === 'direct' ? 'wk-badge' : item.isContainer ? 'wk-badge wk-badge--warn' : 'wk-badge wk-badge--contest'}>
        {importScopeLabel(item)}
      </span>
      {item.confidence === 'low' ? (
        <span className="wk-import__flag">
          <Icon id="i-warn" />
          低置信
        </span>
      ) : null}
      {duplicate !== null ? (
        <span className={`wk-import__flag${isAutoSkipDuplicate(item) ? ' is-dup' : ''}`}>
          <Icon id="i-warn" />
          {duplicate}
        </span>
      ) : null}
    </span>
  );
}

function FilePreview({ item }: { item: WorkImportCandidateDto }) {
  if (item.files === 0) return null;
  return (
    <details className="wk-import__files">
      <summary>
        文件 {fmtInt(item.files)} 个 · {fileSize(item.bytes)}
        {item.filesTruncated ? `（预览前 ${item.filePreview.length} 条）` : ''}
      </summary>
      <div className="wk-import__filelist">
        {item.filePreview.map((path) => (
          <code key={path} title={path}>
            {middleEllipsis(path, 88)}
          </code>
        ))}
        {item.filesTruncated ? <span className="wk-muted">…还有更多文件</span> : null}
      </div>
    </details>
  );
}

function ImportRow(props: {
  item: WorkImportCandidateDto;
  state: ImportItemState;
  depth: number;
  disabledReason: string | undefined;
  expanded: boolean | null;
  onToggle: (() => void) | null;
  onSelect: (selected: boolean) => void;
  onTitle: (title: string) => void;
  onKeepDuplicate: (keep: boolean) => void;
}) {
  const { item, state, depth, disabledReason, expanded, onToggle } = props;
  const autoSkip = isAutoSkipDuplicate(item);
  const disabled = autoSkip || disabledReason !== undefined;
  return (
    <div
      className={`wk-import__row${depth > 0 ? ' wk-import__row--child' : ''}${state.selected ? ' is-on' : ''}${
        item.scope === 'direct' ? ' wk-import__row--scatter' : ''
      }`}
      style={depth > 0 ? { paddingLeft: `${12 + Math.min(depth, 8) * 18}px` } : undefined}
    >
      {onToggle !== null ? (
        <button
          className={`wk-group__toggle${expanded === true ? ' is-open' : ''}`}
          aria-expanded={expanded === true}
          aria-label={expanded === true ? `收起 ${item.suggestedTitle}` : `展开 ${item.suggestedTitle}`}
          onClick={onToggle}
        >
          <Icon id="i-chev" />
        </button>
      ) : (
        <span className="wk-import__chevspace" aria-hidden="true" />
      )}
      <input
        type="checkbox"
        className="wk-import__check"
        checked={state.selected}
        disabled={disabled}
        title={disabledReason ?? undefined}
        aria-label={`导入 ${item.suggestedTitle || item.sourceRelPath}`}
        onChange={(e) => props.onSelect(e.target.checked)}
      />
      <div className="wk-import__main">
        <div className="wk-import__titlerow">
          <input
            className="input wk-import__titleinput"
            value={state.title}
            maxLength={120}
            aria-label="导入标题"
            onChange={(e) => props.onTitle(e.target.value)}
          />
          <Badges item={item} />
        </div>
        <div className="wk-import__meta">
          <span title={item.sourceRelPath || '（源根）'}>{middleEllipsis(item.sourceRelPath || '（源根）', 72)}</span>
          <span className="wk-dot" />
          <span>{fmtInt(item.files)} 个文件</span>
          <span className="wk-dot" />
          <span>{fileSize(item.bytes)}</span>
          <span className="wk-dot" />
          <span>{fmtInt(item.sourceCount)} 个源码</span>
        </div>
        <div className="wk-import__reasons" title={item.reasons.join('；')}>
          {item.reasons.join('；')}
        </div>
        <FilePreview item={item} />
        {item.duplicate?.kind === 'same-content' && state.selected ? (
          <label className="wk-import__dup">
            <input type="checkbox" checked={state.keepDuplicate} onChange={(e) => props.onKeepDuplicate(e.target.checked)} />
            仍导入副本（默认不合并）
          </label>
        ) : null}
        {disabledReason !== undefined ? <div className="wk-import__hintline">{disabledReason}</div> : null}
      </div>
    </div>
  );
}

function ImportTreeNodeView(props: {
  node: BatchImportTreeNode;
  plan: WorkImportPlanDto;
  state: ImportState;
  disabled: Map<string, string>;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (itemId: string, selected: boolean) => void;
  onTitle: (itemId: string, title: string) => void;
  onKeepDuplicate: (itemId: string, keep: boolean) => void;
}) {
  const { node, state, disabled, collapsed } = props;
  const expanded = !collapsed.has(node.key);
  const hasChildren = node.children.length > 0 || node.scatter !== null;
  const toggle = hasChildren ? () => props.onToggle(node.key) : null;

  const renderItem = (item: WorkImportCandidateDto, depth: number, withToggle: boolean) => {
    const itemState = state[item.itemId];
    if (itemState === undefined) return null;
    return (
      <ImportRow
        key={item.itemId}
        item={item}
        state={itemState}
        depth={depth}
        disabledReason={disabled.get(item.itemId)}
        expanded={withToggle ? expanded : null}
        onToggle={withToggle ? toggle : null}
        onSelect={(selected) => props.onSelect(item.itemId, selected)}
        onTitle={(title) => props.onTitle(item.itemId, title)}
        onKeepDuplicate={(keep) => props.onKeepDuplicate(item.itemId, keep)}
      />
    );
  };

  return (
    <div className="wk-import__group">
      {node.candidate !== null ? (
        renderItem(node.candidate, node.depth, hasChildren)
      ) : (
        <div className="wk-import__grouphead" style={node.depth > 0 ? { marginLeft: `${node.depth * 18}px` } : undefined}>
          {toggle !== null ? (
            <button
              className={`wk-group__toggle${expanded ? ' is-open' : ''}`}
              aria-expanded={expanded}
              aria-label={expanded ? `收起 ${node.name}` : `展开 ${node.name}`}
              onClick={toggle}
            >
              <Icon id="i-chev" />
            </button>
          ) : (
            <span className="wk-import__chevspace" aria-hidden="true" />
          )}
          <div className="wk-import__main">
            <div className="wk-import__titlerow">
              <span className="wk-import__titleinput">{node.name}</span>
            </div>
          </div>
        </div>
      )}
      {expanded ? (
        <>
          {node.children.map((child) => (
            <ImportTreeNodeView
              key={child.key}
              node={child}
              plan={props.plan}
              state={state}
              disabled={disabled}
              collapsed={collapsed}
              onToggle={props.onToggle}
              onSelect={props.onSelect}
              onTitle={props.onTitle}
              onKeepDuplicate={props.onKeepDuplicate}
            />
          ))}
          {node.scatter !== null ? renderItem(node.scatter, node.depth + 1, false) : null}
        </>
      ) : null}
    </div>
  );
}

export function WorkImport({ onClose, onImported }: Props) {
  const [phase, setPhase] = useState<Phase>('source');
  const [path, setPath] = useState('');
  const [plan, setPlan] = useState<WorkImportPlanDto | null>(null);
  const [state, setState] = useState<ImportState>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkImportResultDto | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const preview = useMemo(() => (plan === null ? [] : buildBatchImportTree(plan)), [plan]);
  const disabled = useMemo(() => (plan === null ? new Map<string, string>() : batchDisabledMap(plan, state)), [plan, state]);
  const issues = useMemo(() => (plan === null ? [] : validateBatchImportState(plan, state)), [plan, state]);
  const summary = useMemo(
    () => (plan === null ? { objects: 0, units: 0, autoSkipped: 0, issues: [] } : batchImportSummary(plan, state)),
    [plan, state],
  );

  const scanNow = async (): Promise<void> => {
    if (busy !== null) return;
    const value = normalizePath(path);
    if (value === '') {
      setError('先填一个旧代码源目录的绝对路径。');
      return;
    }
    setBusy('scan');
    setError(null);
    try {
      const next = await scanWorkImport(value);
      setPlan(next);
      setState(initialBatchImportState(next));
      setResult(null);
      setCollapsed(new Set());
      setPhase('preview');
    } catch (err) {
      setError(errorOf(err).message);
    } finally {
      setBusy(null);
    }
  };

  const commitNow = async (): Promise<void> => {
    if (plan === null || busy !== null || issues.length > 0) return;
    setBusy('commit');
    setError(null);
    try {
      const next = await commitWorkImport({ planId: plan.planId, items: buildCommitItems(plan, state) });
      setResult(next);
      setPhase('result');
    } catch (err) {
      const api = errorOf(err);
      if (api.kind === 'import-plan-expired' || api.kind === 'import-root-changed') {
        setPlan(null);
        setState({});
        setPhase('source');
        setError(`${api.message}；请重新扫描。`);
      } else {
        setError(api.message);
      }
    } finally {
      setBusy(null);
    }
  };

  const reset = (): void => {
    setPlan(null);
    setState({});
    setResult(null);
    setError(null);
    setPhase('source');
    setCollapsed(new Set());
  };

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 结果页离开时刷新工坊；预览 / 选源阶段只关闭，不丢未提交 plan 之外的东西 */
  const leave = (): void => {
    if (phase === 'result' && result !== null) {
      onImported(result.units.flatMap((unit) => unit.objects)[0]?.objectId ?? null);
      return;
    }
    onClose();
  };

  const titleOf = (itemId: string): string => {
    const fromState = state[itemId]?.title;
    if (fromState !== undefined && fromState.trim() !== '') return fromState.trim();
    return plan?.items.find((item) => item.itemId === itemId)?.suggestedTitle ?? itemId;
  };

  return (
    <section className="wk-import" aria-label="导入旧代码">
      <div className="wk-import__head">
        <div className="wk-import__headmain">
          <span className="label label--accent">Legacy import</span>
          <h3>导入旧代码</h3>
          <p>只复制、不移动、不持续同步；源目录原件永不改写或删除。可一次扫描多个比赛目录，勾选后批量导入。</p>
        </div>
        <button className="btn btn--sm" onClick={leave} disabled={busy !== null}>
          返回工坊
        </button>
      </div>

      <ol className="wk-import__steps" aria-label="导入步骤">
        <li className={phase === 'source' ? 'is-on' : phase !== 'preview' ? 'is-done' : ''}>1 · 选择来源</li>
        <li className={phase === 'preview' ? 'is-on' : phase === 'result' ? 'is-done' : ''}>2 · 预览确认</li>
        <li className={phase === 'result' ? 'is-on' : ''}>3 · 执行结果</li>
      </ol>

      {phase === 'source' ? (
        <div className="wk-import__panel">
          <label className="wk-field">
            <span className="wk-label">旧代码源目录（绝对路径）</span>
            <input
              className="input"
              value={path}
              placeholder="D:/old-icpc-code"
              spellCheck={false}
              title="支持 / 与 \；可直接粘贴资源管理器「复制为路径」的带引号路径"
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
              }}
              onBlur={() => setPath((value) => normalizePath(value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void scanNow();
              }}
              autoFocus
            />
            <span className="wk-hint">支持 `/`、`\` 与带引号路径；源目录不能位于受管根内，也不能是符号链接。</span>
          </label>
          <ul className="wk-import__rules">
            <li>扫描只读：不创建锁文件、缓存或标记文件。</li>
            <li>一个含主源码的目录 = 一个题组；一次可导入多个叶子目录，全部平铺在 `contests/`。</li>
            <li>容器默认不选，可改选下级叶子；容器里直接散落的文件可单独导入为「散题」。</li>
            <li>执行时先复制到 `.anvil/import-staging/`，校验后再原子发布；绝不覆盖已有目录。</li>
          </ul>
          {error !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-warn" />
              <div>{error}</div>
            </div>
          ) : null}
          <div className="wk-import__actions">
            <button className="btn btn--primary" disabled={busy !== null || path.trim() === ''} onClick={() => void scanNow()}>
              {busy === 'scan' ? '扫描中…' : '扫描'}
            </button>
            {busy === 'scan' ? <span className="wk-hint">大目录要算 SHA-256，可能要几十秒。</span> : null}
          </div>
        </div>
      ) : null}

      {phase === 'preview' && plan !== null ? (
        <div className="wk-import__panel">
          <div className="wk-import__bar">
            <code title={plan.sourceRoot}>{middleEllipsis(plan.sourceRoot, 90)}</code>
            <span className="wk-dot" />
            <span>计划至 {new Date(plan.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="wk-top__spacer" />
            <button className="btn btn--sm" disabled={busy !== null} onClick={reset}>
              换一个来源
            </button>
          </div>

          <div className="wk-import__totals">
            <span>
              文件 <b className="num">{fmtInt(plan.totals.files)}</b>
            </span>
            <span>
              总大小 <b>{fileSize(plan.totals.bytes)}</b>
            </span>
            <span>
              候选 <b className="num">{fmtInt(plan.totals.candidates)}</b>
            </span>
            <span>
              忽略 <b className="num">{fmtInt(plan.totals.ignored)}</b>
            </span>
          </div>

          {plan.warnings.length > 0 ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>
                {plan.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            </div>
          ) : null}

          {plan.items.length === 0 ? (
            <div className="wk-empty">没有找到含主源码的目录。换一个来源再试。</div>
          ) : (
            <div className="wk-import__tree">
              {preview.map((node) => (
                <ImportTreeNodeView
                  key={node.key}
                  node={node}
                  plan={plan}
                  state={state}
                  disabled={disabled}
                  collapsed={collapsed}
                  onToggle={toggleGroup}
                  onSelect={(itemId, selected) => setState((prev) => setBatchImportSelected(plan, prev, itemId, selected))}
                  onTitle={(itemId, title) => setState((prev) => setImportTitle(prev, itemId, title))}
                  onKeepDuplicate={(itemId, keep) => setState((prev) => setImportKeepDuplicate(prev, itemId, keep))}
                />
              ))}
            </div>
          )}

          <div className="wk-import__foot">
            <div className="wk-import__summary">
              <b className="num">{summary.objects}</b> 个题组
              <span className="wk-dot" />
              {summary.units} 个原子单元
              {summary.autoSkipped > 0 ? (
                <>
                  <span className="wk-dot" />
                  自动跳过 {summary.autoSkipped}
                </>
              ) : null}
              {summary.objects === 0 && summary.autoSkipped > 0 ? (
                <div className="wk-import__hintline">全部是已导入过的同一来源项；提交只会记录跳过，不会重复复制。</div>
              ) : null}
            </div>
            {issues.length > 0 ? (
              <ul className="wk-import__issues" role="status">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
            {error !== null ? (
              <div className="alert alert--err" role="status">
                <Icon id="i-warn" />
                <div>{error}</div>
              </div>
            ) : null}
            <div className="wk-import__actions">
              <button className="btn btn--sm" onClick={reset} disabled={busy !== null}>
                取消
              </button>
              <button
                className="btn btn--primary"
                disabled={busy !== null || plan.items.length === 0 || issues.length > 0}
                onClick={() => void commitNow()}
              >
                {busy === 'commit' ? '导入中…' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === 'result' && plan !== null && result !== null ? (
        <ResultView
          plan={plan}
          result={result}
          titleOf={titleOf}
          onClose={() => onImported(result.units.flatMap((unit) => unit.objects)[0]?.objectId ?? null)}
          onSelectObject={(objectId) => onImported(objectId)}
          onContinue={reset}
        />
      ) : null}
    </section>
  );
}

function ResultView(props: {
  plan: WorkImportPlanDto;
  result: WorkImportResultDto;
  titleOf: (itemId: string) => string;
  onClose: () => void;
  onSelectObject: (objectId: string) => void;
  onContinue: () => void;
}) {
  const { plan, result, titleOf } = props;
  const created = result.units.flatMap((unit) => unit.objects);
  const failed = result.units.filter((unit) => unit.status === 'failed');
  const autoSkipped = result.skipped.filter((item) => item.kind === 'duplicate');
  const userSkipped = result.skipped.filter((item) => item.kind === 'user');
  const partial = created.length > 0 && failed.length > 0;
  const byItem = new Map(plan.items.map((item) => [item.itemId, item]));

  return (
    <div className="wk-import__panel">
      {partial ? (
        <div className="alert alert--warn" role="status">
          <Icon id="i-warn" />
          <div>部分成功：{created.length} 个题组已导入，{failed.length} 个单元失败；失败单元未留下半成品。</div>
        </div>
      ) : null}
      <div className="wk-import__stats">
        <div className="wk-import__stat">
          <b className="num">{fmtInt(created.length)}</b>
          <span>成功题组</span>
        </div>
        <div className="wk-import__stat">
          <b className="num">{fmtInt(failed.length)}</b>
          <span>失败单元</span>
        </div>
        <div className="wk-import__stat">
          <b className="num">{fmtInt(autoSkipped.length)}</b>
          <span>自动跳过</span>
        </div>
        <div className="wk-import__stat">
          <b className="num">{fmtInt(userSkipped.length)}</b>
          <span>用户跳过</span>
        </div>
      </div>

      {created.length === 0 && failed.length === 0 ? (
        <div className="wk-empty">没有新对象；已存在项按自动跳过处理。</div>
      ) : null}

      {created.length > 0 ? (
        <section className="wk-import__resultsec">
          <div className="wk-sec__title">
            <span>新建的题组</span>
            <b className="num">{created.length}</b>
          </div>
          <div className="wk-import__created">
            {created.map((object) => {
              const item = byItem.get(object.itemId);
              return (
                <button
                  className="wk-import__createdrow"
                  key={object.objectId}
                  title={`查看 ${object.relPath}`}
                  onClick={() => props.onSelectObject(object.objectId)}
                >
                  <span className={item?.scope === 'direct' ? 'wk-badge' : 'wk-badge wk-badge--contest'}>
                    {item?.scope === 'direct' ? '散题' : '题组'}
                  </span>
                  <span className="wk-import__createdtitle">{titleOf(object.itemId)}</span>
                  <code title={object.relPath}>{middleEllipsis(object.relPath, 72)}</code>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {failed.length > 0 ? (
        <section className="wk-import__resultsec">
          <div className="wk-sec__title">
            <span>失败单元</span>
            <b className="num">{failed.length}</b>
          </div>
          {failed.map((unit) => (
            <FailedUnit key={unit.unitId} unit={unit} plan={plan} titleOf={titleOf} />
          ))}
        </section>
      ) : null}

      {result.skipped.length > 0 ? (
        <section className="wk-import__resultsec">
          <div className="wk-sec__title">
            <span>跳过项</span>
            <b className="num">{result.skipped.length}</b>
          </div>
          <ul className="wk-import__skip">
            {result.skipped.slice(0, 20).map((item) => (
              <li key={item.itemId}>
                <span>{titleOf(item.itemId)}</span>
                <span className="wk-muted">{item.reason}</span>
              </li>
            ))}
          </ul>
          {result.skipped.length > 20 ? <div className="wk-hint">只列出前 20 项；完整记录在 manifest。</div> : null}
        </section>
      ) : null}

      <div className="wk-import__foot">
        <div className="wk-import__summary">
          清单：<code>{result.manifestRelPath}</code>
        </div>
        <div className="wk-import__actions">
          <button className="btn btn--sm" onClick={props.onContinue}>
            继续导入
          </button>
          <button className="btn btn--primary" onClick={props.onClose}>
            返回工坊
          </button>
        </div>
      </div>
    </div>
  );
}

function FailedUnit({ unit, plan, titleOf }: { unit: WorkImportResultUnitDto; plan: WorkImportPlanDto; titleOf: (id: string) => string }) {
  const members = plan.items.filter((item) => unit.itemIds.includes(item.itemId));
  return (
    <div className="wk-import__failed">
      <div className="wk-import__titlerow">
        <span className="wk-badge">失败</span>
        <b>{members.map((item) => titleOf(item.itemId)).join(' · ') || unit.unitId}</b>
      </div>
      <div className="wk-import__reasons">
        {unit.error?.kind ?? 'internal'}：{unit.error?.message ?? '未知错误'}
      </div>
    </div>
  );
}
