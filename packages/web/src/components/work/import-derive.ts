/** 导入视图的纯状态派生：批量选择、预览树、提交摘要，可单测不碰 DOM */
import {
  batchCandidatesConflict,
  compareSourcePathNatural,
  resolveBatchImportSelection,
  type BatchImportSelectableCandidate,
  type WorkImportCandidateDto,
  type WorkImportCommitItemInput,
  type WorkImportPlanDto,
  type WorkImportResultDto,
} from '@anvil/shared';

export interface ImportItemState {
  selected: boolean;
  title: string;
  keepDuplicate: boolean;
}

export type ImportState = Record<string, ImportItemState>;

function byIdMap(plan: WorkImportPlanDto): Map<string, WorkImportCandidateDto> {
  return new Map(plan.items.map((item) => [item.itemId, item]));
}

export function setImportTitle(state: ImportState, itemId: string, title: string): ImportState {
  const current = state[itemId];
  if (current === undefined) return state;
  return { ...state, [itemId]: { ...current, title } };
}

export function setImportKeepDuplicate(state: ImportState, itemId: string, keepDuplicate: boolean): ImportState {
  const current = state[itemId];
  if (current === undefined) return state;
  return { ...state, [itemId]: { ...current, keepDuplicate } };
}

export function buildCommitItems(plan: WorkImportPlanDto, state: ImportState): WorkImportCommitItemInput[] {
  return plan.items.map((item) => {
    const current = state[item.itemId];
    return {
      itemId: item.itemId,
      selected: current?.selected === true,
      title: current?.title ?? item.suggestedTitle,
      keepDuplicate: current?.keepDuplicate === true,
    };
  });
}

export function duplicateLabel(item: WorkImportCandidateDto): string | null {
  if (item.duplicate === null) return null;
  if (item.duplicate.kind === 'same-content') return '潜在重复';
  return item.duplicate.state === 'new-version' ? '来源有新版本' : '已导入过 · 自动跳过';
}

export function isAutoSkipDuplicate(item: WorkImportCandidateDto): boolean {
  return item.duplicate?.kind === 'same-source' && item.duplicate.state === 'same';
}

/** 长路径中段省略，保留首尾；tooltip 用完整路径 */
export function middleEllipsis(text: string, max = 56): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/* ------------------------------------------------------------------ */
/* 5a-3：批量导入视图状态                                              */
/* ------------------------------------------------------------------ */

export interface BatchImportSummary {
  objects: number;
  units: number;
  autoSkipped: number;
  issues: string[];
}

export interface BatchImportTreeNode {
  key: string;
  name: string;
  depth: number;
  candidate: WorkImportCandidateDto | null;
  scatter: WorkImportCandidateDto | null;
  children: BatchImportTreeNode[];
}

function conflictKeyOf(item: WorkImportCandidateDto): { sourceRelPath: string; importScope: WorkImportCandidateDto['scope'] } {
  return { sourceRelPath: item.sourceRelPath, importScope: item.scope };
}

function sourceContains(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (parent === '') return child !== '';
  return child.startsWith(`${parent}/`);
}

function batchSelectableOf(plan: WorkImportPlanDto): BatchImportSelectableCandidate[] {
  return plan.items.map((item) => ({
    itemId: item.itemId,
    unitId: item.unitId,
    sourceRelPath: item.sourceRelPath,
    importScope: item.scope,
    suggestedTitle: item.suggestedTitle,
    duplicate: item.duplicate,
    files: item.files,
  }));
}

export function initialBatchImportState(plan: WorkImportPlanDto): ImportState {
  const state: ImportState = {};
  for (const item of plan.items) {
    state[item.itemId] = {
      selected: item.selectedByDefault,
      title: item.suggestedTitle,
      keepDuplicate: false,
    };
  }
  return state;
}

/** 未选中项与已选中项冲突时禁用；已选中项不禁用，方便取消 */
export function batchDisabledMap(plan: WorkImportPlanDto, state: ImportState): Map<string, string> {
  const disabled = new Map<string, string>();
  const selected = plan.items.filter((item) => state[item.itemId]?.selected === true);
  for (const item of plan.items) {
    if (state[item.itemId]?.selected === true) continue;
    const conflict = selected.find((other) => batchCandidatesConflict(conflictKeyOf(item), conflictKeyOf(other)));
    if (conflict === undefined) continue;
    // 祖先整目录仍可点击：点击时 setBatchImportSelected 会清掉后代，换成整棵子树
    if (item.scope === 'subtree' && sourceContains(item.sourceRelPath, conflict.sourceRelPath)) continue;
    disabled.set(
      item.itemId,
      `${conflict.scope === 'subtree' ? '已选整目录' : '已选散题'}「${conflict.sourceRelPath || '（源根）'}」；父子目录不能同时导入`,
    );
  }
  return disabled;
}

export function setBatchImportSelected(
  plan: WorkImportPlanDto,
  state: ImportState,
  itemId: string,
  selected: boolean,
): ImportState {
  const item = plan.items.find((candidate) => candidate.itemId === itemId);
  const current = state[itemId];
  if (item === undefined || current === undefined) return state;
  const next: ImportState = { ...state, [itemId]: { ...current, selected } };
  if (selected) {
    for (const other of plan.items) {
      if (other.itemId === itemId) continue;
      if (state[other.itemId]?.selected !== true) continue;
      if (!batchCandidatesConflict(conflictKeyOf(item), conflictKeyOf(other))) continue;
      next[other.itemId] = { ...state[other.itemId]!, selected: false };
    }
  }
  return next;
}

export function validateBatchImportState(plan: WorkImportPlanDto, state: ImportState): string[] {
  const resolved = resolveBatchImportSelection(batchSelectableOf(plan), buildCommitItems(plan, state));
  return resolved.ok ? [] : resolved.issues;
}

export function batchImportSummary(plan: WorkImportPlanDto, state: ImportState): BatchImportSummary {
  const resolved = resolveBatchImportSelection(batchSelectableOf(plan), buildCommitItems(plan, state));
  if (!resolved.ok) return { objects: 0, units: 0, autoSkipped: 0, issues: resolved.issues };
  const byId = byIdMap(plan);
  let objects = 0;
  let units = 0;
  let autoSkipped = 0;
  for (const unit of resolved.units) {
    const headId = unit.itemIds[0];
    const head = headId === undefined ? undefined : byId.get(headId);
    if (head !== undefined && isAutoSkipDuplicate(head)) {
      autoSkipped += 1;
      continue;
    }
    units += 1;
    objects += 1;
  }
  return { objects, units, autoSkipped, issues: [] };
}

function rootNameOf(sourceRoot: string): string {
  const parts = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '源根';
}

/** 按 sourceRelPath 构建导入预览树；容器节点本身是一个候选，散题作为同节点的另一行 */
export function buildBatchImportTree(plan: WorkImportPlanDto): BatchImportTreeNode[] {
  if (plan.items.length === 0) return [];
  const nodes = new Map<string, BatchImportTreeNode>();
  const ensure = (key: string): BatchImportTreeNode => {
    const existing = nodes.get(key);
    if (existing !== undefined) return existing;
    const depth = key === '' ? 0 : key.split('/').length;
    const slash = key.lastIndexOf('/');
    const node: BatchImportTreeNode = {
      key,
      name: key === '' ? rootNameOf(plan.sourceRoot) : key.slice(slash + 1),
      depth,
      candidate: null,
      scatter: null,
      children: [],
    };
    nodes.set(key, node);
    if (key !== '') ensure(slash < 0 ? '' : key.slice(0, slash)).children.push(node);
    return node;
  };

  for (const item of plan.items) {
    const node = ensure(item.sourceRelPath);
    if (item.scope === 'direct') node.scatter = item;
    else node.candidate = item;
  }
  const root = ensure('');
  const sortNode = (node: BatchImportTreeNode): void => {
    node.children.sort((a, b) => compareSourcePathNatural(a.key, b.key));
    for (const child of node.children) sortNode(child);
  };
  sortNode(root);
  return [root];
}

export function importScopeLabel(item: WorkImportCandidateDto): string {
  if (item.scope === 'direct') return '散题';
  if (item.isContainer) return '容器';
  return '题组';
}

export interface ImportResultSummary {
  /** 实际新建的题组数（与成功单元一一对应） */
  created: number;
  successUnits: number;
  failedUnits: number;
  autoSkipped: number;
  userSkipped: number;
  /** 结果页 / 工坊提示条用：全部成功 ok、部分成功 warn、全部失败 err */
  level: 'ok' | 'warn' | 'err';
  text: string;
}

/** 一次导入的完整结果摘要；成功 / 失败 / 自动跳过 / 未选中 四类都要落进提示 */
export function importResultSummary(result: WorkImportResultDto): ImportResultSummary {
  const created = result.units.reduce((sum, unit) => sum + unit.objects.length, 0);
  const successUnits = result.units.filter((unit) => unit.status === 'success').length;
  const failedUnits = result.units.filter((unit) => unit.status === 'failed').length;
  const autoSkipped = result.skipped.filter((item) => item.kind === 'duplicate').length;
  const userSkipped = result.skipped.filter((item) => item.kind === 'user').length;
  const level: ImportResultSummary['level'] = failedUnits === 0 ? 'ok' : created > 0 ? 'warn' : 'err';
  const head = level === 'ok' ? '导入完成' : level === 'warn' ? '部分成功' : '导入失败';
  return {
    created,
    successUnits,
    failedUnits,
    autoSkipped,
    userSkipped,
    level,
    text: `${head}：成功 ${created} 个题组 · 失败 ${failedUnits} 个单元 · 自动跳过 ${autoSkipped} · 未选中 ${userSkipped}`,
  };
}
