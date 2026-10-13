/**
 * 「我的成绩」录入面板（docs/20 §2.3）：每题一行（过题分钟 / AC 前失败），留空 = 未过。
 *
 * 行数是**本场题目数**（`model.problems[].alias`），不是写死的 A–M；每次输入即刻生效 ——
 * 由父组件落 localStorage 并重建榜（口径同时间轴：分钟粒度，不引入秒级重排）。
 *
 * 「清除本场成绩」两击确认：第一击只把文案换成「再点一次确认清除」，失焦或三秒后复位。
 */
import { useEffect, useRef, useState } from 'react';
import type { ContestModel, GhostMark } from './engine.ts';
import { PopShell } from './pops.tsx';
import type { GhostData } from './session.ts';

interface Props {
  problems: ContestModel['problems'];
  /** 本场已存的录入；null = 还没录过（面板全空） */
  data: GhostData | null;
  onChange: (next: GhostData) => void;
  onClear: () => void;
}

const EMPTY: GhostData = { show: true, marks: [] };

/** 过题分钟：正有限数才收（留空 = 未过） */
const parseAc = (raw: string): number | undefined => {
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 失败次数：≥1 的整数才收（未过题的失败不计罚时，但格子要显 −n） */
const parseFails = (raw: string): number | undefined => {
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};

export function GhostPanel({ problems, data, onChange, onClear }: Props) {
  const show = data?.show ?? EMPTY.show;
  const byP = new Map<number, GhostMark>((data?.marks ?? EMPTY.marks).map((m) => [m.p, m]));

  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  const disarm = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const patch = (p: number, field: 'ac' | 'fails', raw: string): void => {
    const cur = byP.get(p);
    const ac = field === 'ac' ? parseAc(raw) : cur?.ac;
    const fails = field === 'fails' ? parseFails(raw) : cur?.fails;
    const next = new Map(byP);
    // 两个数都空 = 这一题没录过：整行删掉（存储只留非空洞）
    if (ac === undefined && fails === undefined) next.delete(p);
    else next.set(p, { p, ...(ac !== undefined ? { ac } : {}), ...(fails !== undefined ? { fails } : {}) });
    onChange({ show, marks: [...next.values()].sort((a, b) => a.p - b.p) });
  };

  const clear = (): void => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(disarm, 3000);
      return;
    }
    disarm();
    onClear();
  };

  return (
    <PopShell head={{ title: '我的成绩', sub: '你 VP 时的成绩 · 罚时 = 过题分钟 + 20 × AC 前失败（与榜单同口径）' }}>
      <div className="ghgrid">
        <div className="ghrow">
          <b aria-hidden="true" />
          <span className="ghlab">过题′</span>
          <span className="ghlab">失败</span>
        </div>
        {problems.map((pr, p) => (
          <div className="ghrow" key={pr.alias ?? p}>
            <b>{pr.alias ?? String.fromCharCode(65 + p)}</b>
            <input
              className="ghin"
              inputMode="numeric"
              placeholder="过题′"
              aria-label={`${pr.alias ?? String.fromCharCode(65 + p)} 过题分钟`}
              value={String(byP.get(p)?.ac ?? '')}
              onChange={(e) => patch(p, 'ac', e.target.value)}
            />
            <input
              className="ghin"
              inputMode="numeric"
              placeholder="失败"
              aria-label={`${pr.alias ?? String.fromCharCode(65 + p)} 失败次数`}
              value={String(byP.get(p)?.fails ?? '')}
              onChange={(e) => patch(p, 'fails', e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="pop__rule" />
      <div className="ghfoot">
        <label className="switch">
          <input type="checkbox" checked={show} onChange={(e) => onChange({ show: e.target.checked, marks: data?.marks ?? [] })} />
          展示我
        </label>
        <span className="spacer" />
        <button className="btn btn--xs btn--ghost" onClick={clear} onBlur={disarm} title="清除本场录入的成绩（两击确认）">
          {armed ? '再点一次确认清除' : '清除本场成绩'}
        </button>
      </div>
      <div className="ghnote">留空 = 未过；段内成绩按时间轴与封榜视角自动同口径。</div>
    </PopShell>
  );
}
