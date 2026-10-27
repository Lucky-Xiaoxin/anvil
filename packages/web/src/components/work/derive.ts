/** 工坊前端的纯派生：树展开、筛选、搜索、名字查找（可单测，不碰 DOM） */
import { compareSourcePathNatural, defaultTemplateOf, sourceParentPath } from '@anvil/shared';
import type { WorkKind, WorkObjectDto, WorkTaxonomyDto } from '@anvil/shared';

export const KIND_NAME: Record<WorkKind, string> = {
  contest: '比赛',
  problemset: '题组',
  problem: '题目',
  template: '模板',
  note: '笔记',
};

export const KIND_ORDER: readonly WorkKind[] = ['contest', 'problemset', 'problem', 'template', 'note'];

/** 中间列表分区（26 §6.1）：比赛 / 题组按 kind；旧题目对象仅兼容区 */
export const WORK_SECTION = {
  contests: '比赛',
  problemSets: '题组',
  ungrouped: '旧题目对象',
  templates: '模板',
  notes: '笔记',
  problemBadge: '题目',
  linkMissing: '关联比赛不可用',
  linkArchived: '关联比赛已归档',
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
  /** 旧 problem 子题（兼容折叠组）；题组（problemset）不在这里 */
  problems: WorkObjectDto[];
}

export interface WorkListModel {
  /** 比赛折叠组：有旧 problem 子题的比赛成组，其余比赛以平铺行出现（problems 为空） */
  groups: WorkContestGroup[];
  /** 题组（kind=problemset），独立对象区 */
  problemSets: WorkObjectDto[];
  /** 旧 problem 无父对象 */
  ungrouped: WorkObjectDto[];
  templates: WorkObjectDto[];
  /** 新建对象默认套用的那件模板（23 §6.1：非归档里 updatedAt 最新的一件）；列表里打「默认」标 */
  defaultTemplateId: string | null;
  notes: WorkObjectDto[];
  /** parentId 指向不存在的对象：扫描层已报错，这里兜底照常列出 */
  orphans: WorkObjectDto[];
}

const byRelPath = (a: WorkObjectDto, b: WorkObjectDto): number => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);

/**
 * 中间列表分区（26 §6.1）：按 kind 分区，不读 arenaPath / sourcePath。
 * 比赛行的 problems 只装旧 problem 子题；题组（problemset）是独立对象。
 * `filtered` 是当前筛选结果，`all` 用来补出被 kind 筛选挡掉的父比赛标题。
 */
export function groupWorkObjects(filtered: readonly WorkObjectDto[], all: readonly WorkObjectDto[]): WorkListModel {
  const byId = new Map(all.map((obj) => [obj.id, obj]));
  const groups = new Map<string, WorkContestGroup>();
  const problemSets: WorkObjectDto[] = [];
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
    } else if (obj.kind === 'problemset') {
      problemSets.push(obj);
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
    problemSets: problemSets.sort(byRelPath),
    ungrouped: ungrouped.sort(byRelPath),
    templates: templates.sort(byRelPath),
    // 判据走全量对象：kind 筛选挡掉一部分模板时，默认那件不能跟着变
    defaultTemplateId: defaultTemplateOf(all)?.id ?? null,
    notes: notes.sort(byRelPath),
    orphans: orphans.sort(byRelPath),
  };
}

/* ------------------------------------------------------------------ */
/* 5a-3 / 5a-4：来源虚拟视图（只组织有 sourcePath 的题组，26 §6.1）       */
/* ------------------------------------------------------------------ */

export interface WorkSourceGroup {
  /** 来源父路径；根级为 '' */
  key: string;
  label: string;
  name: string;
  /** 该来源路径下的题组对象 */
  objects: WorkObjectDto[];
  children: WorkSourceGroup[];
  /** 含子分组在内的题组数 */
  count: number;
  /** 含子分组在内的文件数 */
  fileCount: number;
}

export interface WorkSourceModel {
  /** null 表示没有任何带 sourcePath 的题组，题组区退化为平铺 */
  root: WorkSourceGroup | null;
  /** 无 sourcePath 的题组是普通题组行（26 已拍板 #9：不设负向区） */
  unsourced: WorkObjectDto[];
  hasSourcePath: boolean;
}

function sourceGroupOf(key: string): WorkSourceGroup {
  return {
    key,
    label: key === '' ? '（根）' : key.split('/').join(' / '),
    name: key === '' ? '（根）' : (key.split('/').pop() ?? key),
    objects: [],
    children: [],
    count: 0,
    fileCount: 0,
  };
}

/**
 * 按 problemset.sourcePath 的父路径生成虚拟来源树。
 * 节点只由 sourcePath 派生，不是对象、不能打开或操作；比赛不进入来源树。
 */
export function groupWorkObjectsBySource(problemSets: readonly WorkObjectDto[]): WorkSourceModel {
  // 只匹配 problemset（26 §9.1）：比赛 / 旧题目即使带 sourcePath 也不进来源树
  const sets = problemSets.filter((obj) => obj.kind === 'problemset');
  const sourced = sets.filter((obj) => obj.sourcePath !== undefined);
  const sorted = [...sets].sort(byRelPath);
  if (sourced.length === 0) {
    return { root: null, unsourced: sorted, hasSourcePath: false };
  }

  const root = sourceGroupOf('');
  const nodes = new Map<string, WorkSourceGroup>([['', root]]);
  const ensure = (key: string): WorkSourceGroup => {
    const existing = nodes.get(key);
    if (existing !== undefined) return existing;
    const slash = key.lastIndexOf('/');
    const parentKey = slash < 0 ? '' : key.slice(0, slash);
    const node = sourceGroupOf(key);
    ensure(parentKey).children.push(node);
    nodes.set(key, node);
    return node;
  };

  for (const obj of sourced) {
    const sourcePath = obj.sourcePath!;
    const parent = sourceParentPath(sourcePath) ?? '';
    ensure(parent).objects.push(obj);
  }
  const unsourced = sorted.filter((obj) => obj.sourcePath === undefined);

  const sortNode = (node: WorkSourceGroup): void => {
    node.children.sort((a, b) => compareSourcePathNatural(a.key, b.key));
    node.objects.sort((a, b) => {
      const left = a.sourcePath ?? '';
      const right = b.sourcePath ?? '';
      return compareSourcePathNatural(left, right) || byRelPath(a, b);
    });
    for (const child of node.children) sortNode(child);
  };
  sortNode(root);

  const countNode = (node: WorkSourceGroup): void => {
    let count = node.objects.length;
    let fileCount = node.objects.reduce((sum, obj) => sum + obj.fileCount, 0);
    for (const child of node.children) {
      countNode(child);
      count += child.count;
      fileCount += child.fileCount;
    }
    node.count = count;
    node.fileCount = fileCount;
  };
  countNode(root);

  return { root, unsourced, hasSourcePath: true };
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

/** 比赛 / 题组 / 旧题目对象都给出资源管理器与 VS Code；模板 / 笔记保持 5a 的单一 auto 入口 */
export function folderActionsOf(kind: WorkKind): WorkFolderAction[] {
  if (kind === 'problem' || kind === 'contest' || kind === 'problemset') {
    return [
      { app: 'explorer', label: '打开文件夹' },
      { app: 'vscode', label: '用 VS Code 打开' },
    ];
  }
  return [{ app: 'auto', label: '打开文件夹' }];
}

/** 比赛行的行尾摘要（27 §2.2）：旧子题数 + 关联题组数，都为 0 时退回源码计数 */
export function contestCountLabel(contest: WorkObjectDto, childCount: number, setCount: number): string {
  const parts: string[] = [];
  if (childCount > 0) parts.push(`${childCount} 题`);
  if (setCount > 0) parts.push(`题组 ${setCount}`);
  if (parts.length === 0 && contest.sourceCount > 0) return `${contest.sourceCount} 个源码`;
  return parts.join(' · ');
}

/* ---------- 5a-4 / 5a-5：关联比赛（题组 0..1 → 比赛，比赛侧 0..n，逻辑 parentId） ---------- */

export interface ProblemsetLink {
  state: 'none' | 'ok' | 'archived' | 'missing';
  contest: WorkObjectDto | null;
}

/**
 * 题组 → 关联比赛（27 §2.3）。父对象不在索引（被回收 / 删除）时是 missing；
 * 父对象归档时是 archived——不是缺失，题组照常可用，关联只读。
 */
export function problemsetLinkOf(obj: WorkObjectDto, byId: ReadonlyMap<string, WorkObjectDto>): ProblemsetLink {
  if (obj.kind !== 'problemset' || obj.parentId === null) return { state: 'none', contest: null };
  const contest = byId.get(obj.parentId) ?? null;
  if (contest === null || contest.kind !== 'contest') return { state: 'missing', contest: null };
  if (contest.effectiveArchived) return { state: 'archived', contest };
  return { state: 'ok', contest };
}

/** 比赛 → 关联题组（0..n，27 §2.2）：按 effectiveArchived 拆成活动 / 已归档两组 */
export function linkedProblemsetsOf(
  contest: WorkObjectDto,
  objects: readonly WorkObjectDto[],
): { active: WorkObjectDto[]; archived: WorkObjectDto[] } {
  const active: WorkObjectDto[] = [];
  const archived: WorkObjectDto[] = [];
  for (const obj of objects) {
    if (obj.kind !== 'problemset' || obj.parentId !== contest.id) continue;
    (obj.effectiveArchived ? archived : active).push(obj);
  }
  return { active, archived };
}

/** 关联比赛选择器候选（27 §2.3）：只列活动比赛；比赛侧 0..n，不排除被占用者 */
export function availableContests(objects: readonly WorkObjectDto[]): WorkObjectDto[] {
  return objects.filter((obj) => obj.kind === 'contest' && !obj.effectiveArchived).sort(byRelPath);
}

/**
 * 选中对象需要展开的折叠键：题组带 sourcePath 时是其来源祖先链（src:*），旧题目对象是其父比赛组。
 * 只在选中项变化时调用；不读折叠状态，调用方用函数式 setCollapsed 自己判断哪些键真的收着。
 */
export function expandKeysForSelection(selectedId: string, objects: readonly WorkObjectDto[], model: WorkListModel): string[] {
  const keys = new Set<string>();
  const selected = objects.find((obj) => obj.id === selectedId);
  if (selected !== undefined && selected.kind === 'problemset' && selected.sourcePath !== undefined) {
    let parent = sourceParentPath(selected.sourcePath) ?? '';
    for (;;) {
      keys.add(`src:${parent}`);
      if (parent === '') break;
      const slash = parent.lastIndexOf('/');
      parent = slash < 0 ? '' : parent.slice(0, slash);
    }
  }
  const group = model.groups.find((g) => g.contest.id === selectedId || g.problems.some((p) => p.id === selectedId));
  if (group !== undefined) keys.add(group.contest.id);
  return [...keys];
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
  const counts: Record<WorkKind | 'all', number> = { all: objects.length, contest: 0, problemset: 0, problem: 0, template: 0, note: 0 };
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
