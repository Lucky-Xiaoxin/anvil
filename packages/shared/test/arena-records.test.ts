import { describe, expect, it } from 'vitest';
import {
  arenaGhostEquals,
  arenaRecordAddressOk,
  arenaRecordContentEquals,
  arenaRecordIdOk,
  arenaResultLabel,
  arenaStampOf,
  arenaTrashIdOk,
  copyArenaRecordName,
  defaultArenaRecordName,
  legacyArenaRecordName,
  normalizeArenaRecordName,
  parseArenaRecordFile,
  parseArenaRecordResult,
  projectLegacyReview,
  summaryOfArenaRecord,
  type ArenaRecord,
  type ArenaRecordResult,
} from '@anvil/shared';

const ID = `rec_${'a'.repeat(32)}`;
const TRASH = `tr_${'b'.repeat(32)}`;

const timed: ArenaRecordResult = { origin: 'timed', finish: 'stopped', durationMs: 4 * 3600_000, stoppedAtMs: 90 * 60_000 };
const ghost = { show: true, subs: [{ p: 1, t: 45, r: 'AC' as const }, { p: 0, t: 20, r: 'WA' as const }] };

const file = (patch: Record<string, unknown> = {}) => ({
  schema: 2,
  recordId: ID,
  contestId: 'obj_7f3a2c9b1d',
  arenaPath: 'official/icpc/icpc2025/icpc2025shanghai.srk.json',
  name: '第一次 VP',
  createdAt: '2026-10-29T12:00:00.000Z',
  updatedAt: '2026-10-29T12:30:00.000Z',
  result: timed,
  ghost,
  ...patch,
});

describe('ID 形状（契约 §5.2）', () => {
  it('新档只认 rec_ + 32 位小写十六进制；寻址额外接受 legacy', () => {
    expect(arenaRecordIdOk(ID)).toBe(true);
    expect(arenaRecordIdOk('legacy')).toBe(false);
    expect(arenaRecordIdOk(`rec_${'A'.repeat(32)}`)).toBe(false);
    expect(arenaRecordIdOk(`rec_${'a'.repeat(31)}`)).toBe(false);
    expect(arenaRecordAddressOk('legacy')).toBe(true);
    expect(arenaRecordAddressOk(ID)).toBe(true);
    expect(arenaRecordAddressOk('../legacy')).toBe(false);
    expect(arenaTrashIdOk(TRASH)).toBe(true);
    expect(arenaTrashIdOk('tr_xyz')).toBe(false);
  });
});

describe('结束状态合法组合（契约 §4.2）', () => {
  it('timed：到时停止位置等于时长，提前结束不超过时长', () => {
    expect(parseArenaRecordResult({ origin: 'timed', finish: 'time-limit', durationMs: 1000, stoppedAtMs: 1000 }).ok).toBe(true);
    expect(parseArenaRecordResult(timed).ok).toBe(true);
    expect(parseArenaRecordResult({ origin: 'timed', finish: 'time-limit', durationMs: 1000, stoppedAtMs: 999 }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'timed', finish: 'stopped', durationMs: 1000, stoppedAtMs: 1001 }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'timed', finish: 'stopped', durationMs: 1000, stoppedAtMs: null }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'timed', finish: 'declared', durationMs: 1000, stoppedAtMs: null }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'timed', finish: 'time-limit', durationMs: null, stoppedAtMs: null }).ok).toBe(false);
  });

  it('manual 只能是 declared 且不伪造停止位置', () => {
    expect(parseArenaRecordResult({ origin: 'manual', finish: 'declared', durationMs: 1000, stoppedAtMs: null }).ok).toBe(true);
    expect(parseArenaRecordResult({ origin: 'manual', finish: 'declared', durationMs: 1000, stoppedAtMs: 0 }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'manual', finish: 'stopped', durationMs: 1000, stoppedAtMs: 100 }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'manual', finish: 'declared', durationMs: null, stoppedAtMs: null }).ok).toBe(false);
  });

  it('legacy-review 只有 unknown，两个时间字段可未知', () => {
    expect(parseArenaRecordResult({ origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null }).ok).toBe(true);
    expect(parseArenaRecordResult({ origin: 'legacy-review', finish: 'unknown', durationMs: 1000, stoppedAtMs: null }).ok).toBe(true);
    expect(parseArenaRecordResult({ origin: 'legacy-review', finish: 'declared', durationMs: null, stoppedAtMs: null }).ok).toBe(false);
    expect(parseArenaRecordResult({ origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: 0 }).ok).toBe(false);
  });

  it('枚举 / 数值形状不合法整份拒绝', () => {
    expect(parseArenaRecordResult(null).ok).toBe(false);
    expect(parseArenaRecordResult({ ...timed, origin: 'live' }).ok).toBe(false);
    expect(parseArenaRecordResult({ ...timed, durationMs: 1.5 }).ok).toBe(false);
    expect(parseArenaRecordResult({ ...timed, stoppedAtMs: -1 }).ok).toBe(false);
  });
});

describe('schema 2 存档文件校验', () => {
  it('合法文件读回逐发已排序', () => {
    const parsed = parseArenaRecordFile(file());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.ghost.subs.map((s) => s.p)).toEqual([0, 1]);
      expect(parsed.record.name).toBe('第一次 VP');
    }
  });

  it('schema / 身份 / 场次 / 正文不一致都拒绝', () => {
    expect(parseArenaRecordFile(file({ schema: 1 })).ok).toBe(false);
    expect(parseArenaRecordFile(file({ recordId: 'legacy' })).ok).toBe(true);
    expect(parseArenaRecordFile(file({ recordId: 'rec_x' })).ok).toBe(false);
    expect(parseArenaRecordFile(file({ contestId: 'contest-1' })).ok).toBe(false);
    expect(parseArenaRecordFile(file({ arenaPath: '../x.srk.json' })).ok).toBe(false);
    expect(parseArenaRecordFile(file({ result: { ...timed, stoppedAtMs: timed.durationMs! + 1 } })).ok).toBe(false);
  });
});

describe('名称（契约 §3.3：1–120、可重名、不参与路径）', () => {
  it('去首尾空白；空 / 超长拒绝；默认名按上海时钟到分钟', () => {
    expect(normalizeArenaRecordName('  第一次 VP  ')).toEqual({ ok: true, name: '第一次 VP' });
    expect(normalizeArenaRecordName('   ').ok).toBe(false);
    expect(normalizeArenaRecordName('x'.repeat(121)).ok).toBe(false);
    expect(normalizeArenaRecordName('x'.repeat(120)).ok).toBe(true);
    expect(defaultArenaRecordName(new Date('2026-10-29T13:30:00Z'))).toBe('2026-10-29 21:30');
    expect(arenaStampOf(new Date('2026-01-01T16:05:00Z'))).toBe('2026-01-02 00:05');
    expect(legacyArenaRecordName('2026-10-20T06:32:00.000Z')).toBe('旧存档 2026-10-20 14:32');
    expect(legacyArenaRecordName('坏时间')).toBe('旧存档');
  });

  it('另存副本名不超 120，原名称可重名', () => {
    expect(copyArenaRecordName('第一次 VP')).toBe('第一次 VP 副本');
    const long = copyArenaRecordName('x'.repeat(120));
    expect(long.length).toBe(120);
    expect(long.endsWith(' 副本')).toBe(true);
  });
});

describe('内容比较（新建幂等 / 更新对账）', () => {
  it('逐发顺序不算差异；show、判名、时刻、结束信息算差异', () => {
    const a = { show: true, subs: [{ p: 1, t: 45, r: 'AC' as const }, { p: 0, t: 20, r: 'WA' as const }] };
    const same = { show: true, subs: [{ p: 0, t: 20, r: 'WA' as const }, { p: 1, t: 45, r: 'AC' as const }] };
    expect(arenaGhostEquals(a, same)).toBe(true);
    expect(arenaGhostEquals(a, { ...same, show: false })).toBe(false);
    expect(arenaGhostEquals(a, { ...same, subs: [...same.subs, { p: 2, t: 60, r: 'AC' as const }] })).toBe(false);

    const content = { name: 'A', result: timed, ghost: a };
    expect(arenaRecordContentEquals(content, { ...content, ghost: same })).toBe(true);
    expect(arenaRecordContentEquals(content, { ...content, name: 'B' })).toBe(false);
    expect(arenaRecordContentEquals(content, { ...content, result: { ...timed, stoppedAtMs: 1 } })).toBe(false);
  });
});

describe('旧 review 投影与摘要', () => {
  const legacy = {
    schema: 1 as const,
    arenaPath: 'official/icpc/icpc2025/icpc2025shanghai.srk.json',
    title: '上海站',
    savedAt: '2026-10-20T06:32:00.000Z',
    ghost,
    view: { mode: 'review' as const, viewMs: 0, paused: false, frozenView: false },
  };

  it('identity 固定 legacy，两个时间沿用 savedAt，结束时间未知', () => {
    const projected = projectLegacyReview(legacy, 'obj_7f3a2c9b1d');
    expect(projected.recordId).toBe('legacy');
    expect(projected.createdAt).toBe(legacy.savedAt);
    expect(projected.updatedAt).toBe(legacy.savedAt);
    expect(projected.result).toEqual({ origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null });
    expect(projected.name).toBe('旧存档 2026-10-20 14:32');
    expect(arenaResultLabel(projected.result)).toContain('结束时间未知');
  });

  it('摘要只带计数，不带完整逐发', () => {
    const record: ArenaRecord = projectLegacyReview(legacy, 'obj_7f3a2c9b1d');
    const summary = summaryOfArenaRecord(record, 'hash');
    expect(summary).toMatchObject({ recordId: 'legacy', submissionCount: 2, revision: 'hash' });
    expect('ghost' in summary).toBe(false);
  });
});
