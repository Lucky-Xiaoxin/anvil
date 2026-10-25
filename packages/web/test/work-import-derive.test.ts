import { describe, expect, it } from 'vitest';
import type { WorkImportCandidateDto, WorkImportPlanDto, WorkImportResultDto } from '@anvil/shared';
import { WORK_SECTION } from '../src/components/work/derive.ts';
import {
  batchDisabledMap,
  batchImportSummary,
  buildBatchImportTree,
  buildCommitItems,
  duplicateLabel,
  importResultSummary,
  importScopeLabel,
  initialBatchImportState,
  isAutoSkipDuplicate,
  middleEllipsis,
  setBatchImportSelected,
  setImportKeepDuplicate,
  setImportTitle,
  validateBatchImportState,
} from '../src/components/work/import-derive.ts';

const candidate = (patch: Partial<WorkImportCandidateDto>): WorkImportCandidateDto => ({
  itemId: 'item_1',
  unitId: 'item_1',
  sourceRelPath: 'x',
  shape: 'contest-group',
  role: 'contest',
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

describe('列表用语（26 §6.1：kind 分区）', () => {
  it('比赛 / 题组 / 旧题目对象 / 题目徽章', () => {
    expect(WORK_SECTION.contests).toBe('比赛');
    expect(WORK_SECTION.problemSets).toBe('题组');
    expect(WORK_SECTION.ungrouped).toBe('旧题目对象');
    expect(WORK_SECTION.problemBadge).toBe('题目');
    expect(WORK_SECTION.linkMissing).toBe('关联比赛不可用');
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

  it('已选后代时祖先整目录仍可点击；点击后接管并取消后代', () => {
    const plan = planOf([container, leafA, leafB, scatter]);
    let state = initialBatchImportState(plan);
    expect(state.item_2?.selected).toBe(true);
    expect(state.item_3?.selected).toBe(true);

    // 祖先不是禁用项：点击即可从「选叶子」切换为「整目录」
    expect(batchDisabledMap(plan, state).has('item_1')).toBe(false);
    state = setBatchImportSelected(plan, state, 'item_1', true);
    expect(state.item_1?.selected).toBe(true);
    expect(state.item_2?.selected).toBe(false);
    expect(state.item_3?.selected).toBe(false);
    expect(validateBatchImportState(plan, state)).toEqual([]);
    // 切换后后代才被禁用，避免父子同选
    expect(batchDisabledMap(plan, state).has('item_2')).toBe(true);
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

  it('只有深层候选时补出中间目录节点，保证树能挂住', () => {
    const deep = candidate({
      itemId: 'item_9',
      unitId: 'unit_9',
      sourceRelPath: 'a/b/c',
      sourceParentRelPath: 'a/b',
      suggestedTitle: 'c',
      selectedByDefault: true,
    });
    const tree = buildBatchImportTree(planOf([deep]));
    const root = tree[0]!;
    expect(root.candidate).toBeNull();
    expect(root.children[0]!.key).toBe('a');
    expect(root.children[0]!.candidate).toBeNull();
    const b = root.children[0]!.children[0]!;
    expect(b.key).toBe('a/b');
    expect(b.children[0]!.key).toBe('a/b/c');
    expect(b.children[0]!.candidate?.itemId).toBe('item_9');
  });

  it('候选类型文字：容器 / 题组 / 散题', () => {
    expect(importScopeLabel(container)).toBe('容器');
    expect(importScopeLabel(leafA)).toBe('题组');
    expect(importScopeLabel(scatter)).toBe('散题');
  });

  it('标题 / 仍导入副本可独立编辑，提交项只带当前批量字段', () => {
    const plan = planOf([leafA]);
    let state = initialBatchImportState(plan);
    state = setImportTitle(state, 'item_2', 'A renamed');
    state = setImportKeepDuplicate(state, 'item_2', true);
    const items = buildCommitItems(plan, state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemId: 'item_2',
      selected: true,
      title: 'A renamed',
      keepDuplicate: true,
    });
  });

  it('同一来源已导入项：自动跳过，摘要单独计数', () => {
    const exact = candidate({
      itemId: 'item_9',
      unitId: 'unit_9',
      sourceRelPath: 'old',
      suggestedTitle: 'old',
      duplicate: { kind: 'same-source', state: 'same', objectId: 'obj_0000000001', targetRelPath: 'practice/2026-10/old' },
      selectedByDefault: true,
    });
    const plan = planOf([exact]);
    expect(isAutoSkipDuplicate(exact)).toBe(true);
    expect(duplicateLabel(exact)).toBe('已导入过 · 自动跳过');
    expect(batchImportSummary(plan, initialBatchImportState(plan))).toMatchObject({ objects: 0, units: 0, autoSkipped: 1 });
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

describe('导入结果摘要（5a-3 修复 P2）', () => {
  const result = (units: WorkImportResultDto['units']): WorkImportResultDto => ({
    batchId: 'imp_0123456789',
    manifestRelPath: '.anvil/imports/batch.json',
    units,
    skipped: [
      { itemId: 'item_7', reason: '同一来源与内容已经导入过，自动跳过', kind: 'duplicate' },
      { itemId: 'item_8', reason: '未选中', kind: 'user' },
    ],
  });
  const success = (n: number): WorkImportResultDto['units'][number] => ({
    unitId: `unit_${n}`,
    status: 'success',
    objects: [{ itemId: `item_${n}`, objectId: `obj_${n}`, relPath: `practice/2026-10/${n}` }],
    itemIds: [`item_${n}`],
  });
  const failed = (n: number): WorkImportResultDto['units'][number] => ({
    unitId: `unit_${n}`,
    status: 'failed',
    objects: [],
    itemIds: [`item_${n}`],
    error: { kind: 'import-source-changed', message: '源内容变了' },
  });

  it('全部成功：ok，成功 / 失败 / 自动跳过 / 未选中四类都在提示里', () => {
    const summary = importResultSummary(result([success(1), success(2)]));
    expect(summary).toMatchObject({ created: 2, successUnits: 2, failedUnits: 0, autoSkipped: 1, userSkipped: 1, level: 'ok' });
    expect(summary.text).toContain('成功 2 个题组');
    expect(summary.text).toContain('失败 0 个单元');
    expect(summary.text).toContain('自动跳过 1');
    expect(summary.text).toContain('未选中 1');
  });

  it('部分成功：warn；全部失败：err', () => {
    expect(importResultSummary(result([success(1), failed(2)]))).toMatchObject({ created: 1, failedUnits: 1, level: 'warn' });
    expect(importResultSummary(result([success(1), failed(2)])).text.startsWith('部分成功')).toBe(true);
    expect(importResultSummary(result([failed(1), failed(2)]))).toMatchObject({ created: 0, failedUnits: 2, level: 'err' });
    expect(importResultSummary(result([failed(1)])).text.startsWith('导入失败')).toBe(true);
  });
});
