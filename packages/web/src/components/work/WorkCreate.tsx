import { useState } from 'react';
import type { WorkKind, WorkObjectDto, WorkUnregisteredDto } from '@anvil/shared';
import { ApiError, createWork, adoptWork } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { availableContests } from './derive.ts';

export type WorkDialog =
  | { mode: 'create' }
  | { mode: 'adopt'; target: WorkUnregisteredDto };

/**
 * 5a-4（契约 26）：比赛 = contest、题组 = problemset 是两个对象。
 * 新建比赛不再产生题组；新建题组可选关联比赛（比赛侧 0..n，27 §2.1）。
 */
type CreateMode = 'contest' | 'problemset' | 'template' | 'note';

const MODES: ReadonlyArray<{ mode: CreateMode; label: string; hint: string }> = [
  { mode: 'problemset', label: '题组', hint: '建一个题组文件夹；写题时直接往里放 .cpp，题目不再单独建对象。' },
  { mode: 'contest', label: '比赛', hint: '建一个比赛对象；可填榜单路径，回放成绩存到这里。比赛不产生题组。' },
  { mode: 'template', label: '模板', hint: '模板仍是一个独立对象文件夹。' },
  { mode: 'note', label: '笔记', hint: '笔记仍是一个独立对象文件夹。' },
];

interface Props {
  /** 活动比赛（27 §5.2）：关联选择器只列活动对象 */
  contests: WorkObjectDto[];
  dialog: WorkDialog;
  onDone: (title: string, id: string) => void;
  onClose: () => void;
}

function modeOfHint(kind: WorkKind | null): CreateMode {
  if (kind === 'template') return 'template';
  if (kind === 'note') return 'note';
  if (kind === 'contest') return 'contest';
  // practice 桶与未知位置默认提议题组；problem 仅旧数据兼容，不再新建
  return 'problemset';
}

export function WorkCreate({ contests, dialog, onDone, onClose }: Props) {
  const adopting = dialog.mode === 'adopt';
  const target = adopting ? dialog.target : null;
  const [mode, setMode] = useState<CreateMode>(target === null ? 'problemset' : modeOfHint(target.kindHint));
  const [title, setTitle] = useState(() => (target === null ? '' : (target.relPath.split('/').pop() ?? '')));
  const [arenaPath, setArenaPath] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parentOptions = availableContests(contests);
  const current = MODES.find((item) => item.mode === mode) ?? MODES[0]!;
  const canSubmit = adopting || title.trim() !== '';

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const kind: WorkKind = mode;
      const link = mode === 'problemset' && parentId !== '' ? { parentId } : {};
      if (adopting && target !== null) {
        const made = await adoptWork({
          relPath: target.relPath,
          kind,
          title: title.trim() === '' ? undefined : title.trim(),
          ...link,
        });
        onDone(made.title, made.id);
      } else {
        const made = await createWork({
          kind,
          title: title.trim(),
          ...(mode === 'contest' && arenaPath.trim() !== '' ? { arenaPath: arenaPath.trim() } : {}),
          ...link,
        });
        onDone(made.title, made.id);
      }
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      setErr(api.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wk-modal" role="dialog" aria-modal="true" aria-label={adopting ? '登记对象' : '新建对象'}>
      <button className="wk-modal__veil" aria-label="关闭" onClick={onClose} />
      <form className="wk-modal__box rise" onSubmit={(e) => void submit(e)}>
        <div className="wk-modal__head">
          <h3>{adopting ? '登记对象' : '新建对象'}</h3>
          <button type="button" className="btn btn--ghost btn--sm" aria-label="关闭" onClick={onClose}>
            <Icon id="i-x" />
          </button>
        </div>

        {adopting && target !== null ? <code className="wk-path">{target.relPath}</code> : null}

        <div className="wk-form">
          <label className="wk-field">
            <span className="wk-label">类型</span>
            <select className="wk-select" value={mode} onChange={(e) => setMode(e.target.value as CreateMode)}>
              {MODES.map((item) => (
                <option value={item.mode} key={item.mode}>
                  {item.label}
                </option>
              ))}
            </select>
            <span className="wk-hint">{current.hint}</span>
          </label>

          <label className="wk-field">
            <span className="wk-label">标题</span>
            <input
              className="input"
              value={title}
              maxLength={120}
              placeholder={mode === 'problemset' ? '例如 专题训练 / 2024 区域赛' : '必填'}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          {mode === 'contest' ? (
            <label className="wk-field">
              <span className="wk-label">榜单路径（可选）</span>
              <input
                className="input"
                value={arenaPath}
                maxLength={300}
                placeholder="official/icpc/…/xxx.srk.json"
                onChange={(e) => setArenaPath(e.target.value)}
              />
            </label>
          ) : null}

          {mode === 'problemset' ? (
            <label className="wk-field">
              <span className="wk-label">关联比赛（可选）</span>
              <select className="wk-select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">无关联（独立题组）</option>
                {parentOptions.map((contest) => (
                  <option value={contest.id} key={contest.id}>
                    {contest.title}
                  </option>
                ))}
              </select>
              <span className="wk-hint">关联不移动文件夹；一个比赛可以关联多个题组（27 §2.1）。</span>
            </label>
          ) : null}

          {err !== null ? <div className="wk-note wk-note--bad">{err}</div> : null}
        </div>

        <div className="wk-modal__foot">
          {!canSubmit ? <span className="wk-muted">先填标题。</span> : <span />}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !canSubmit}>
            {busy ? '写入中…' : adopting ? '登记' : '创建'}
          </button>
        </div>
      </form>
    </div>
  );
}
