/** 导入视图的纯状态派生（切片 5a-2）：选择合法化、预览树、提交摘要，可单测不碰 DOM */
import {
  batchCandidatesConflict,
  compareSourcePathNatural,
  resolveBatchImportSelection,
  resolveImportSelection,
  type BatchImportSelectableCandidate,
  type ImportSelectableCandidate,
  type WorkImportCandidateDto,
  type WorkImportCommitItemInput,
  type WorkImportPlanDto,
} from '@anvil/shared';

export interface ImportItemState {
  selected: boolean;
  title: string;
  parentItemId: string | null;
  confirmUndecided: boolean;
  keepDuplicate: boolean;
}

export type ImportState = Record<string, ImportItemState>;

export interface ImportPreviewContest {
  contest: WorkImportCandidateDto;
  children: WorkImportCandidateDto[];
}

export interface ImportPreviewModel {
  contests: ImportPreviewContest[];
  loose: WorkImportCandidateDto[];
}

export interface ImportSummary {
  /** 真正会创建的对象数（不含自动跳过） */
  objects: number;
  units: number;
  contests: number;
  problems: number;
  /** 同一来源与内容、提交时自动跳过的对象数 */
  autoSkipped: number;
  issues: string[];
}

function byIdMap(plan: WorkImportPlanDto): Map<string, WorkImportCandidateDto> {
  return new Map(plan.items.map((item) => [item.itemId, item]));
}

export function initialImportState(plan: WorkImportPlanDto): ImportState {
  const state: ImportState = {};
  for (const item of plan.items) {
    state[item.itemId] = {
      selected: item.selectedByDefault,
      title: item.suggestedTitle,
      parentItemId: item.parentItemId,
      confirmUndecided: false,
      keepDuplicate: false,
    };
  }
  // 父比赛默认没勾（低置信 / 重复）时，子题也不能默认挂着被选：否则一打开预览就是非法选择
  for (const item of plan.items) {
    if (item.parentItemId === null) continue;
    if (state[item.parentItemId]?.selected === false) {
      state[item.itemId] = { ...state[item.itemId]!, selected: false };
    }
  }
  return state;
}

export function setImportSelected(plan: WorkImportPlanDto, state: ImportState, itemId: string, selected: boolean): ImportState {
  const item = byIdMap(plan).get(itemId);
  const current = state[itemId];
  if (item === undefined || current === undefined) return state;
  const next: ImportState = { ...state, [itemId]: { ...current, selected } };

  if (selected && item.role === 'undecided') {
    next[itemId] = { ...next[itemId]!, confirmUndecided: true, parentItemId: null };
  }
  if (selected && item.role === 'problem' && item.parentItemId !== null) {
    const parent = state[item.parentItemId];
    if (parent !== undefined && !parent.selected) {
      next[itemId] = { ...next[itemId]!, parentItemId: null };
    }
  }
  if (item.role === 'contest') {
    for (const child of plan.items) {
      if (child.parentItemId !== itemId) continue;
      const childState = state[child.itemId];
      if (childState === undefined || childState.parentItemId !== itemId) continue;
      if (!selected) next[child.itemId] = { ...childState, selected: false };
      else if (child.selectedByDefault) next[child.itemId] = { ...childState, selected: true };
    }
  }
  return next;
}

export function setImportTitle(state: ImportState, itemId: string, title: string): ImportState {
  const current = state[itemId];
  if (current === undefined) return state;
  return { ...state, [itemId]: { ...current, title } };
}

export function setImportParent(state: ImportState, itemId: string, parentItemId: string | null): ImportState {
  const current = state[itemId];
  if (current === undefined) return state;
  return { ...state, [itemId]: { ...current, parentItemId } };
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
      parentItemId: current === undefined ? item.parentItemId : current.parentItemId,
      confirmUndecidedAsProblem: current?.confirmUndecided === true,
      keepDuplicate: current?.keepDuplicate === true,
    };
  });
}

function selectableOf(plan: WorkImportPlanDto): ImportSelectableCandidate[] {
  return plan.items.map((item) => ({
    itemId: item.itemId,
    unitId: item.unitId,
    role: item.role,
    shape: item.shape,
    parentItemId: item.parentItemId,
    suggestedTitle: item.suggestedTitle,
    duplicate: item.duplicate,
    files: item.files,
  }));
}

export function validateImportState(plan: WorkImportPlanDto, state: ImportState): string[] {
  const resolved = resolveImportSelection(selectableOf(plan), buildCommitItems(plan, state));
  return resolved.ok ? [] : resolved.issues;
}

export function importSummary(plan: WorkImportPlanDto, state: ImportState): ImportSummary {
  const resolved = resolveImportSelection(selectableOf(plan), buildCommitItems(plan, state));
  if (!resolved.ok) {
    return { objects: 0, units: 0, contests: 0, problems: 0, autoSkipped: 0, issues: resolved.issues };
  }
  const byId = byIdMap(plan);
  let objects = 0;
  let units = 0;
  let contests = 0;
  let autoSkipped = 0;
  for (const unit of resolved.units) {
    const headId = unit.itemIds[0];
    const head = headId === undefined ? undefined : byId.get(headId);
    const exact = head?.duplicate?.kind === 'same-source' && head.duplicate.state === 'same';
    if (exact) {
      autoSkipped += unit.itemIds.length;
      continue;
    }
    units += 1;
    objects += unit.itemIds.length;
    if (head?.role === 'contest') contests += 1;
  }
  return {
    objects,
    units,
    contests,
    problems: objects - contests,
    autoSkipped,
    issues: [],
  };
}

export function buildImportPreview(plan: WorkImportPlanDto): ImportPreviewModel {
  const models = new Map<string, ImportPreviewContest>();
  const loose: WorkImportCandidateDto[] = [];
  for (const item of plan.items) {
    if (item.role === 'contest') {
      models.set(item.itemId, { contest: item, children: [] });
    }
  }
  for (const item of plan.items) {
    if (item.role === 'contest') continue;
    const parent = item.parentItemId === null ? undefined : models.get(item.parentItemId);
    if (parent === undefined) loose.push(item);
    else parent.children.push(item);
  }
  return { contests: [...models.values()], loose };
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
      parentItemId: null,
      confirmUndecided: false,
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
