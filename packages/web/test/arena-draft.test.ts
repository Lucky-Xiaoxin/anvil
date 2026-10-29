import { describe, expect, it } from 'vitest';
import type { ArenaRecord, ArenaRecordResult } from '@anvil/shared';
import {
  applySaveSuccess,
  canSaveDraft,
  declareFinished,
  draftFromLegacyLive,
  draftFromRecord,
  draftKey,
  draftSummary,
  finishDraft,
  isDirty,
  loadDraft,
  migrateLegacy,
  newDraft,
  newManualDraft,
  parseDraft,
  replaceCaseOf,
  saveDraft,
  updateReconciled,
} from '../src/components/arena/draft.ts';
import { ghostKey, sessionKey, type Store } from '../src/components/arena/session.ts';

const PATH = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';
const DURATION = 5 * 3_600_000;
const NOW = Date.parse('2026-10-29T12:00:00Z');
const REC_ID = `rec_${'a'.repeat(32)}`;

function memoryStore(failWrites = false): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceeded');
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Store & { map: Map<string, string> };
}

const timed: ArenaRecordResult = { origin: 'timed', finish: 'time-limit', durationMs: DURATION, stoppedAtMs: DURATION };
const ghost = { show: true, subs: [{ p: 0, t: 30, r: 'AC' as const }] };

const record: ArenaRecord = {
  schema: 2,
  recordId: REC_ID,
  contestId: 'obj_7f3a2c9b1d',
  arenaPath: PATH,
  name: '第一次 VP',
  createdAt: '2026-10-29T12:00:00.000Z',
  updatedAt: '2026-10-29T12:00:00.000Z',
  result: timed,
  ghost,
};

describe('草稿状态与结束（契约 §3.2 / §4.3）', () => {
  it('新草稿 running；到时写满时长，提前结束保留真实停止位置', () => {
    const d = newDraft(NOW);
    expect(d.phase).toBe('running');
    expect(d.session?.started).toBe(NOW);
    const full = finishDraft(d, DURATION, DURATION, NOW + DURATION);
    expect(full.result).toEqual({ origin: 'timed', finish: 'time-limit', durationMs: DURATION, stoppedAtMs: DURATION });
    expect(full.session?.hold).toBe(true);
    expect(full.session?.ended).toBe(true);

    const early = finishDraft(d, DURATION, 90 * 60_000, NOW + 1);
    expect(early.result).toEqual({
      origin: 'timed',
      finish: 'stopped',
      durationMs: DURATION,
      stoppedAtMs: 90 * 60_000,
    });
  });

  it('只有逐发 / 旧 review 确认结束后转 manual + declared，不伪造停止位置', () => {
    const d = { ...newDraft(NOW), phase: 'legacy-unconfirmed' as const, session: null, ghost };
    const done = declareFinished(d, DURATION);
    expect(done.result).toEqual({ origin: 'manual', finish: 'declared', durationMs: DURATION, stoppedAtMs: null });
    expect(done.session).toBeNull();
    expect(canSaveDraft(done)).toBe(true);
    expect(canSaveDraft(d)).toBe(false);
  });

  it('补录草稿直接是 manual + declared；旧 live 恢复成暂停的 running', () => {
    const manual = newManualDraft(DURATION, ghost);
    expect(manual.result).toEqual({ origin: 'manual', finish: 'declared', durationMs: DURATION, stoppedAtMs: null });
    const live = draftFromLegacyLive(ghost, 72_000, DURATION, NOW);
    expect(live.phase).toBe('running');
    expect(live.session).toMatchObject({ hold: true, paused: true, at: 72_000, scrubMs: 72_000, started: NOW - 72_000 });
  });
});

const finishedDraft = () => ({ ...finishDraft(newDraft(NOW), DURATION, DURATION, NOW), ghost });
const savedDraft = () => applySaveSuccess(finishedDraft(), record, 'rev1');

describe('dirty 与替换判断（契约 §3.3 / §3.4）', () => {
  it('显示开关与回顾游标不参与 dirty；成绩或结束信息变化才算', () => {
    const d = savedDraft();
    expect(isDirty(d)).toBe(false);
    expect(isDirty({ ...d, ghost: { ...d.ghost, show: false } })).toBe(false);
    expect(isDirty({ ...d, ghost: { ...d.ghost, subs: [...d.ghost.subs, { p: 1, t: 40, r: 'WA' }] } })).toBe(true);
    expect(isDirty({ ...d, result: { ...timed, stoppedAtMs: 1000, finish: 'stopped' } })).toBe(true);
    expect(isDirty({ ...d, savedBaseline: null })).toBe(true);
  });

  it('替换提示：无草稿 / 干净直接切；进行中 / 未保存 / 旧数据各有动作', () => {
    expect(replaceCaseOf(null)).toBe('none');
    expect(replaceCaseOf(savedDraft())).toBe('none');
    expect(replaceCaseOf(newDraft(NOW))).toBe('running');
    expect(replaceCaseOf({ ...newDraft(NOW), phase: 'legacy-unconfirmed', session: null, ghost })).toBe('legacy');
    expect(replaceCaseOf(finishedDraft())).toBe('unsaved');
  });

  it('摘要区分进行中 / 已结束未保存 / 已保存', () => {
    expect(draftSummary(null)).toBe('没有当前草稿');
    expect(draftSummary(newDraft(NOW))).toBe('当前练习进行中');
    expect(draftSummary(finishedDraft())).toBe('已结束 · 未保存');
    expect(draftSummary(savedDraft())).toBe('已结束 · 已保存');
  });
});

describe('保存成功与响应丢失对账', () => {
  it('保存成功后目标 / 版本更新、pending 清空、草稿保留', () => {
    const d = {
      ...finishDraft(newDraft(NOW), DURATION, DURATION, NOW),
      ghost,
      pendingSave: { recordId: REC_ID, payload: { arenaPath: PATH, recordId: REC_ID, name: 'A', result: timed, ghost } },
    };
    const saved = applySaveSuccess(d, record, 'rev1');
    expect(saved.target).toEqual({ recordId: REC_ID, revision: 'rev1', name: '第一次 VP' });
    expect(saved.pendingSave).toBeNull();
    expect(saved.savedBaseline).toEqual({ result: timed, subs: ghost.subs });
    expect(saved.phase).toBe('finished');
  });

  it('更新响应丢失：读回内容一致即对账成功，不同则走冲突', () => {
    const d = { ...savedDraft(), ghost: { ...ghost, show: false } };
    expect(updateReconciled(d, { ...record, ghost: { ...ghost, show: false } })).toBe(true);
    expect(updateReconciled(d, record)).toBe(false);
    expect(updateReconciled({ ...d, result: { ...timed, stoppedAtMs: 1, finish: 'stopped' } }, record)).toBe(false);
  });
});

describe('旧 localStorage 迁移（契约 §7.2）', () => {
  it('未结束 session → running；成功后删旧键', () => {
    const s = memoryStore();
    s.setItem(
      sessionKey(PATH),
      JSON.stringify({ started: 1000, hold: false, paused: false, ended: false, scrubMs: 0, at: 0, durationMs: DURATION }),
    );
    s.setItem(ghostKey(PATH), JSON.stringify(ghost));
    const out = migrateLegacy(s, PATH, DURATION);
    expect(out.kind).toBe('migrated');
    if (out.kind === 'migrated') {
      expect(out.draft.phase).toBe('running');
      expect(out.draft.session?.started).toBe(1000);
      expect(out.draft.ghost.subs).toEqual(ghost.subs);
    }
    expect(s.getItem(sessionKey(PATH))).toBeNull();
    expect(s.getItem(ghostKey(PATH))).toBeNull();
    expect(s.getItem(draftKey(PATH))).not.toBeNull();
    expect(loadDraft(s, PATH).kind).toBe('draft');
  });

  it('ended session → finished，按到时完赛（旧版没有早停记录）', () => {
    const s = memoryStore();
    s.setItem(
      sessionKey(PATH),
      JSON.stringify({ started: 1000, hold: true, paused: false, ended: true, scrubMs: 0, at: DURATION, durationMs: 0 }),
    );
    const out = migrateLegacy(s, PATH, DURATION);
    expect(out.kind).toBe('migrated');
    if (out.kind === 'migrated') {
      expect(out.draft.phase).toBe('finished');
      expect(out.draft.result).toEqual({ origin: 'timed', finish: 'time-limit', durationMs: DURATION, stoppedAtMs: DURATION });
    }
    expect(s.getItem(sessionKey(PATH))).toBeNull();
  });

  it('只有逐发 → legacy-unconfirmed；旧聚合 ghost 不迁；无数据 → none', () => {
    const s = memoryStore();
    s.setItem(ghostKey(PATH), JSON.stringify(ghost));
    const out = migrateLegacy(s, PATH, DURATION);
    expect(out.kind).toBe('migrated');
    if (out.kind === 'migrated') expect(out.draft.phase).toBe('legacy-unconfirmed');
    expect(s.getItem(ghostKey(PATH))).toBeNull();

    const old = memoryStore();
    old.setItem(ghostKey(PATH), '{"show":true,"marks":[{"p":0,"ac":113}]}');
    expect(migrateLegacy(old, PATH, DURATION).kind).toBe('none');

    expect(migrateLegacy(memoryStore(), PATH, DURATION).kind).toBe('none');
  });

  it('写新键失败：保留旧键并报错，不假装迁移成功', () => {
    const s = memoryStore(true);
    s.map.set(ghostKey(PATH), JSON.stringify(ghost));
    const out = migrateLegacy(s, PATH, DURATION);
    expect(out.kind).toBe('error');
    expect(s.getItem(ghostKey(PATH))).not.toBeNull();
    expect(s.getItem(draftKey(PATH))).toBeNull();
  });

  it('新键存在时以新键为准：坏数据只报错，旧键不被迁入也不被清理', () => {
    const s = memoryStore();
    s.setItem(draftKey(PATH), '{ 半截');
    s.setItem(ghostKey(PATH), JSON.stringify(ghost));
    const load = loadDraft(s, PATH);
    expect(load.kind).toBe('error');
    expect(migrateLegacy(s, PATH, DURATION).kind).toBe('none');
    expect(s.getItem(ghostKey(PATH))).not.toBeNull();
  });
});

describe('编辑历史档', () => {
  it('普通档载入后干净；旧 review 确认结束（manual）后视为有修改，保存才升级', () => {
    const d = draftFromRecord(record, record.result, 'rev1');
    expect(isDirty(d)).toBe(false);
    expect(d.target).toEqual({ recordId: REC_ID, revision: 'rev1', name: '第一次 VP' });

    const legacy: ArenaRecord = {
      ...record,
      recordId: 'legacy',
      result: { origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null },
      name: '旧存档 2026-10-20 14:32',
    };
    const edited = draftFromRecord(
      legacy,
      { origin: 'manual', finish: 'declared', durationMs: DURATION, stoppedAtMs: null },
      'revL',
      legacy.result,
    );
    expect(isDirty(edited)).toBe(true);
    expect(edited.phase).toBe('finished');
  });
});

describe('草稿存取与校验', () => {
  it('保存 / 读取往返；失败返回 false；坏形状整份报错', () => {
    const s = memoryStore();
    const d = newDraft(NOW);
    expect(saveDraft(s, PATH, d)).toBe(true);
    const load = loadDraft(s, PATH);
    expect(load.kind).toBe('draft');
    if (load.kind === 'draft') expect(load.draft.draftId).toBe(d.draftId);

    const bad = { ...d, phase: 'finished', result: null };
    expect(parseDraft(bad)).toBeNull();
    expect(parseDraft({ ...d, ghost: { show: true, subs: [{ p: 0, t: 'x', r: 'AC' }] } })).toBeNull();
    expect(parseDraft({ ...d, draftId: '' })).toBeNull();

    expect(saveDraft(memoryStore(true), PATH, d)).toBe(false);
  });
});
