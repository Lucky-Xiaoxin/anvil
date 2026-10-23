import { describe, expect, it } from 'vitest';
import type { WorkImportCandidateDto, WorkImportPlanDto } from '@anvil/shared';
import { WORK_SECTION } from '../src/components/work/derive.ts';
import {
  batchDisabledMap,
  batchImportSummary,
  buildBatchImportTree,
  buildCommitItems,
  buildImportPreview,
  duplicateLabel,
  importScopeLabel,
  importSummary,
  initialBatchImportState,
  initialImportState,
  isAutoSkipDuplicate,
  middleEllipsis,
  setBatchImportSelected,
  setImportKeepDuplicate,
  setImportParent,
  setImportSelected,
  setImportTitle,
  validateBatchImportState,
  validateImportState,
} from '../src/components/work/import-derive.ts';

const candidate = (patch: Partial<WorkImportCandidateDto>): WorkImportCandidateDto => ({
  itemId: 'item_1',
  unitId: 'item_1',
  sourceRelPath: 'x',
  shape: 'problem-dir',
  role: 'problem',
  parentItemId: null,
  confidence: 'high',
  suggestedTitle: 'X',
  reasons: ['识别理由'],
  files: 1,
  bytes: 10,
  filePreview: ['solution.cpp'],
  filesTruncated: false,
  fingerprint: 'f'.repeat(64),
  duplicate: null,
  selectedByDefault: true,
  ...patch,
  sourceParentRelPath: patch.sourceParentRelPath ?? null,
  scope: patch.scope ?? 'subtree',
  isContainer: patch.isContainer ?? false,
  sourceCount: patch.sourceCount ?? 1,
});

function planOf(items: WorkImportCandidateDto[]): WorkImportPlanDto {
  return {
    planId: 'plan_1',
    sourceRoot: 'D:/old-code',
    expiresAt: '2026-10-22T12:30:00.000Z',
    totals: { files: 4, bytes: 40, candidates: items.length, ignored: 0 },
    items,
    warnings: [],
  };
}

const contest = candidate({
  itemId: 'item_1',
  unitId: 'unit_1',
  sourceRelPath: 'contestA',
  shape: 'contest-group',
  role: 'contest',
  suggestedTitle: 'contestA',
  files: 1,
});
const a = candidate({
  itemId: 'item_2',
  unitId: 'unit_1',
  sourceRelPath: 'contestA/A.cpp',
  shape: 'problem-file',
  parentItemId: 'item_1',
  suggestedTitle: 'A',
});
const b = candidate({
  itemId: 'item_3',
  unitId: 'unit_1',
  sourceRelPath: 'contestA/B',
  shape: 'problem-dir',
  parentItemId: 'item_1',
  suggestedTitle: 'B',
});
const loose = candidate({ itemId: 'item_4', unitId: 'item_4', sourceRelPath: 'alpha', suggestedTitle: 'alpha' });
const misc = candidate({
  itemId: 'item_5',
  unitId: 'item_5',
  sourceRelPath: 'misc',
  shape: 'undecided',
  role: 'undecided',
  suggestedTitle: 'misc',
  selectedByDefault: false,
});

describe('列表用语（契约 §2.3 / §12.3）', () => {
  it('题组 / 比赛题组 / 未分组题目 / 题目徽章', () => {
    expect(WORK_SECTION.groups).toBe('比赛');
    expect(WORK_SECTION.contestBadge).toBe('题组');
    expect(WORK_SECTION.ungrouped).toBe('旧题目对象');
    expect(WORK_SECTION.problemBadge).toBe('题目');
  });
});

describe('导入选择状态（契约 §5.6 / §12.2）', () => {
  it('初始勾选遵循 selectedByDefault；低置信未判定默认不选', () => {
    const plan = planOf([contest, a, b, loose, misc]);
    const state = initialImportState(plan);
    expect(state.item_1?.selected).toBe(true);
    expect(state.item_2?.selected).toBe(true);
    expect(state.item_4?.selected).toBe(true);
    expect(state.item_5?.selected).toBe(false);
    expect(state.item_1?.title).toBe('contestA');
    expect(state.item_2?.parentItemId).toBe('item_1');
  });

  it('父比赛默认未勾（低置信 / 重复）时，子题也不默认勾；重新勾比赛会带回默认子题', () => {
    const dupContest = candidate({ ...contest, duplicate: { kind: 'same-content' }, selectedByDefault: false });
    const plan = planOf([dupContest, a, b]);
    let state = initialImportState(plan);
    expect(state.item_1?.selected).toBe(false);
    expect(state.item_2?.selected).toBe(false);
    expect(state.item_3?.selected).toBe(false);

    state = setImportSelected(plan, state, 'item_1', true);
    expect(state.item_1?.selected).toBe(true);
    expect(state.item_2?.selected).toBe(true);
    expect(state.item_3?.selected).toBe(true);
  });

  it('取消比赛时取消仍挂在它下面的子题；已拆出的子题保持选择', () => {
    const plan = planOf([contest, a, b]);
    let state = initialImportState(plan);
    state = setImportParent(state, 'item_3', null);
    state = setImportSelected(plan, state, 'item_1', false);
    expect(state.item_1?.selected).toBe(false);
    expect(state.item_2?.selected).toBe(false);
    expect(state.item_3?.selected).toBe(true);
    expect(state.item_3?.parentItemId).toBeNull();
  });

  it('父比赛未选时勾选子题会自动拆成未分组题目；未判定勾选即确认', () => {
    const plan = planOf([contest, a, misc]);
    let state = initialImportState(plan);
    state = setImportSelected(plan, state, 'item_1', false);
    state = setImportSelected(plan, state, 'item_2', true);
    expect(state.item_2?.parentItemId).toBeNull();
    expect(state.item_2?.selected).toBe(true);

    state = setImportSelected(plan, state, 'item_5', true);
    expect(state.item_5?.confirmUndecided).toBe(true);
    expect(state.item_5?.selected).toBe(true);
  });

  it('标题 / 仍导入副本可独立编辑；buildCommitItems 保留显式 null 父关系', () => {
    const plan = planOf([contest, a]);
    let state = initialImportState(plan);
    state = setImportTitle(state, 'item_2', 'A renamed');
    state = setImportParent(state, 'item_2', null);
    state = setImportKeepDuplicate(state, 'item_2', true);
    const items = buildCommitItems(plan, state);
    const child = items.find((item) => item.itemId === 'item_2')!;
    expect(child.title).toBe('A renamed');
    expect(child.parentItemId).toBeNull();
    expect(child.keepDuplicate).toBe(true);
  });
});

describe('单目录题组计划（新语义）', () => {
  it('一个 contest 候选、无子题：预览一张组头，摘要计题组 1', () => {
    const group = candidate({
      itemId: 'item_1',
      unitId: 'unit_1',
      sourceRelPath: '',
      shape: 'contest-group',
      role: 'contest',
      suggestedTitle: 'old-code',
      files: 5,
      bytes: 50,
      filePreview: ['A.cpp', 'B.cpp', 'README.md', 'data/test.in'],
      filesTruncated: false,
    });
    const plan = planOf([group]);
    const state = initialImportState(plan);
    expect(state.item_1?.selected).toBe(true);
    expect(validateImportState(plan, state)).toEqual([]);
    expect(importSummary(plan, state)).toMatchObject({ objects: 1, units: 1, contests: 1, problems: 0 });
    const model = buildImportPreview(plan);
    expect(model.contests).toHaveLength(1);
    expect(model.contests[0]!.children).toEqual([]);
    expect(model.loose).toEqual([]);
    const items = buildCommitItems(plan, state);
    expect(items).toHaveLength(1);
    expect(items[0]!.parentItemId).toBeNull();
  });
});

describe('5a-3 批量导入视图', () => {
  const container = candidate({
    itemId: 'item_1',
    unitId: 'unit_1',
    sourceRelPath: '2026',
    scope: 'subtree',
    isContainer: true,
    suggestedTitle: '2026',
    files: 9,
    sourceCount: 3,
    selectedByDefault: false,
  });
  const leafA = candidate({
    itemId: 'item_2',
    unitId: 'unit_2',
    sourceRelPath: '2026/10/A',
    sourceParentRelPath: '2026/10',
    suggestedTitle: 'A',
    selectedByDefault: true,
  });
  const leafB = candidate({
    itemId: 'item_3',
    unitId: 'unit_3',
    sourceRelPath: '2026/7/B',
    sourceParentRelPath: '2026/7',
    suggestedTitle: 'B',
    selectedByDefault: true,
  });
  const scatter = candidate({
    itemId: 'item_4',
    unitId: 'unit_4',
    sourceRelPath: '2026/10',
    sourceParentRelPath: '2026',
    scope: 'direct',
    suggestedTitle: '10 散题',
    files: 2,
    selectedByDefault: false,
  });

  it('默认勾选叶子；勾容器会清掉后代并禁用；散题与容器互斥', () => {
    const plan = planOf([container, leafA, leafB, scatter]);
    let state = initialBatchImportState(plan);
    expect(state.item_2?.selected).toBe(true);
    expect(state.item_3?.selected).toBe(true);
    expect(validateBatchImportState(plan, state)).toEqual([]);
    expect(batchImportSummary(plan, state)).toMatchObject({ objects: 2, units: 2, autoSkipped: 0 });

    state = setBatchImportSelected(plan, state, 'item_1', true);
    expect(state.item_1?.selected).toBe(true);
    expect(state.item_2?.selected).toBe(false);
    expect(state.item_3?.selected).toBe(false);
    expect(batchDisabledMap(plan, state).has('item_2')).toBe(true);

    state = setBatchImportSelected(plan, state, 'item_4', true);
    expect(state.item_1?.selected).toBe(false);
    expect(state.item_4?.selected).toBe(true);
    expect(validateBatchImportState(plan, state)).toEqual([]);
  });

  it('手动制造父子同选时校验给出问题', () => {
    const plan = planOf([container, leafA]);
    const state = initialBatchImportState(plan);
    const both = { ...state, item_1: { ...state.item_1!, selected: true }, item_2: { ...state.item_2!, selected: true } };
    expect(validateBatchImportState(plan, both).some((issue) => issue.includes('父子目录'))).toBe(true);
  });

  it('预览树按 sourceRelPath 嵌套，散题挂在同目录节点；名字取源根末段', () => {
    const plan = planOf([container, leafA, leafB, scatter]);
    const tree = buildBatchImportTree(plan);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('old-code');
    expect(tree[0]!.candidate).toBeNull();
    const year = tree[0]!.children[0]!;
    expect(year.key).toBe('2026');
    expect(year.candidate?.itemId).toBe('item_1');
    expect(year.children.map((node) => node.key)).toEqual(['2026/7', '2026/10']);
    const october = year.children[1]!;
    expect(october.scatter?.itemId).toBe('item_4');
    expect(october.children[0]!.candidate?.itemId).toBe('item_2');
  });

  it('候选类型文字：容器 / 题组 / 散题', () => {
    expect(importScopeLabel(container)).toBe('容器');
    expect(importScopeLabel(leafA)).toBe('题组');
    expect(importScopeLabel(scatter)).toBe('散题');
  });
});

describe('预览 / 摘要 / 校验', () => {
  it('预览树按比赛题组分组，其余进未分组题目', () => {
    const model = buildImportPreview(planOf([contest, a, b, loose, misc]));
    expect(model.contests).toHaveLength(1);
    expect(model.contests[0]!.contest.itemId).toBe('item_1');
    expect(model.contests[0]!.children.map((item) => item.itemId)).toEqual(['item_2', 'item_3']);
    expect(model.loose.map((item) => item.itemId)).toEqual(['item_4', 'item_5']);
  });

  it('摘要按原子单元计数：比赛与子题算一个单元，拆出的子题各自成单元', () => {
    const plan = planOf([contest, a, b, loose]);
    let state = initialImportState(plan);
    expect(importSummary(plan, state)).toMatchObject({ objects: 4, units: 2, contests: 1, problems: 3, issues: [] });
    state = setImportParent(state, 'item_3', null);
    expect(importSummary(plan, state)).toMatchObject({ objects: 4, units: 3, contests: 1, problems: 3 });
  });

  it('默认状态合法；父比赛未选、空题组、潜在重复未确认都给出问题', () => {
    const plan = planOf([contest, a, b, loose]);
    expect(validateImportState(plan, initialImportState(plan))).toEqual([]);

    let state = initialImportState(plan);
    state = { ...state, item_1: { ...state.item_1!, selected: false } };
    const issues = validateImportState(plan, state);
    expect(issues.some((issue) => issue.includes('父比赛未选中'))).toBe(true);

    const emptyContest = candidate({
      itemId: 'item_9',
      unitId: 'unit_9',
      sourceRelPath: 'empty',
      shape: 'contest-group',
      role: 'contest',
      suggestedTitle: 'empty',
      files: 0,
    } as Partial<WorkImportCandidateDto>);
    const emptyPlan = planOf([emptyContest]);
    const emptyState = initialImportState(emptyPlan);
    expect(validateImportState(emptyPlan, emptyState).some((issue) => issue.includes('空题组'))).toBe(true);

    const dup = candidate({
      itemId: 'item_8',
      unitId: 'item_8',
      sourceRelPath: 'dup',
      duplicate: { kind: 'same-content' },
      selectedByDefault: false,
    });
    const dupPlan = planOf([dup]);
    let dupState = initialImportState(dupPlan);
    dupState = setImportSelected(dupPlan, dupState, 'item_8', true);
    expect(validateImportState(dupPlan, dupState).some((issue) => issue.includes('潜在重复'))).toBe(true);
    dupState = setImportKeepDuplicate(dupState, 'item_8', true);
    expect(validateImportState(dupPlan, dupState)).toEqual([]);
  });

  it('同一来源已导入项：默认勾选、自动跳过，摘要单独计数', () => {
    const exactContest = candidate({
      ...contest,
      duplicate: { kind: 'same-source', state: 'same', objectId: 'obj_0000000001', targetRelPath: 'contests/x' },
    });
    const plan = planOf([exactContest, a, b]);
    const state = initialImportState(plan);
    expect(isAutoSkipDuplicate(exactContest)).toBe(true);
    expect(duplicateLabel(exactContest)).toBe('已导入过 · 自动跳过');
    expect(state.item_1?.selected).toBe(true);
    expect(importSummary(plan, state)).toMatchObject({ objects: 0, units: 0, autoSkipped: 3 });
  });

  it('重复标签区分潜在重复与来源新版本', () => {
    expect(duplicateLabel(candidate({ duplicate: { kind: 'same-content' } }))).toBe('潜在重复');
    expect(duplicateLabel(candidate({ duplicate: { kind: 'same-source', state: 'new-version' } }))).toBe('来源有新版本');
    expect(duplicateLabel(candidate({ duplicate: null }))).toBeNull();
  });

  it('长路径中段省略保留首尾', () => {
    expect(middleEllipsis('short', 20)).toBe('short');
    const long = 'contestA/very/long/path/that/keeps/going/solution.cpp';
    const cut = middleEllipsis(long, 24);
    expect(cut.length).toBeLessThanOrEqual(24);
    expect(cut).toContain('…');
    expect(cut.startsWith('conte')).toBe(true);
    expect(cut.endsWith('.cpp')).toBe(true);
  });
});
