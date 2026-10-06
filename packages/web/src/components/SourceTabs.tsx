import type { KeyboardEvent, MutableRefObject } from 'react';
import { rankColorFor, type SourceState, type SourceId, type StatusDto, type SyncSourceId } from '@anvil/shared';
import { SOURCE_NAME } from '../api.ts';
import { fmtInt, fullStamp, relativeTime } from '../format.ts';
import { snapshotDate, snapshotDaysAgo } from './xcpc/derive.ts';
import { useTip } from '../tip.tsx';

const ORDER: SourceId[] = ['cf', 'at', 'xcpc'];
const DOT: Record<SourceState, string> = {
  ok: 'dot--ok',
  stale: 'dot--stale',
  down: 'dot--down',
  idle: 'dot--idle',
};

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

interface TabView {
  /** 次行读数：CF / AT 是当前 rating，XCPC 是官方榜分取整 */
  rating: string;
  color?: string;
  unset: boolean;
  dot: SourceState;
  tip: Tip;
}

/** XCPC 走认领而非 handle：分数用平台色而不走段位色，读数线是「档案 + 快照」两钟口径 */
function xcpcView(status: StatusDto | null): TabView {
  const x = status?.xcpc ?? null;
  if (x === null || !x.claimed) {
    return {
      rating: '—',
      unset: true,
      dot: 'idle',
      tip: { date: 'XCPC', value: '未认领', valueClass: 'is-mute' },
    };
  }
  const days = snapshotDaysAgo(x.snapshotAt);
  const valueClass = x.status === 'down' ? 'is-bad' : x.status === 'stale' ? 'is-warn' : 'is-dim';
  return {
    rating: x.officialRating === null ? '—' : fmtInt(Math.round(x.officialRating)),
    color: 'var(--pf-xcpc)',
    unset: false,
    dot: x.status,
    tip: {
      date: `XCPC · ${x.key ?? ''}`,
      value: `数据版本 ${snapshotDate(x.snapshotAt)}${days === null ? '' : ` · 生成 ${days} 天前`}`,
      valueClass,
      sub: `上次同步 ${x.fetchedAt === null ? '从未' : fullStamp(x.fetchedAt)} · 来源 xcpcrating 社区快照（非官方）`,
    },
  };
}

function syncView(status: StatusDto | null, id: SyncSourceId): TabView {
  const s = status?.sources[id];
  const name = SOURCE_NAME[id];
  if (!s || !s.configured) {
    return {
      rating: '—',
      unset: true,
      dot: 'idle',
      tip: { date: `${name} · 未配置`, value: '还没有填 handle · 点进去填一个', valueClass: 'is-mute' },
    };
  }
  if (s.lastSyncAt === null) {
    return {
      rating: s.rating === null ? '—' : String(s.rating),
      color: s.rating === null ? undefined : rankColorFor(s.rating, id),
      unset: false,
      dot: s.status,
      tip: { date: `${name} · @${s.handle}`, value: '还没有同步过', valueClass: 'is-mute' },
    };
  }

  const stamp = fullStamp(s.lastSyncAt);
  const sub =
    id === 'at' ? 'AT 不自动同步 · 需要你点一次' : `${fmtInt(s.counts.submissions)} 条提交 · ${fmtInt(s.counts.problems)} 题`;
  const tip =
    s.status === 'down'
      ? { date: `${name} · @${s.handle}`, value: `同步失败 · 显示本地缓存 ${stamp}`, valueClass: 'is-bad', sub: s.error ?? undefined }
      : s.status === 'stale'
        ? {
            date: `${name} · @${s.handle}`,
            value: `缓存于 ${stamp} · 已 ${relativeTime(s.lastSyncAt)}`,
            valueClass: 'is-warn',
            sub,
          }
        : { date: `${name} · @${s.handle}`, value: `数据更新于 ${stamp}`, valueClass: 'is-dim', sub };

  return {
    rating: s.rating === null ? '—' : String(s.rating),
    color: s.rating === null ? undefined : rankColorFor(s.rating, id),
    unset: false,
    dot: s.status,
    tip,
  };
}

export function SourceTabs({ current, status, onSelect, tabRefs }: Props) {
  const { show, hide } = useTip();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 带修饰键的方向键属于浏览器/系统（Alt+←/→ = 后退/前进），不能被 tablist 吞掉
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const i = ORDER.indexOf(current);
    const j = e.key === 'ArrowRight' ? (i + 1) % ORDER.length : e.key === 'ArrowLeft' ? (i - 1 + ORDER.length) % ORDER.length : e.key === 'Home' ? 0 : e.key === 'End' ? ORDER.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    onSelect(ORDER[j]!);
  };

  return (
    <div className="srctabs" role="tablist" aria-label="数据源切换" onKeyDown={onKeyDown}>
      {ORDER.map((id) => {
        const view = id === 'xcpc' ? xcpcView(status) : syncView(status, id);
        const tip = view.tip;
        return (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            className={`srctab pf-${id}${view.unset ? ' is-unset' : ''}`}
            role="tab"
            aria-selected={current === id}
            aria-controls={`content-${id}`}
            tabIndex={current === id ? 0 : -1}
            data-src={id}
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              show({ x: r.left + r.width / 2, y: r.bottom, below: true, date: tip.date, value: tip.value, valueClass: tip.valueClass, sub: tip.sub, zero: false });
            }}
            onMouseLeave={hide}
            onClick={() => onSelect(id)}
          >
            <span className="srctab__name">{SOURCE_NAME[id]}</span>
            <span className="srctab__rating" style={view.color === undefined ? undefined : { color: view.color }}>
              {view.rating}
            </span>
            <i className={`dot ${DOT[view.dot]}`} />
          </button>
        );
      })}
    </div>
  );
}
