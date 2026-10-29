/**
 * 榜单多存档的对话框（docs/contracts/29 §6）：命名 / 替换确认 / 历史成绩层 / 通用确认。
 * 可访问口径照 §6.3：有名字、初始焦点、焦点圈定、Escape 取消、关闭后焦点归还。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArenaRecordsListDto } from '@anvil/shared';
import { arenaResultLabel, ARENA_RECORD_NAME_MAX } from '@anvil/shared';
import { Icon } from '../ui.tsx';
import { recordStamp } from './record.ts';
import type { ReplaceCase } from './draft.ts';
import { discardSwitchLabel, finishSwitchLabel } from './draft.ts';

export function Modal({ label, onClose, children, wide = false }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = boxRef.current;
    const focusables = (): HTMLElement[] =>
      box === null
        ? []
        : Array.from(
            box.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ),
          );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? list[list.length - 1]! : list[at - 1]!) : at === list.length - 1 ? list[0]! : list[at + 1]!;
      e.preventDefault();
      next.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus();
    };
  }, []);

  return (
    <div className="wk-modal" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="wk-modal__veil" aria-label="关闭" onMouseDown={onClose} />
      <div ref={boxRef} className={`wk-modal__box rise${wide ? ' is-wide' : ''}`}>
        {children}
      </div>
    </div>
  );
}

function DialogHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="wk-modal__head">
      <h3>{title}</h3>
      <button type="button" className="btn btn--ghost btn--sm" aria-label="关闭" onClick={onClose}>
        <Icon id="i-x" />
      </button>
    </div>
  );
}

export function NameDialog({
  title,
  sub,
  initial,
  confirmLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  sub?: string;
  initial: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [bad, setBad] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = (): void => {
    const next = name.trim();
    if (next.length < 1) return setBad('名称不能为空');
    if (next.length > ARENA_RECORD_NAME_MAX) return setBad(`名称最多 ${ARENA_RECORD_NAME_MAX} 字`);
    setBad(null);
    onConfirm(next);
  };

  return (
    <Modal label={title} onClose={onCancel}>
      <DialogHead title={title} onClose={onCancel} />
      {sub !== undefined ? <p className="hint arena-dlg__sub">{sub}</p> : null}
      <form
        className="wk-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="wk-field">
          <span className="wk-label">存档名称</span>
          <input
            ref={input}
            className="input"
            value={name}
            maxLength={ARENA_RECORD_NAME_MAX + 20}
            placeholder="例如 第一次 VP / 补题后"
            onChange={(e) => {
              setName(e.target.value);
              setBad(null);
            }}
            aria-label="存档名称"
          />
          <span className="wk-hint">1–120 字，可重名；名称不参与文件路径。</span>
        </label>
        {bad !== null || error !== null ? <div className="alert alert--err" role="status">{bad ?? error}</div> : null}
        <div className="wk-modal__foot">
          <span />
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
            {busy ? '保存中…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ReplaceDialog({
  kind,
  targetLabel,
  busy,
  error,
  onSaveSwitch,
  onDiscardSwitch,
  onCancel,
}: {
  kind: Exclude<ReplaceCase, 'none'>;
  /** 当前草稿的读法：“进行中的练习 / 已结束的「第一次 VP」/ 旧成绩” */
  targetLabel: string;
  busy: boolean;
  error: string | null;
  onSaveSwitch: () => void;
  onDiscardSwitch: () => void;
  onCancel: () => void;
}) {
  const running = kind === 'running';
  return (
    <Modal label="切换前处理当前草稿" onClose={onCancel}>
      <DialogHead title="切换前处理当前草稿" onClose={onCancel} />
      <p className="arena-dlg__lead">
        {running ? (
          <>
            {targetLabel}仍在进行中。切换前要先结束并保存，或放弃这次练习 —— 计时不会静默丢掉。
          </>
        ) : kind === 'legacy' ? (
          <>旧成绩没有记录结束方式。要保存必须先确认“这份成绩已经结束”，不会伪造计时完成。</>
        ) : (
          <>{targetLabel}还有未保存的修改。先保存，或明确放弃这些修改。</>
        )}
      </p>
      {running ? <p className="hint">“结束并保存”会把当前时刻记为提前结束，不会写成比赛满时长。</p> : null}
      {error !== null ? <div className="alert alert--err" role="status">{error}</div> : null}
      <div className="arena-dlg__acts">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <span className="wk-spacer" />
        <button type="button" className="btn btn--sm" disabled={busy} onClick={onDiscardSwitch}>
          {discardSwitchLabel(kind)}
        </button>
        <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={onSaveSwitch}>
          {busy ? '保存中…' : finishSwitchLabel(kind)}
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal label={title} onClose={onCancel}>
      <DialogHead title={title} onClose={onCancel} />
      <div className="arena-dlg__lead">{body}</div>
      {error !== null ? <div className="alert alert--err" role="status">{error}</div> : null}
      <div className="arena-dlg__acts">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <span className="wk-spacer" />
        <button type="button" className={`btn btn--sm${danger ? ' btn--danger' : ' btn--primary'}`} disabled={busy} onClick={onConfirm}>
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export interface HistoryState {
  status: 'loading' | 'ready' | 'error';
  dto: ArenaRecordsListDto | null;
  error: string | null;
}

export function HistoryDialog({
  state,
  archived,
  hasDraft,
  currentId,
  onRetry,
  onView,
  onEdit,
  onRestoreLegacy,
  onClose,
}: {
  state: HistoryState;
  archived: boolean;
  hasDraft: boolean;
  currentId: string | null;
  onRetry: () => void;
  onView: (recordId: string) => void;
  onEdit: (recordId: string) => void;
  onRestoreLegacy: () => void;
  onClose: () => void;
}) {
  const dto = state.dto;
  const records = dto?.records ?? [];
  const legacy = dto?.legacy ?? null;
  const errors = dto?.errors ?? [];
  const empty = state.status === 'ready' && records.length === 0 && legacy === null && errors.length === 0;
  return (
    <Modal label="历史成绩" onClose={onClose} wide>
      <DialogHead title="历史成绩" onClose={onClose} />
      <p className="hint arena-dlg__sub">
        同一场比赛的正式成绩。点击查看只读回顾，不载入当前练习；改名与删除在工坊里做。
        {archived ? ' 比赛已归档：这里只读。' : ''}
      </p>
      {state.status === 'loading' ? <div className="wk-empty">正在读存档…</div> : null}
      {state.status === 'error' ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-plug" />
          <div>历史成绩读取失败：{state.error}</div>
          <button className="alert__x" type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          {empty ? (
            <div className="wk-empty">
              {hasDraft ? '还没有历史成绩 · 当前练习尚未保存' : '没有历史成绩 · 练完一场后保存，就会出现在这里'}
            </div>
          ) : null}
          {records.length > 0 ? (
            <div className="arena-hist">
              {records.map((rec) => (
                <div className={`arena-hist__row${currentId === rec.recordId ? ' is-on' : ''}`} key={rec.recordId}>
                  <div className="arena-hist__main">
                    <div className="arena-hist__name">{rec.name}</div>
                    <div className="arena-hist__meta">
                      <span>{arenaResultLabel(rec.result)}</span>
                      <span className="wk-dot" />
                      <span>{recordStamp(rec.updatedAt)}</span>
                      <span className="wk-dot" />
                      <span>{rec.submissionCount} 发</span>
                      {rec.recordId === 'legacy' ? (
                        <>
                          <span className="wk-dot" />
                          <span>旧根文件</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="arena-hist__acts">
                    <button type="button" className="btn btn--xs" onClick={() => onView(rec.recordId)}>
                      <Icon id="i-eye" />
                      查看
                    </button>
                    <button type="button" className="btn btn--xs btn--ghost" onClick={() => onEdit(rec.recordId)}>
                      <Icon id="i-pencil" />
                      编辑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {legacy !== null ? (
            <div className="arena-hist__legacy">
              <div className="arena-hist__main">
                <div className="arena-hist__name">旧进度 · 未结束</div>
                <div className="arena-hist__meta">
                  <span>保存于 {recordStamp(legacy.savedAt)}</span>
                  <span className="wk-dot" />
                  <span>{legacy.submissionCount} 发</span>
                  <span className="wk-dot" />
                  <span>不计入历史成绩</span>
                </div>
              </div>
              <button type="button" className="btn btn--xs" onClick={onRestoreLegacy}>
                恢复为当前练习
              </button>
            </div>
          ) : null}
          {errors.length > 0 ? (
            <div className="arena-hist__errors">
              <div className="wk-sec__title">
                <span>损坏 / 未知文件</span>
                <b className="num">{errors.length}</b>
              </div>
              {errors.map((err) => (
                <div className="wk-error" key={err.file}>
                  <span className="wk-error__kind">存档</span>
                  <code>{err.file}</code>
                  <span className="wk-error__msg">{err.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
