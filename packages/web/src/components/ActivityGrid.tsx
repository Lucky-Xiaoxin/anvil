import { useMemo, type CSSProperties } from 'react';
import {
  addDays,
  dowMon,
  formatDay,
  gridStartDate,
  levelOf,
  WEEKDAY_LABELS,
  WEEKS,
  type ActivityCellDto,
} from '@anvil/shared';
import { useTip } from '../tip.tsx';

interface Props {
  activity: ActivityCellDto[];
  today: Date;
  /** 空态：整张网格按 0 档铺满，不动效 */
  ghost?: boolean;
  totalLabel?: number;
}

export function ActivityGrid({ activity, today, ghost = false, totalLabel }: Props) {
  const { show, hide } = useTip();

  const model = useMemo(() => {
    const byDay = new Map(activity.map((a) => [a.day, a.solved]));
    const start = gridStartDate(today, WEEKS);
    const todayKey = formatDay(today);

    const months: { col: number; text: string }[] = [];
    let last = -99;
    for (let c = 0; c < WEEKS; c++) {
      let firstOfMonth: Date | null = null;
      for (let j = 0; j < 7; j++) {
        const d = addDays(start, c * 7 + j);
        if (d.getDate() === 1 && d.getTime() <= today.getTime()) {
          firstOfMonth = d;
          break;
        }
      }
      if (!firstOfMonth || (c - last < 3 && c !== 0)) continue;
      months.push({
        col: c,
        text: firstOfMonth.getMonth() === 0 ? String(firstOfMonth.getFullYear()) : `${firstOfMonth.getMonth() + 1}月`,
      });
      last = c;
    }

    const cells: { iso: string; row: number; col: number; i: number; solved: number; future: boolean; weekday: number }[] = [];
    for (let i = 0; i < WEEKS * 7; i++) {
      const date = addDays(start, i);
      const iso = formatDay(date);
      const solved = byDay.get(iso) ?? 0;
      // 空态网格要的是"铺满 0 档"，只有真·未来日才留空
      const future = date.getTime() > today.getTime() || (!ghost && !byDay.has(iso));
      cells.push({ iso, row: dowMon(date), col: Math.floor(i / 7), i, solved, future, weekday: dowMon(date) });
    }
    return { cells, months, todayKey };
  }, [activity, today, ghost]);

  return (
    <div
      className="agrid"
      role="img"
      aria-label={ghost ? undefined : `近 53 周活跃格子图：合计 ${totalLabel ?? 0} 题次`}
    >
      {model.months.map((m) => (
        <div key={`m${m.col}`} className="amonth" style={{ gridRow: '1', gridColumn: String(m.col + 2) }}>
          {m.text}
        </div>
      ))}
      {[0, 2, 4].map((r) => (
        <div key={`w${r}`} className="awd" style={{ gridRow: String(r + 2), gridColumn: '1' }}>
          周{WEEKDAY_LABELS[r]}
        </div>
      ))}
      {model.cells.map((c) => {
        const style: CSSProperties = { gridRow: String(c.row + 2), gridColumn: String(c.col + 2) };
        if (c.future) {
          return <div key={c.iso} className="acell acell--future" style={style} />;
        }
        const solved = ghost ? 0 : c.solved;
        if (ghost) {
          style.animation = 'none';
          style.opacity = 1;
        } else {
          style.animationDelay = `${Math.min(470, c.i * 1.2)}ms`;
        }
        return (
          <div
            key={c.iso}
            className={`acell${c.iso === model.todayKey ? ' acell--today' : ''}`}
            data-l={levelOf(solved)}
            style={style}
            onMouseEnter={
              ghost
                ? undefined
                : (e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({
                      x: r.left + r.width / 2,
                      y: r.top,
                      date: `${c.iso} · 周${WEEKDAY_LABELS[c.weekday]}`,
                      value: solved > 0 ? `过 ${solved} 题` : '没有训练',
                      zero: solved === 0,
                    });
                  }
            }
            onMouseLeave={hide}
          />
        );
      })}
    </div>
  );
}
