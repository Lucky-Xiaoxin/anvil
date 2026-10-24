import { useEffect, useState } from 'react';
import type { WorkMigratePreviewItemDto } from '@anvil/shared';
import { ApiError, workMigrateApply, workMigratePreview } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';

const PROPOSAL_BADGE: Record<WorkMigratePreviewItemDto['proposal'], { text: string; cls: string }> = {
  'keep-contest': { text: '保持比赛', cls: 'wk-badge' },
  'to-problemset': { text: '转为题组', cls: 'wk-badge wk-badge--contest' },
  ambiguous: { text: '待确认', cls: 'wk-badge wk-badge--warn' },
};

/**
 * 5a-4 角色迁移（契约 26 §3）：先只读预览、后显式确认；只改 meta 的 kind，不搬目录。
 * 明确项（sourcePath）默认勾选；待确认项不默认归类，由用户逐项勾选。
 */
export function WorkMigrate({ onDone, onClose }: { onDone: (text: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<WorkMigratePreviewItemDto[] | null>(null);
  const [counts, setCounts] = useState<{ contest: number; keep: number; toProblemset: number; ambiguous: number } | null>(null);
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const preview = await workMigratePreview();
        if (!alive) return;
        setItems(preview.items);
        setCounts(preview.counts);
        setDecided(new Set(preview.items.filter((item) => item.proposal === 'to-problemset').map((item) => item.id)));
      } catch (error) {
        if (alive) setLoadErr(error instanceof ApiError ? error.message : messageOf(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const decidedCount = items === null ? 0 : items.filter((item) => item.proposal !== 'keep-contest' && decided.has(item.id)).length;

  async function apply(): Promise<void> {
    if (busy || items === null) return;
    const ids = items.filter((item) => item.proposal !== 'keep-contest' && decided.has(item.id)).map((item) => item.id);
    setBusy(true);
    setErr(null);
    try {
      const result = await workMigrateApply(ids);
      const failedNote = result.failed.length > 0 ? ` · 失败 ${result.failed.length}` : '';
      onDone(`迁移完成：${result.applied.length} 个对象转成题组${failedNote}`);
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : messageOf(error));
      setBusy(false);
    }
  }

  const toggle = (id: string, on: boolean): void => {
    setDecided((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div className="wk-modal" role="dialog" aria-modal="true" aria-label="题组迁移">
      <button className="wk-modal__veil" aria-label="关闭" onClick={onClose} />
      <div className="wk-modal__box rise">
        <div className="wk-modal__head">
          <h3>题组迁移</h3>
          <button type="button" className="btn btn--ghost btn--sm" aria-label="关闭" onClick={onClose}>
            <Icon id="i-x" />
          </button>
        </div>

        {loadErr !== null ? (
          <div className="wk-form">
            <div className="wk-note wk-note--bad">{loadErr}</div>
          </div>
        ) : items === null ? (
          <div className="wk-form">
            <p className="wk-hint">正在读取预览…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="wk-form">
            <p className="wk-hint">没有 contest 对象，不需要迁移。</p>
          </div>
        ) : (
          <>
            <div className="wk-form">
              <p className="wk-hint">
                比赛 {counts?.contest ?? 0} · 保持比赛 {counts?.keep ?? 0} · 建议题组 {counts?.toProblemset ?? 0} · 待确认{' '}
                {counts?.ambiguous ?? 0}。迁移只改对象类型，不移动文件夹、不改路径；旧题目 / 模板 / 笔记不参与。
              </p>
            </div>
            <div className="wk-form" style={{ maxHeight: '52vh', overflowY: 'auto', display: 'block' }}>
              {items.map((item) => {
                const badge = PROPOSAL_BADGE[item.proposal];
                const decidable = item.proposal !== 'keep-contest';
                return (
                  <label
                    className={`wk-row${decidable && decided.has(item.id) ? ' is-on' : ''}`}
                    key={item.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: decidable ? 'pointer' : 'default' }}
                  >
                    {decidable ? (
                      <input
                        type="checkbox"
                        className="wk-import__check"
                        checked={decided.has(item.id)}
                        disabled={busy}
                        onChange={(e) => toggle(item.id, e.target.checked)}
                      />
                    ) : (
                      <span className="wk-import__chevspace" aria-hidden="true" />
                    )}
                    <span className="wk-row__main">
                      <span className="wk-row__title">
                        <span className="wk-row__titletext">{item.title}</span>
                        <span className={badge.cls}>{badge.text}</span>
                      </span>
                      <span className="wk-row__meta">
                        <span>{item.rule}</span>
                        <span className="wk-dot" />
                        <code>{item.relPath}</code>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {err !== null ? (
              <div className="wk-form">
                <div className="wk-note wk-note--bad">{err}</div>
              </div>
            ) : null}
            <div className="wk-modal__foot">
              <span className="wk-muted">将把 {decidedCount} 个 contest 对象转成题组。</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn btn--primary btn--sm" disabled={busy || decidedCount === 0} onClick={() => void apply()}>
                {busy ? '迁移中…' : `确认迁移（${decidedCount}）`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
