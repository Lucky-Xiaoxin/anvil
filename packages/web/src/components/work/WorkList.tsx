import { useEffect, useMemo, useState } from 'react';
import type { WorkObjectDto, WorkScanErrorDto, WorkTaxonomyDto, WorkTrashDto, WorkUnregisteredDto } from '@anvil/shared';
import { fmtInt } from '../../format.ts';
import { Icon } from '../ui.tsx';
import {
  KIND_NAME,
  WORK_SECTION,
  contestCountLabel,
  expandKeysForSelection,
  groupWorkObjects,
  groupWorkObjectsBySource,
  isoDate,
  pathBreadcrumb,
  primaryName,
  problemsetLinkOf,
  type WorkContestGroup,
  type WorkSourceGroup,
  type WorkSourceModel,
} from './derive.ts';

interface Props {
  objects: WorkObjectDto[];
  /** 未筛选全集（当前视图）：kind=题目 时仍能补出父比赛标题；比赛行的题组计数也按本视图统计 */
  allObjects: WorkObjectDto[];
  /** 全量 byId（活动 + 归档，27 §5.3）：关联状态解析统一走这一份 */
  allById: ReadonlyMap<string, WorkObjectDto>;
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  unregistered: WorkUnregisteredDto[];
  errors: WorkScanErrorDto[];
  trash: WorkTrashDto[];
  trashView: boolean;
  onAdopt: (item: WorkUnregisteredDto) => void;
  onRestoreEntry: (item: WorkTrashDto) => void;
  onPurge: () => void;
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
  /** 全量 byId：题组行解析关联比赛状态（含跨归档） */
  allById?: ReadonlyMap<string, WorkObjectDto>;
  /** 比赛行的关联题组数（当前视图口径，27 §5.1） */
  setCount?: number;
  /** 模板行：这件就是新建对象默认套用的那件（23 §6.1） */
  defaultTag?: boolean;
}) {
  const { obj, taxonomy, selected, child = false, breadcrumb = false } = props;
  const primary = primaryName(obj, taxonomy);
  const crumbs = breadcrumb ? pathBreadcrumb(obj.relPath) : [];
  const link =
    obj.kind === 'problemset' && props.allById !== undefined
      ? problemsetLinkOf(obj, props.allById)
      : { state: 'none' as const, contest: null };
  return (
    <button
      className={`wk-row${selected ? ' is-on' : ''}${child ? ' wk-row--child' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => props.onSelect(obj.id)}
    >
      <div className="wk-row__main">
        <div className="wk-row__title">
          {obj.kind === 'problem' ? <span className="wk-kindbadge">{WORK_SECTION.problemBadge}</span> : null}
          <span className="wk-row__titletext">{obj.title}</span>
          {obj.effectiveArchived ? <span className="wk-badge">归档</span> : null}
          {props.defaultTag === true ? <span className="wk-badge">默认</span> : null}
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
          {obj.kind === 'contest' && (props.setCount ?? 0) > 0 ? (
            <>
              <span className="wk-dot" />
              <span className="wk-row__tag" title="关联题组数">
                题组 {props.setCount}
              </span>
            </>
          ) : null}
          {link.state === 'ok' && link.contest !== null ? (
            <>
              <span className="wk-dot" />
              <span className="wk-row__tag" title={`关联比赛：${link.contest.title}`}>
                比赛 · {link.contest.title}
              </span>
            </>
          ) : null}
          {link.state === 'archived' && link.contest !== null ? (
            <>
              <span className="wk-dot" />
              <span className="wk-row__tag" title={`关联比赛：${link.contest.title}（已归档，只读）`}>
                {WORK_SECTION.linkArchived}
              </span>
            </>
          ) : null}
          {link.state === 'missing' ? (
            <>
              <span className="wk-dot" />
              <span className="wk-row__tag" title="关联的比赛在回收站或已不存在；题组本身不受影响">
                {WORK_SECTION.linkMissing}
              </span>
            </>
          ) : null}
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

function ContestGroupItems(props: {
  groups: WorkContestGroup[];
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allById: ReadonlyMap<string, WorkObjectDto>;
  setCountByContest: ReadonlyMap<string, number>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { groups, taxonomy, selectedId, collapsed, allById, setCountByContest } = props;
  return (
    <>
      {groups.map((group) => {
        const contest = group.contest;
        const folded = collapsed.has(contest.id);
        const primary = primaryName(contest, taxonomy);
        const setCount = setCountByContest.get(contest.id) ?? 0;
        if (group.problems.length === 0) {
          return (
            <ObjectRow
              key={contest.id}
              obj={contest}
              taxonomy={taxonomy}
              selected={selectedId === contest.id}
              onSelect={props.onSelect}
              allById={allById}
              setCount={setCount}
            />
          );
        }
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
                  <span className="wk-group__count">{contestCountLabel(contest, group.problems.length, setCount)}</span>
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
    </>
  );
}

function ContestGroups(props: {
  groups: WorkContestGroup[];
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allById: ReadonlyMap<string, WorkObjectDto>;
  setCountByContest: ReadonlyMap<string, number>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="wk-sec">
      <div className="wk-sec__title">
        <span>{WORK_SECTION.contests}</span>
        <b className="num">{props.groups.length}</b>
      </div>
      <ContestGroupItems {...props} />
    </div>
  );
}

function SourceGroupNode(props: {
  node: WorkSourceGroup;
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allById: ReadonlyMap<string, WorkObjectDto>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { node, collapsed } = props;
  const foldKey = `src:${node.key}`;
  const folded = collapsed.has(foldKey);
  return (
    <div className="wk-source">
      <div className="wk-source__head">
        <button
          className={`wk-group__toggle${folded ? '' : ' is-open'}`}
          aria-expanded={!folded}
          aria-label={folded ? `展开来源 ${node.label}` : `收起来源 ${node.label}`}
          onClick={() => props.onToggle(foldKey)}
        >
          <Icon id="i-chev" />
        </button>
        <div className="wk-source__main">
          <span className="wk-source__title" title={node.key || '（根）'}>
            {node.label}
          </span>
          <span className="wk-source__meta">
            {fmtInt(node.count)} 个题组 · {fmtInt(node.fileCount)} 个文件
          </span>
        </div>
      </div>
      {folded ? null : (
        <div className="wk-source__body">
          {node.objects.map((obj) => (
            <ObjectRow
              key={obj.id}
              obj={obj}
              taxonomy={props.taxonomy}
              selected={props.selectedId === obj.id}
              onSelect={props.onSelect}
              allById={props.allById}
            />
          ))}
          {node.children.map((child) => (
            <SourceGroupNode
              key={child.key}
              node={child}
              taxonomy={props.taxonomy}
              selectedId={props.selectedId}
              onSelect={props.onSelect}
              allById={props.allById}
              collapsed={collapsed}
              onToggle={props.onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProblemsetRows(props: {
  objects: WorkObjectDto[];
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allById: ReadonlyMap<string, WorkObjectDto>;
}) {
  return (
    <>
      {props.objects.map((obj) => (
        <ObjectRow
          key={obj.id}
          obj={obj}
          taxonomy={props.taxonomy}
          selected={props.selectedId === obj.id}
          onSelect={props.onSelect}
          allById={props.allById}
        />
      ))}
    </>
  );
}

function ProblemsetGroups(props: {
  model: WorkSourceModel;
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allById: ReadonlyMap<string, WorkObjectDto>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { model } = props;
  return (
    <div className="wk-sec">
      <div className="wk-sec__title">
        <span>{WORK_SECTION.problemSets}</span>
        <b className="num">{model.root!.count + model.unsourced.length}</b>
      </div>
      {model.root !== null ? (
        <SourceGroupNode
          node={model.root}
          taxonomy={props.taxonomy}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          allById={props.allById}
          collapsed={props.collapsed}
          onToggle={props.onToggle}
        />
      ) : null}
      {model.unsourced.length > 0 ? <ProblemsetRows objects={model.unsourced} taxonomy={props.taxonomy} selectedId={props.selectedId} onSelect={props.onSelect} allById={props.allById} /> : null}
    </div>
  );
}

export function WorkList(props: Props) {
  const { objects, allObjects, allById, taxonomy, selectedId, trashView, trash, unregistered, errors } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [purgeArmed, setPurgeArmed] = useState(false);
  const model = useMemo(() => groupWorkObjects(objects, allObjects), [objects, allObjects]);
  const sourceModel = useMemo(() => groupWorkObjectsBySource(model.problemSets), [model.problemSets]);
  /** 本视图口径的比赛 → 关联题组数（27 §5.1）：活动视图数活动题组，归档视图数归档题组 */
  const setCountByContest = useMemo(() => {
    const counts = new Map<string, number>();
    for (const obj of allObjects) {
      if (obj.kind !== 'problemset' || obj.parentId === null) continue;
      counts.set(obj.parentId, (counts.get(obj.parentId) ?? 0) + 1);
    }
    return counts;
  }, [allObjects]);

  useEffect(() => {
    setCollapsed(new Set());
  }, [props.filterKey]);

  useEffect(() => {
    setPurgeArmed(false);
  }, [trashView, trash.length]);

  useEffect(() => {
    if (selectedId === null) return;
    const keys = expandKeysForSelection(selectedId, allObjects, model);
    if (keys.length === 0) return;
    // 只在选中项变化时展开祖先；依赖里没有 collapsed / model，手动收起的组不会被自动弹回
    setCollapsed((prev) => {
      if (!keys.some((key) => prev.has(key))) return prev;
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

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
          {trash.length > 0 ? (
            <button
              className={`btn btn--xs${purgeArmed ? ' btn--danger' : ''}`}
              style={{ marginLeft: 'auto' }}
              disabled={props.busyId !== null}
              title="永久删除回收站里的全部条目（不可恢复）"
              onClick={() => {
                if (!purgeArmed) {
                  setPurgeArmed(true);
                  return;
                }
                setPurgeArmed(false);
                props.onPurge();
              }}
              onBlur={() => setPurgeArmed(false)}
            >
              {purgeArmed ? '确认清空' : '清空'}
            </button>
          ) : null}
        </div>
        {trash.length === 0 ? (
          <div className="wk-empty">回收站是空的。</div>
        ) : (
          trash.map((item) => {
            if (item.entryType === 'object') {
              return (
                <div className="wk-row wk-row--trash" key={`obj-${item.id}-${item.trashedAt}`}>
                  <div className="wk-row__main">
                    <div className="wk-row__title">
                      <span className="wk-trashbadge">对象</span>
                      {item.title}
                    </div>
                    <div className="wk-row__meta">
                      <span>{isoDate(item.trashedAt)}</span>
                      <span className="wk-dot" />
                      <code>{item.originalRelPath}</code>
                    </div>
                  </div>
                  <button className="btn btn--sm" disabled={props.busyId !== null} onClick={() => props.onRestoreEntry(item)}>
                    恢复
                  </button>
                </div>
              );
            }
            const parent = props.allById.get(item.contestId) ?? null;
            const parentTrashed = props.trash.some((t) => t.entryType === 'object' && t.id === item.contestId);
            const parentArchived = parent?.effectiveArchived === true;
            const blocked = parent === null || parentArchived;
            const hint = parentTrashed
              ? '原比赛在回收站：先恢复比赛'
              : parent === null
                ? '原比赛不存在：不能恢复'
                : parentArchived
                  ? '原比赛已归档：先取消归档'
                  : '';
            return (
              <div className="wk-row wk-row--trash" key={`rec-${item.id}-${item.trashedAt}`}>
                <div className="wk-row__main">
                  <div className="wk-row__title">
                    <span className="wk-trashbadge wk-trashbadge--record">成绩</span>
                    {item.title}
                  </div>
                  <div className="wk-row__meta">
                    <span>{isoDate(item.trashedAt)}</span>
                    <span className="wk-dot" />
                    <span title={item.arenaPath}>所属比赛 · {parent?.title ?? item.arenaPath.split('/').pop()}</span>
                    <span className="wk-dot" />
                    <code>{item.fileName}</code>
                    {hint !== '' ? (
                      <>
                        <span className="wk-dot" />
                        <span className="wk-row__tag" title="父比赛尚在回收站或已缺失，先恢复原比赛">{hint}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <button
                  className="btn btn--sm"
                  disabled={props.busyId !== null || blocked}
                  title={blocked ? hint : '恢复到原比赛目录；目标已存在会拒绝'}
                  onClick={() => props.onRestoreEntry(item)}
                >
                  恢复
                </button>
              </div>
            );
          })
        )}
        <p className="wk-hint">恢复按类型分派：对象回原路径，成绩回原比赛的 .anvil-records / 旧根文件；原位置被占或父比赛缺失时会拒绝，不会自动改名。清空会永久删除两类合法条目。</p>
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
          allById={allById}
          setCountByContest={setCountByContest}
          collapsed={collapsed}
          onToggle={toggleGroup}
        />
      ) : null}

      {model.problemSets.length > 0 ? (
        sourceModel.hasSourcePath ? (
          <ProblemsetGroups
            model={sourceModel}
            taxonomy={taxonomy}
            selectedId={selectedId}
            onSelect={props.onSelect}
            allById={allById}
            collapsed={collapsed}
            onToggle={toggleGroup}
          />
        ) : (
          <div className="wk-sec">
            <div className="wk-sec__title">
              <span>{WORK_SECTION.problemSets}</span>
              <b className="num">{model.problemSets.length}</b>
            </div>
            <ProblemsetRows
              objects={model.problemSets}
              taxonomy={taxonomy}
              selectedId={selectedId}
              onSelect={props.onSelect}
              allById={allById}
            />
          </div>
        )
      ) : null}

      {model.ungrouped.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>{WORK_SECTION.ungrouped}</span>
            <b className="num">{model.ungrouped.length}</b>
          </div>
          {model.ungrouped.map((obj) => (
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
            <span>{WORK_SECTION.templates}</span>
            <b className="num">{model.templates.length}</b>
          </div>
          {model.templates.map((obj) => (
            <ObjectRow
              key={obj.id}
              obj={obj}
              taxonomy={taxonomy}
              selected={selectedId === obj.id}
              onSelect={props.onSelect}
              defaultTag={obj.id === model.defaultTemplateId}
            />
          ))}
        </div>
      ) : null}

      {model.notes.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>{WORK_SECTION.notes}</span>
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
