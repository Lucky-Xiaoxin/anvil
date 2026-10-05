import type { KeyboardEvent, MutableRefObject } from 'react';
import { rankColorFor, type SourceId, type SourceState, type StatusDto, type SyncSourceId } from '@anvil/shared';
import { SOURCE_NAME } from '../api.ts';
import { fmtInt, fullStamp, relativeTime } from '../format.ts';
import { useTip } from '../tip.tsx';

const ORDER: SourceId[] = ['cf', 'at', 'xcpc'];
const DOT: Record<SourceState, string> = {
  ok: 'dot--ok',
  stale: 'dot--stale',
  down: 'dot--down',
  idle: 'dot--idle',
};
/** 点只说"通不通"，日期与原因交给 tooltip 的读数行 */
const READ_CLASS: Record<SourceState, string> = { ok: 'is-dim', stale: 'is-warn', down: 'is-bad', idle: 'is-mute' };

interface Props {
  /** 当前真的挂在屏上的源（切换进行中仍是旧源，指示条跟着换屏走） */
  current: SourceId;
  status: StatusDto | null;
  onSelect: (source: SourceId) => void;
  /** 换屏瞬间把焦点交给目标屏的 tab 项，不甩进内容区 */
  tabRefs: MutableRefObject<Partial<Record<SourceId, HTMLButtonElement | null>>>;
}

interface Tip {
  date: string;
  value: string;
  valueClass: string;
  sub?: string;
}

function tipOf(status: StatusDto | null, id: SourceId): Tip {
  if (id === 'xcpc') {
    return {
      date: 'XCPC · 未接入',
      value: '待接入 · 契约已冻结（docs/09 §9）',
      valueClass: 'is-mute',
      sub: '本切片不实现同步',
    };
  }
  const s = status?.sources[id];
  const name = SOURCE_NAME[id];
  if (!s || !s.configured) return { date: `${name} · 未配置`, value: '还没有填 handle · 点进去填一个', valueClass: 'is-mute' };
  if (s.lastSyncAt === null) return { date: `${name} · @${s.handle}`, value: '还没有同步过', valueClass: 'is-mute' };

  const stamp = fullStamp(s.lastSyncAt);
  if (s.status === 'down') {
    return { date: `${name} · @${s.handle}`, value: `同步失败 · 显示本地缓存 ${stamp}`, valueClass: 'is-bad', sub: s.error ?? undefined };
  }
  if (s.status === 'stale') {
    return {
      date: `${name} · @${s.handle}`,
      value: `缓存于 ${stamp} · 已 ${relativeTime(s.lastSyncAt)}`,
      valueClass: 'is-warn',
      sub: id === 'at' ? 'AT 不自动同步 · 需要你点一次' : `${fmtInt(s.counts.submissions)} 条提交 · ${fmtInt(s.counts.problems)} 题`,
    };
  }
  return {
    date: `${name} · @${s.handle}`,
    value: `数据更新于 ${stamp}`,
    valueClass: 'is-dim',
    sub: id === 'at' ? 'AT 不自动同步 · 需要你点一次' : `${fmtInt(s.counts.submissions)} 条提交 · ${fmtInt(s.counts.problems)} 题`,
  };
}

export function SourceTabs({ current, status, onSelect, tabRefs }: Props) {
  const { show, hide } = useTip();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ORDER.indexOf(current);
    const j = e.key === 'ArrowRight' ? (i + 1) % ORDER.length : e.key === 'ArrowLeft' ? (i - 1 + ORDER.length) % ORDER.length : e.key === 'Home' ? 0 : e.key === 'End' ? ORDER.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    onSelect(ORDER[j]!);
  };

  return (
    <div className="srctabs" role="tablist" aria-label="数据源切换" onKeyDown={onKeyDown}>
      {ORDER.map((id) => {
        const src = id === 'xcpc' ? null : status?.sources[id as SyncSourceId];
        const unset = id === 'xcpc' || !src?.configured;
        const rating = src?.rating ?? null;
        const tip = tipOf(status, id);
        return (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            className={`srctab pf-${id}${unset ? ' is-unset' : ''}`}
            role="tab"
            aria-selected={current === id}
            aria-controls={`content-${id}`}
            tabIndex={current === id ? 0 : -1}
            data-src={id}
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              show({ x: r.left + r.width / 2, y: r.top, date: tip.date, value: tip.value, valueClass: tip.valueClass, sub: tip.sub, zero: false });
            }}
            onMouseLeave={hide}
            onClick={() => onSelect(id)}
          >
            <span className="srctab__name">{SOURCE_NAME[id]}</span>
            <span className="srctab__rating" style={rating === null ? undefined : { color: rankColorFor(rating, id as SyncSourceId) }}>
              {rating === null ? '—' : rating}
            </span>
            {id === 'xcpc' ? <span className="srctab__pending">待接入</span> : null}
            <i className={`dot ${DOT[src?.status ?? 'idle']}`} />
          </button>
        );
      })}
    </div>
  );
}
