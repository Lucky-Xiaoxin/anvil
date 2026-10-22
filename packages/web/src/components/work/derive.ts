/** 工坊前端的纯派生：树展开、筛选、搜索、名字查找（可单测，不碰 DOM） */
import type { WorkKind, WorkObjectDto, WorkTaxonomyDto } from '@anvil/shared';

export const KIND_NAME: Record<WorkKind, string> = {
  contest: '比赛',
  problem: '题目',
  template: '模板',
  note: '笔记',
};

export const KIND_ORDER: readonly WorkKind[] = ['contest', 'problem', 'template', 'note'];

/** 中间列表用语（契约 §2.3 / §12.3）：题组 / 比赛题组 / 未分组题目 */
export const WORK_SECTION = {
  groups: '比赛',
  contestBadge: '题组',
  ungrouped: '旧题目对象',
  templates: '模板',
  notes: '笔记',
  problemBadge: '题目',
} as const;

export interface FlatNode {
  id: string;
  name: string;
  parentId: string | null;
  count: number;
}

export function flatNodes(taxonomy: WorkTaxonomyDto | null): FlatNode[] {
  if (taxonomy === null) return [];
  const out: FlatNode[] = [];
  for (const node of taxonomy.nodes) {
    out.push({ id: node.id, name: node.name, parentId: null, count: node.count });
    for (const child of node.children ?? []) out.push({ id: child.id, name: child.name, parentId: node.id, count: child.count });
  }
  return out;
}

export function nodeNameMap(taxonomy: WorkTaxonomyDto | null): Map<string, string> {
  return new Map(flatNodes(taxonomy).map((n) => [n.id, n.name]));
}

/** 一级节点筛选时把直属二级也算进来（词表最多两级） */
export function tagTargetIds(taxonomy: WorkTaxonomyDto | null, nodeId: string): Set<string> {
  const targets = new Set<string>([nodeId]);
  for (const node of flatNodes(taxonomy)) {
    if (node.parentId === nodeId) targets.add(node.id);
  }
  return targets;
}

export function matchesTag(obj: WorkObjectDto, taxonomy: WorkTaxonomyDto | null, nodeId: string): boolean {
  const targets = tagTargetIds(taxonomy, nodeId);
  if (obj.tags.primary !== null && targets.has(obj.tags.primary)) return true;
  return obj.tags.related.some((id) => targets.has(id));
}

export interface WorkFilter {
  kind: WorkKind | 'all';
  nodeId: string | null;
  label: string | null;
  query: string;
}

export function filterWorkObjects(objects: readonly WorkObjectDto[], taxonomy: WorkTaxonomyDto | null, filter: WorkFilter): WorkObjectDto[] {
  const names = nodeNameMap(taxonomy);
  const q = filter.query.trim().toLowerCase();
  return objects.filter((obj) => {
    if (filter.kind !== 'all' && obj.kind !== filter.kind) return false;
    if (filter.nodeId !== null && !matchesTag(obj, taxonomy, filter.nodeId)) return false;
    if (filter.label !== null && !obj.labels.includes(filter.label)) return false;
    if (q !== '') {
      // TODO(切片5b): 词表 aliases 未进 WorkTreeDto；5a 检索先覆盖标题 / labels / 节点名 / 路径（契约 §7.1 已回写）
      const tagNames = [obj.tags.primary, ...obj.tags.related]
        .filter((id): id is string => id !== null)
        .map((id) => names.get(id) ?? id)
        .join(' ');
      const hay = `${obj.title} ${obj.labels.join(' ')} ${tagNames} ${obj.relPath}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface WorkContestGroup {
  contest: WorkObjectDto;
  /** 比赛本身命中筛选时，组头可点开比赛详情 */
  included: boolean;
  problems: WorkObjectDto[];
}

export interface WorkListModel {
  groups: WorkContestGroup[];
  ungrouped: WorkObjectDto[];
  templates: WorkObjectDto[];
  notes: WorkObjectDto[];
  /** parentId 指向不存在的对象：扫描层已报错，这里兜底照常列出 */
  orphans: WorkObjectDto[];
}

const byRelPath = (a: WorkObjectDto, b: WorkObjectDto): number => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);

/**
 * 中间列表分组（切片 5a.1 / 5a-2）：比赛题按父比赛折叠成组，parentId=null 的题目进「未分组题目」区。
 * `filtered` 是当前筛选结果，`all` 用来补出被 kind 筛选挡掉的父比赛标题。
 */
export function groupWorkObjects(filtered: readonly WorkObjectDto[], all: readonly WorkObjectDto[]): WorkListModel {
  const byId = new Map(all.map((obj) => [obj.id, obj]));
  const groups = new Map<string, WorkContestGroup>();
  const ungrouped: WorkObjectDto[] = [];
  const templates: WorkObjectDto[] = [];
  const notes: WorkObjectDto[] = [];
  const orphans: WorkObjectDto[] = [];

  const groupOf = (contest: WorkObjectDto): WorkContestGroup => {
    let group = groups.get(contest.id);
    if (group === undefined) {
      group = { contest, included: false, problems: [] };
      groups.set(contest.id, group);
    }
    return group;
  };

  for (const obj of filtered) {
    if (obj.kind === 'contest') {
      groupOf(obj).included = true;
    } else if (obj.kind === 'problem') {
      if (obj.parentId === null) {
        ungrouped.push(obj);
        continue;
      }
      const parent = byId.get(obj.parentId);
      if (parent !== undefined && parent.kind === 'contest') groupOf(parent).problems.push(obj);
      else orphans.push(obj);
    } else if (obj.kind === 'template') {
      templates.push(obj);
    } else {
      notes.push(obj);
    }
  }

  const sortedGroups = [...groups.values()]
    .map((group) => ({ ...group, problems: [...group.problems].sort(byRelPath) }))
    .sort((a, b) => byRelPath(a.contest, b.contest));
  return {
    groups: sortedGroups,
    ungrouped: ungrouped.sort(byRelPath),
    templates: templates.sort(byRelPath),
    notes: notes.sort(byRelPath),
    orphans: orphans.sort(byRelPath),
  };
}

/** 单题目录面包屑：`practice/2026-10/cherry-tree` → `['practice', '2026-10']` */
export function pathBreadcrumb(relPath: string): string[] {
  const parts = relPath.split('/').filter((part) => part !== '');
  return parts.slice(0, -1);
}

export interface WorkFolderAction {
  app: 'auto' | 'explorer' | 'vscode';
  label: string;
}

/** problem 详情必须同时给出资源管理器与 VS Code；其它对象保持 5a 的单一 auto 入口 */
export function folderActionsOf(kind: WorkKind): WorkFolderAction[] {
  if (kind === 'problem') {
    return [
      { app: 'explorer', label: '打开文件夹' },
      { app: 'vscode', label: '用 VS Code 打开' },
    ];
  }
  return [{ app: 'auto', label: '打开文件夹' }];
}

/** 比赛挂了题组（有自己的源码，或有旧的子题目对象）才显示「题组」徽章 */
export function contestBadgeOf(contest: WorkObjectDto, childCount: number): string | null {
  return childCount > 0 || contest.sourceCount > 0 ? WORK_SECTION.contestBadge : null;
}

export function contestCountLabel(contest: WorkObjectDto, childCount: number): string {
  if (childCount > 0) return `${childCount} 题`;
  if (contest.sourceCount > 0) return `${contest.sourceCount} 个源码`;
  return '无题组';
}

export function allLabels(objects: readonly WorkObjectDto[]): string[] {
  const out = new Set<string>();
  for (const obj of objects) for (const label of obj.labels) out.add(label);
  return [...out].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function primaryName(obj: WorkObjectDto, taxonomy: WorkTaxonomyDto | null): string | null {
  if (obj.tags.primary === null) return null;
  return nodeNameMap(taxonomy).get(obj.tags.primary) ?? obj.tags.primary;
}

export function kindCounts(objects: readonly WorkObjectDto[]): Record<WorkKind | 'all', number> {
  const counts: Record<WorkKind | 'all', number> = { all: objects.length, contest: 0, problem: 0, template: 0, note: 0 };
  for (const obj of objects) counts[obj.kind] += 1;
  return counts;
}

/** ISO → 2026-10-21；只用于列表的日期列 */
export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
