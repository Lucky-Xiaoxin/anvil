import { describe, expect, it } from 'vitest';
import type { LeafRow } from '../src/components/arena/catalog.ts';
import { arenaTitleOf, ghostToRecord, recordToGhost, viewOfRow } from '../src/components/arena/record.ts';
import { saveSession, type Store } from '../src/components/arena/session.ts';

const row: LeafRow = {
  path: 'official/icpc/icpc2025/icpc2025shanghai.srk.json',
  date: '2025-11-23',
  name: '上海站',
  group: ['ICPC', 'ICPC 2025'],
  badge: { tier: 'regional', label: '区域赛' },
};

function memoryStore(): Store {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('VP 成绩存档映射', () => {
  it('幽灵形状往返不丢字段，标题优先用日期 + 站名', () => {
    const ghost = { show: false, subs: [{ p: 0, t: 113, r: 'AC' as const }] };
    expect(recordToGhost(ghostToRecord(ghost))).toEqual(ghost);
    expect(arenaTitleOf(row)).toBe('2025-11-23 上海站');
    expect(arenaTitleOf({ ...row, date: '', name: '' })).toBe(row.path);
  });

  it('目录行保存：进行中存 live，否则按会话位置存 review', () => {
    const store = memoryStore();
    expect(viewOfRow(store, row, { elapsed: 72000, paused: true })).toEqual({
      mode: 'live',
      viewMs: 72000,
      paused: true,
      frozenView: false,
    });

    saveSession(store, row.path, {
      started: 1000,
      hold: true,
      paused: false,
      ended: true,
      scrubMs: 180000,
      at: 180000,
      durationMs: 14400000,
    });
    expect(viewOfRow(store, row, null)).toEqual({ mode: 'review', viewMs: 180000, paused: false, frozenView: false });

    // 回顾停在 0:00 是合法位置，不能拿终榜时长顶替
    saveSession(store, row.path, {
      started: 1000,
      hold: true,
      paused: false,
      ended: true,
      scrubMs: 0,
      at: 0,
      durationMs: 14400000,
    });
    expect(viewOfRow(store, row, null)).toEqual({ mode: 'review', viewMs: 0, paused: false, frozenView: false });
    expect(viewOfRow(memoryStore(), row, null)).toEqual({ mode: 'review', viewMs: 0, paused: false, frozenView: false });
  });
});
