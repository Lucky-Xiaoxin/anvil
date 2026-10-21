import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkTemplateFileDto } from '@anvil/shared';
import { ApiError, getWorkTemplate, saveWorkTemplate } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';

interface Props {
  objectId: string;
  busy: boolean;
  onSaved: () => void;
}

const apiError = (error: unknown): ApiError => (error instanceof ApiError ? error : new ApiError(messageOf(error)));

export function TemplateEditor({ objectId, busy, onSaved }: Props) {
  const [file, setFile] = useState<WorkTemplateFileDto | null>(null);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadArm, setReloadArm] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const apply = useCallback((next: WorkTemplateFileDto): void => {
    setFile(next);
    setContent(next.content);
    setLoaded(next.content);
    setRevision(next.revision);
    setLoading(false);
    setReloadArm(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    setStatus(null);
    try {
      apply(await getWorkTemplate(objectId));
    } catch (error) {
      setErr(apiError(error).message);
      setLoading(false);
    }
  }, [apply, objectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => clearTimer(), []);

  const dirty = content !== loaded;

  async function save(): Promise<void> {
    if (saving || busy || !dirty) return;
    setSaving(true);
    setErr(null);
    setStatus(null);
    try {
      const next = await saveWorkTemplate(objectId, content, revision);
      apply(next);
      setStatus('已保存');
      onSaved();
      clearTimer();
      timer.current = window.setTimeout(() => setStatus(null), 2500);
    } catch (error) {
      setErr(apiError(error).message);
    } finally {
      setSaving(false);
    }
  }

  const reload = (): void => {
    if (dirty && !reloadArm) {
      setReloadArm(true);
      clearTimer();
      timer.current = window.setTimeout(() => setReloadArm(false), 3000);
      return;
    }
    clearTimer();
    void load();
  };

  const state = err ?? status ?? (dirty ? '未保存' : null);

  return (
    <section className="wk-sec wk-sec--template">
      <div className="wk-sec__title">
        <span>模板文件</span>
        <span className="wk-sec__note">{file?.path ?? 'template.cpp'}</span>
      </div>
      {loading ? (
        <div className="wk-empty wk-empty--small">正在读模板…</div>
      ) : file === null ? (
        <div className="alert alert--err" role="status">
          {err ?? '模板文件读不出来'}
        </div>
      ) : (
        <div className="wk-editor">
          <textarea
            className="wk-editor__area"
            value={content}
            rows={14}
            spellCheck={false}
            disabled={saving || busy}
            placeholder={file.exists ? undefined : '模板还没有主文件，保存会新建 template.cpp。'}
            aria-label={`${file.path} 模板代码`}
            onChange={(e) => {
              setContent(e.target.value);
              setErr(null);
              setStatus(null);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="wk-editor__bar">
            <button className="btn btn--primary btn--sm" disabled={saving || busy || !dirty} onClick={() => void save()}>
              <Icon id="i-save" />
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="btn btn--sm" disabled={saving || busy} onClick={reload}>
              {reloadArm ? '再点一次放弃修改' : '重新载入'}
            </button>
            <span className={`wk-editor__state${err !== null ? ' is-bad' : ''}`} aria-live="polite">
              {state}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
