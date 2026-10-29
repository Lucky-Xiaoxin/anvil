import { describe, expect, it } from 'vitest';
import type { ArenaRecord } from '@anvil/shared';
import type { LeafRow } from '../src/components/arena/catalog.ts';
import {
  arenaTitleOf,
  copySaveName,
  firstSaveName,
  ghostToRecord,
  legacyRecordDisplayName,
  newRecordId,
  recordSourceLabel,
  recordStamp,
  recordToGhost,
  resultLabel,
} from '../src/components/arena/record.ts';

const row: LeafRow = {
  path: 'official/icpc/icpc2025/icpc2025shanghai.srk.json',
  date: '2025-11-23',
  name: '上海站',
  group: ['ICPC', 'ICPC 2025'],
  badge: { tier: 'regional', label: '区域赛' },
};

describe('多存档映射与命名（契约 §3.3 / §4.1）', () => {
  it('幽灵形状往返不丢字段，标题优先用日期 + 站名', () => {
    const ghost = { show: false, subs: [{ p: 0, t: 113, r: 'AC' as const }] };
    expect(recordToGhost(ghostToRecord(ghost))).toEqual(ghost);
    expect(arenaTitleOf(row)).toBe('2025-11-23 上海站');
    expect(arenaTitleOf({ ...row, date: '', name: '' })).toBe(row.path);
  });

  it('新档 ID 是 rec_ + 32 位小写十六进制；两次不重复', () => {
    const a = newRecordId();
    const b = newRecordId();
    expect(a).toMatch(/^rec_[0-9a-f]{32}$/);
    expect(b).toMatch(/^rec_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('首次保存默认本地日期时间；另存副本名可读且不超长', () => {
    expect(firstSaveName(new Date('2026-10-29T13:30:00Z'))).toBe('2026-10-29 21:30');
    expect(copySaveName('第一次 VP')).toBe('第一次 VP 副本');
    expect(copySaveName('x'.repeat(120))).toHaveLength(120);
  });

  it('存档时间按上海时钟；坏时间原样返回', () => {
    expect(recordStamp('2026-10-20T06:32:00.000Z')).toBe('2026-10-20 14:32');
    expect(recordStamp('坏时间')).toBe('坏时间');
  });

  it('旧 review 默认名、结束状态读法（结束时间未知不伪装完赛）', () => {
    expect(legacyRecordDisplayName({ savedAt: '2026-10-20T06:32:00.000Z' } as never)).toBe('旧存档 2026-10-20 14:32');
    expect(resultLabel({ origin: 'legacy-review', finish: 'unknown', durationMs: null, stoppedAtMs: null })).toContain('结束时间未知');
    expect(resultLabel({ origin: 'timed', finish: 'stopped', durationMs: 1000, stoppedAtMs: 100 })).toContain('提前结束');
  });

  it('存档来源标签与摘要读法', () => {
    const record: ArenaRecord = {
      schema: 2,
      recordId: `rec_${'a'.repeat(32)}`,
      contestId: 'obj_7f3a2c9b1d',
      arenaPath: row.path,
      name: 'A',
      createdAt: '2026-10-29T12:00:00.000Z',
      updatedAt: '2026-10-29T12:00:00.000Z',
      result: { origin: 'manual', finish: 'declared', durationMs: 1000, stoppedAtMs: null },
      ghost: { show: true, subs: [] },
    };
    expect(recordSourceLabel(record)).toContain('补录');
    expect(recordSourceLabel({ recordId: 'x', name: 'x', createdAt: '', updatedAt: '', submissionCount: 0, revision: 'r', result: record.result })).toContain('补录');
  });
});
