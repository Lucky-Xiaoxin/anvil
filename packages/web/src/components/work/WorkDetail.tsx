import { useEffect, useRef, useState } from 'react';
import type { WorkObjectDetailDto, WorkTaxonomyDto } from '@anvil/shared';
import { fullStamp, fmtInt } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { fileSize, flatNodes, isoDate, nodeNameMap } from './derive.ts';

interface Props {
  detail: WorkObjectDetailDto;
  taxonomy: WorkTaxonomyDto | null;
  taxonomyError: string | null;
  parentTitle: string | null;
  busy: string | null;
  onRetitle: (title: string) => void;
  onTags: (tags: { primary?: string | null; related?: string[] }) => void;
  onLabels: (labels: string[]) => void;
  onArchive: (archived: boolean) => void;
  onTrash: () => void;
  onOpen: (relPath?: string) => void;
  onSelectTag: (id: string) => void;
  onFilterLabel: (label: string) => void;
}

export function WorkDetail(props: Props) {
  const { detail, taxonomy } = props;
  const [title, setTitle] = useState(detail.title);
  const [editing, setEditing] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [confirmTrash, setConfirmTrash] = useState(false);
  const trashTimer = useRef<number | null>(null);
  const titleInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle(detail.title);
    setEditing(false);
    setLabelInput('');
    setConfirmTrash(false);
  }, [detail.id, detail.title]);

  useEffect(() => {
    if (editing) titleInput.current?.focus();
  }, [editing]);

  useEffect(
    () => () => {
      if (trashTimer.current !== null) window.clearTimeout(trashTimer.current);
    },
    [],
  );

  const nodes = flatNodes(taxonomy);
  const names = nodeNameMap(taxonomy);
  const primary = detail.tags.primary;
  const related = detail.tags.related;

  const saveTitle = (): void => {
    const next = title.trim();
    setEditing(false);
    if (next === '' || next === detail.title) {
      setTitle(detail.title);
      return;
    }
    props.onRetitle(next);
  };

  const setPrimary = (value: string): void => {
    const next = value === '' ? null : value;
    props.onTags({ primary: next, related: related.filter((id) => id !== next) });
  };

  const addRelated = (value: string): void => {
    if (value === '' || related.includes(value) || value === primary) return;
    props.onTags({ related: [...related, value] });
  };

  const removeRelated = (id: string): void => {
    props.onTags({ related: related.filter((x) => x !== id) });
  };

  const addLabel = (): void => {
    const next = labelInput.trim().replace(/^#+/, '').trim();
    if (next === '') return;
    if (next.length > 24 || detail.labels.includes(next) || detail.labels.length >= 20) {
      setLabelInput('');
      return;
    }
    props.onLabels([...detail.labels, next]);
    setLabelInput('');
  };

  const askTrash = (): void => {
    if (!confirmTrash) {
      setConfirmTrash(true);
      if (trashTimer.current !== null) window.clearTimeout(trashTimer.current);
      trashTimer.current = window.setTimeout(() => setConfirmTrash(false), 3000);
      return;
    }
    if (trashTimer.current !== null) window.clearTimeout(trashTimer.current);
    setConfirmTrash(false);
    props.onTrash();
  };

  return (
    <div className="wk-detail">
      <div className="wk-detail__head">
        {editing ? (
          <div className="wk-detail__titleedit">
            <input
              ref={titleInput}
              className="input"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveTitle();
                } else if (e.key === 'Escape') {
                  setTitle(detail.title);
                  setEditing(false);
                }
              }}
              onBlur={saveTitle}
              aria-label="对象标题"
            />
          </div>
        ) : (
          <button className="wk-detail__title" onClick={() => setEditing(true)} title="点击改标题（目录不动）">
            <span>{detail.title}</span>
            <Icon id="i-pencil" />
          </button>
        )}
        <div className="wk-detail__meta">
          <span className="wk-kind">{detail.kind === 'contest' ? '比赛' : detail.kind === 'problem' ? '题目' : detail.kind === 'template' ? '模板' : '笔记'}</span>
          {detail.archived ? <span className="wk-badge">已归档</span> : null}
          {!detail.archived && detail.effectiveArchived ? <span className="wk-badge">父对象归档</span> : null}
          <span className="wk-dot" />
          <span>创建 {isoDate(detail.createdAt)}</span>
          <span className="wk-dot" />
          <span>更新 {isoDate(detail.updatedAt)}</span>
        </div>
        <code className="wk-path">{detail.relPath}</code>
      </div>

      <div className="wk-detail__actions">
        <button className="btn btn--sm" onClick={() => props.onOpen()}>
          <Icon id="i-folder" />
          打开文件夹
        </button>
        <button className="btn btn--sm" onClick={() => props.onArchive(!detail.archived)}>
          <Icon id="i-archive" />
          {detail.archived ? '取消归档' : '归档'}
        </button>
        <button className={`btn btn--sm${confirmTrash ? ' btn--danger' : ''}`} onClick={askTrash}>
          <Icon id="i-trash" />
          {confirmTrash ? '再点一次确认' : '移入回收站'}
        </button>
      </div>

      <section className="wk-sec">
        <div className="wk-sec__title">
          <span>标签</span>
          {props.taxonomyError !== null ? <span className="wk-sec__note">词表坏掉，编辑已禁用</span> : null}
        </div>
        <div className="wk-field">
          <label className="wk-label" htmlFor="wk-primary">
            primary
          </label>
          <select
            id="wk-primary"
            className="wk-select"
            value={primary ?? ''}
            disabled={props.busy !== null || props.taxonomyError !== null}
            onChange={(e) => setPrimary(e.target.value)}
          >
            <option value="">未分类</option>
            {nodes.map((node) => (
              <option value={node.id} key={node.id}>
                {node.parentId === null ? node.name : `  ${node.name}`}
              </option>
            ))}
          </select>
        </div>
        <div className="wk-field">
          <span className="wk-label">related</span>
          <div className="wk-chips">
            {related.length === 0 ? <span className="wk-muted">没有关联标签</span> : null}
            {related.map((id) => (
              <span className="wk-chip wk-chip--tag" key={id}>
                <button className="wk-chip__txt" onClick={() => props.onSelectTag(id)}>
                  {names.get(id) ?? id}
                </button>
                <button
                  className="wk-chip__x"
                  aria-label={`移除 ${names.get(id) ?? id}`}
                  disabled={props.busy !== null || props.taxonomyError !== null}
                  onClick={() => removeRelated(id)}
                >
                  ×
                </button>
              </span>
            ))}
            <select
              className="wk-select wk-select--inline"
              value=""
              disabled={props.busy !== null || props.taxonomyError !== null}
              aria-label="添加关联标签"
              onChange={(e) => {
                addRelated(e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">＋ 关联标签</option>
              {nodes
                .filter((node) => node.id !== primary && !related.includes(node.id))
                .map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.parentId === null ? node.name : `  ${node.name}`}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </section>

      <section className="wk-sec">
        <div className="wk-sec__title">
          <span>自由标签</span>
          <span className="wk-sec__note">{detail.labels.length}/20</span>
        </div>
        <div className="wk-chips">
          {detail.labels.map((label) => (
            <span className="wk-chip" key={label}>
              <button className="wk-chip__txt" onClick={() => props.onFilterLabel(label)}>
                {label}
              </button>
              <button
                className="wk-chip__x"
                aria-label={`移除标签 ${label}`}
                disabled={props.busy !== null}
                onClick={() => props.onLabels(detail.labels.filter((x) => x !== label))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="wk-labelinput"
            value={labelInput}
            placeholder="＋ 标签，回车添加"
            maxLength={24}
            disabled={props.busy !== null || detail.labels.length >= 20}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLabel();
              }
            }}
          />
        </div>
      </section>

      {detail.links.problemKey !== undefined || detail.links.arenaPath !== undefined || props.parentTitle !== null ? (
        <section className="wk-sec">
          <div className="wk-sec__title">
            <span>关联</span>
          </div>
          <div className="wk-kv">
            {props.parentTitle !== null ? (
              <>
                <span>父比赛</span>
                <b>{props.parentTitle}</b>
              </>
            ) : null}
            {detail.links.problemKey !== undefined ? (
              <>
                <span>题目 key</span>
                <code>{detail.links.problemKey}</code>
              </>
            ) : null}
            {detail.links.arenaPath !== undefined ? (
              <>
                <span>榜单路径</span>
                <code>{detail.links.arenaPath}</code>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="wk-sec wk-sec--files">
        <div className="wk-sec__title">
          <span>文件</span>
          <b className="num">{fmtInt(detail.fileCount)}</b>
          {detail.filesTruncated ? <span className="wk-sec__note">只列前 500 个</span> : null}
        </div>
        {detail.files.length === 0 ? (
          <div className="wk-empty wk-empty--small">还没有文件。CPH / 编辑器新建后重新扫描。</div>
        ) : (
          <div className="wk-files">
            {detail.files.map((file) => (
              <button className="wk-file" key={file.path} onClick={() => props.onOpen(file.path)} title={`打开 ${file.path}`}>
                <Icon id="i-file" />
                <span className="wk-file__path">{file.path}</span>
                <span className="wk-file__size">{fileSize(file.size)}</span>
                <span className="wk-file__time">{fullStamp(file.mtime)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
