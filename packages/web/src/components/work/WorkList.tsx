import { useEffect, useMemo, useState } from 'react';
import type { WorkObjectDto, WorkScanErrorDto, WorkTaxonomyDto, WorkTrashDto, WorkUnregisteredDto } from '@anvil/shared';
import { fmtInt } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { KIND_NAME, groupWorkObjects, isoDate, pathBreadcrumb, primaryName, type WorkContestGroup } from './derive.ts';

interface Props {
  objects: WorkObjectDto[];
  /** 未筛选全集：kind=题目 时仍能补出父比赛标题 */
  allObjects: WorkObjectDto[];
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  unregistered: WorkUnregisteredDto[];
  errors: WorkScanErrorDto[];
  trash: WorkTrashDto[];
  trashView: boolean;
  onAdopt: (item: WorkUnregisteredDto) => void;
  onRestore: (id: string) => void;
  busyId: string | null;
  /** 筛选条件变化时重置折叠状态，避免搜索命中藏在收起的组里 */
  filterKey: string;
}

const ERROR_NAME: Record<WorkScanErrorDto['kind'], string> = {
  'meta-invalid': 'meta 不合法',
  'parent-missing': '父对象缺失',
  'tag-missing': '标签悬空',
  symlink: '符号链接',
  scan: '读取失败',
};

function ObjectRow(props: {
  obj: WorkObjectDto;
  taxonomy: WorkTaxonomyDto | null;
  selected: boolean;
  onSelect: (id: string) => void;
  child?: boolean;
  breadcrumb?: boolean;
}) {
  const { obj, taxonomy, selected, child = false, breadcrumb = false } = props;
  const primary = primaryName(obj, taxonomy);
  const crumbs = breadcrumb ? pathBreadcrumb(obj.relPath) : [];
  return (
    <button
      className={`wk-row${selected ? ' is-on' : ''}${child ? ' wk-row--child' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => props.onSelect(obj.id)}
    >
      <div className="wk-row__main">
        <div className="wk-row__title">
          {obj.title}
          {obj.effectiveArchived ? <span className="wk-badge">归档</span> : null}
        </div>
        {breadcrumb ? (
          <div className="wk-row__crumb" title={obj.relPath}>
            {crumbs.length === 0 ? (
              <span>（根）</span>
            ) : (
              crumbs.map((part, i) => (
                <span key={`${part}-${i}`}>
                  {i > 0 ? <span className="wk-row__crumbsep">›</span> : null}
                  {part}
                </span>
              ))
            )}
          </div>
        ) : null}
        <div className="wk-row__meta">
          <span>{isoDate(obj.createdAt)}</span>
          {primary !== null ? (
            <>
              <span className="wk-dot" />
              <span className="wk-row__tag">{primary}</span>
            </>
          ) : null}
          <span className="wk-dot" />
          <span>{fmtInt(obj.fileCount)} 个文件</span>
        </div>
      </div>
      {obj.labels.length > 0 ? (
        <span className="wk-row__labels">
          {obj.labels.slice(0, 3).map((label) => (
            <span className="wk-chip" key={label}>
              {label}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

function ContestGroups(props: {
  groups: WorkContestGroup[];
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { groups, taxonomy, selectedId, collapsed } = props;
  return (
    <div className="wk-sec">
      <div className="wk-sec__title">
        <span>比赛</span>
        <b className="num">{groups.length}</b>
      </div>
      {groups.map((group) => {
        const contest = group.contest;
        const folded = collapsed.has(contest.id);
        const primary = primaryName(contest, taxonomy);
        return (
          <div className={`wk-group${selectedId === contest.id ? ' is-on' : ''}`} key={contest.id}>
            <div className="wk-group__head">
              <button
                className={`wk-group__toggle${folded ? '' : ' is-open'}`}
                aria-expanded={!folded}
                aria-label={folded ? `展开 ${contest.title}` : `收起 ${contest.title}`}
                onClick={() => props.onToggle(contest.id)}
              >
                <Icon id="i-chev" />
              </button>
              <div className="wk-group__main">
                <div className="wk-group__titlerow">
                  {group.included ? (
                    <button className="wk-group__title" onClick={() => props.onSelect(contest.id)} title="查看比赛详情">
                      {contest.title}
                    </button>
                  ) : (
                    <span className="wk-group__title wk-group__title--static">{contest.title}</span>
                  )}
                  {contest.effectiveArchived ? <span className="wk-badge">归档</span> : null}
                  <span className="wk-group__count">{group.problems.length} 题</span>
                </div>
                <div className="wk-group__meta">
                  <span>{isoDate(contest.createdAt)}</span>
                  {primary !== null ? (
                    <>
                      <span className="wk-dot" />
                      <span className="wk-row__tag">{primary}</span>
                    </>
                  ) : null}
                  <span className="wk-dot" />
                  <span>{fmtInt(contest.fileCount)} 个文件</span>
                </div>
              </div>
            </div>
            {folded ? null : group.problems.length === 0 ? (
              <div className="wk-empty wk-empty--small wk-empty--child">这场还没有题目。</div>
            ) : (
              group.problems.map((problem) => (
                <ObjectRow
                  key={problem.id}
                  obj={problem}
                  taxonomy={taxonomy}
                  selected={selectedId === problem.id}
                  onSelect={props.onSelect}
                  child
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

export function WorkList(props: Props) {
  const { objects, allObjects, taxonomy, selectedId, trashView, trash, unregistered, errors } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const model = useMemo(() => groupWorkObjects(objects, allObjects), [objects, allObjects]);

  useEffect(() => {
    setCollapsed(new Set());
  }, [props.filterKey]);

  useEffect(() => {
    if (selectedId === null) return;
    const group = model.groups.find((g) => g.problems.some((p) => p.id === selectedId));
    if (group === undefined) return;
    setCollapsed((prev) => {
      if (!prev.has(group.contest.id)) return prev;
      const next = new Set(prev);
      next.delete(group.contest.id);
      return next;
    });
  }, [model, selectedId]);

  const toggleGroup = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (trashView) {
    return (
      <div className="wk-list">
        <div className="wk-sec__title">
          <span>回收站</span>
          <b className="num">{trash.length}</b>
        </div>
        {trash.length === 0 ? (
          <div className="wk-empty">回收站是空的。</div>
        ) : (
          trash.map((item) => (
            <div className="wk-row wk-row--trash" key={`${item.id}-${item.trashedAt}`}>
              <div className="wk-row__main">
                <div className="wk-row__title">{item.title}</div>
                <div className="wk-row__meta">
                  <span>{isoDate(item.trashedAt)}</span>
                  <span className="wk-dot" />
                  <code>{item.originalRelPath}</code>
                </div>
              </div>
              <button className="btn btn--sm" disabled={props.busyId !== null} onClick={() => props.onRestore(item.id)}>
                恢复
              </button>
            </div>
          ))
        )}
        <p className="wk-hint">恢复按原路径移回；原路径被占或父目录缺失时会拒绝，不会自动改名。</p>
      </div>
    );
  }

  return (
    <div className="wk-list">
      <div className="wk-sec__title">
        <span>对象</span>
        <b className="num">{objects.length}</b>
      </div>
      {objects.length === 0 ? <div className="wk-empty">没有符合条件的对象。换个筛选，或新建一个。</div> : null}

      {model.groups.length > 0 ? (
        <ContestGroups
          groups={model.groups}
          taxonomy={taxonomy}
          selectedId={selectedId}
          onSelect={props.onSelect}
          collapsed={collapsed}
          onToggle={toggleGroup}
        />
      ) : null}

      {model.standalone.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>单题</span>
            <b className="num">{model.standalone.length}</b>
          </div>
          {model.standalone.map((obj) => (
            <ObjectRow
              key={obj.id}
              obj={obj}
              taxonomy={taxonomy}
              selected={selectedId === obj.id}
              onSelect={props.onSelect}
              breadcrumb
            />
          ))}
        </div>
      ) : null}

      {model.templates.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>模板</span>
            <b className="num">{model.templates.length}</b>
          </div>
          {model.templates.map((obj) => (
            <ObjectRow key={obj.id} obj={obj} taxonomy={taxonomy} selected={selectedId === obj.id} onSelect={props.onSelect} />
          ))}
        </div>
      ) : null}

      {model.notes.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>笔记</span>
            <b className="num">{model.notes.length}</b>
          </div>
          {model.notes.map((obj) => (
            <ObjectRow key={obj.id} obj={obj} taxonomy={taxonomy} selected={selectedId === obj.id} onSelect={props.onSelect} />
          ))}
        </div>
      ) : null}

      {model.orphans.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>父对象缺失</span>
            <b className="num">{model.orphans.length}</b>
          </div>
          {model.orphans.map((obj) => (
            <ObjectRow
              key={obj.id}
              obj={obj}
              taxonomy={taxonomy}
              selected={selectedId === obj.id}
              onSelect={props.onSelect}
              breadcrumb
            />
          ))}
        </div>
      ) : null}

      {unregistered.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>未登记</span>
            <b className="num">{unregistered.length}</b>
          </div>
          {unregistered.map((item) => (
            <div className="wk-row wk-row--mini" key={item.relPath}>
              <div className="wk-row__main">
                <div className="wk-row__title">
                  <code>{item.relPath}</code>
                </div>
                <div className="wk-row__meta">
                  <span>推断：{item.kindHint === null ? '未定' : KIND_NAME[item.kindHint]}</span>
                </div>
              </div>
              <button className="btn btn--xs" disabled={props.busyId !== null} onClick={() => props.onAdopt(item)}>
                <Icon id="i-plus" />
                登记
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>错误</span>
            <b className="num">{errors.length}</b>
          </div>
          {errors.map((err, i) => (
            <div className="wk-error" key={`${err.relPath}-${err.kind}-${i}`}>
              <span className="wk-error__kind">{ERROR_NAME[err.kind]}</span>
              <code>{err.relPath === '' ? '（根）' : err.relPath}</code>
              <span className="wk-error__msg">{err.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
