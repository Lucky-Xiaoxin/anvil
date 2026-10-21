import { useMemo, useState } from 'react';
import type { WorkKind, WorkTreeDto, WorkUnregisteredDto } from '@anvil/shared';
import { ApiError, createWork, adoptWork } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { KIND_NAME, KIND_ORDER } from './derive.ts';

export type WorkDialog =
  | { mode: 'create' }
  | { mode: 'adopt'; target: WorkUnregisteredDto };

interface Props {
  tree: WorkTreeDto;
  dialog: WorkDialog;
  onDone: (title: string, id: string) => void;
  onClose: () => void;
}

export function WorkCreate({ tree, dialog, onDone, onClose }: Props) {
  const adopting = dialog.mode === 'adopt';
  const target = adopting ? dialog.target : null;
  const [kind, setKind] = useState<WorkKind>(target?.kindHint ?? 'problem');
  const [title, setTitle] = useState(() => (target === null ? '' : (target.relPath.split('/').pop() ?? '')));
  const [parentId, setParentId] = useState('');
  const [problemKey, setProblemKey] = useState('');
  const [topId, setTopId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [arenaPath, setArenaPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const contests = useMemo(
    () => tree.objects.filter((o) => o.kind === 'contest' && !o.effectiveArchived),
    [tree.objects],
  );
  const templates = useMemo(
    () => tree.objects.filter((o) => o.kind === 'template' && !o.effectiveArchived),
    [tree.objects],
  );
  const topNodes = tree.taxonomy?.nodes ?? [];

  const canSubmit = adopting || title.trim() !== '' || (kind === 'problem' && problemKey.trim() !== '');

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      if (adopting && target !== null) {
        const made = await adoptWork({ relPath: target.relPath, kind, title: title.trim() === '' ? undefined : title.trim() });
        onDone(made.title, made.id);
      } else {
        const made = await createWork({
          kind,
          title: title.trim() === '' ? undefined : title.trim(),
          ...(kind === 'problem' && parentId !== '' ? { parentId } : {}),
          ...(kind === 'problem' && problemKey.trim() !== '' ? { problemKey: problemKey.trim() } : {}),
          ...(kind === 'template' && topId !== '' ? { topId } : {}),
          ...(kind === 'problem' && templateId !== '' ? { templateId } : {}),
          ...(kind === 'contest' && arenaPath.trim() !== '' ? { arenaPath: arenaPath.trim() } : {}),
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
            <select className="wk-select" value={kind} onChange={(e) => setKind(e.target.value as WorkKind)}>
              {KIND_ORDER.map((k) => (
                <option value={k} key={k}>
                  {KIND_NAME[k]}
                </option>
              ))}
            </select>
          </label>

          <label className="wk-field">
            <span className="wk-label">标题</span>
            <input
              className="input"
              value={title}
              maxLength={120}
              placeholder={kind === 'problem' ? '可留空（用题目 key 补）' : '必填'}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          {kind === 'problem' && !adopting ? (
            <>
              <label className="wk-field">
                <span className="wk-label">父比赛（可选）</span>
                <select className="wk-select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">不挂在比赛下</option>
                  {contests.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wk-field">
                <span className="wk-label">题目 key（可选）</span>
                <input
                  className="input"
                  value={problemKey}
                  maxLength={80}
                  placeholder="cf:2184:F"
                  onChange={(e) => setProblemKey(e.target.value)}
                />
              </label>
              {templates.length > 0 ? (
                <label className="wk-field">
                  <span className="wk-label">来源模板（可选）</span>
                  <select className="wk-select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">不复制模板</option>
                    {templates.map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}

          {kind === 'template' ? (
            <label className="wk-field">
              <span className="wk-label">一级分类（可选）</span>
              <select className="wk-select" value={topId} onChange={(e) => setTopId(e.target.value)}>
                <option value="">_unsorted</option>
                {topNodes.map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {kind === 'contest' ? (
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

          {err !== null ? <div className="wk-note wk-note--bad">{err}</div> : null}
        </div>

        <div className="wk-modal__foot">
          {!canSubmit ? <span className="wk-muted">先填标题，或给题目一个 key。</span> : <span />}
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
