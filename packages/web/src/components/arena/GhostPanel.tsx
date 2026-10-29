/**
 * 「我的成绩」录入面板（docs/contracts/20 §2.3 · v8 逐发）：一行表单加一发提交，其下列逐发清单。
 *
 * v7 是十三行「过题分钟 / AC 前失败」的聚合表 —— 只能看成绩、看不到每次提交。v8 起数据源就是
 * 逐发（题 · 时刻 · 判名），榜上格子的口径因此与真队完全同源（含未过题的末次时刻）。
 *
 * 判名五档照 CF 手输：AC / WA / TLE / RE / CE（FB 不给选 —— 幽灵永不首杀；CE 不罚时）。
 * 时刻填 时:分（只收数字、超一位自动补冒号、回车即提交）；题号与判名记住上一次，连续交同一题时
 * 少两次操作。每次改动即刻由父组件落 localStorage 并重建榜（分钟粒度，同时间轴口径）。
 */
import { useState } from 'react';
import { GHOST_RESULTS, type ContestModel, type GhostResult, type GhostSub } from './engine.ts';
import { PopShell, resClass } from './pops.tsx';
import type { GhostData } from './session.ts';

interface Props {
  problems: ContestModel['problems'];
  /** 本场时长（毫秒）：时刻超过它就不收 */
  durationMs: number;
  /** 本场已存的逐发；null = 还没录过（面板全空） */
  data: GhostData | null;
  /** 查看历史档：只看 / 只切“展示我”，不增删逐发（docs/contracts/29 §3.1） */
  readOnly?: boolean;
  onChange: (next: GhostData) => void;
  onClear: () => void;
}

const EMPTY: GhostSub[] = [];

/** 分钟 → 时:分（榜上读法一致） */
const hm = (min: number): string => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

/** 只收数字，超一位补冒号：`4` → `4`、`41` → `4:1`、`412` → `4:12` */
const formatTime = (raw: string): string => {
  const d = raw.replace(/\D/g, '').slice(0, 3);
  return d.length <= 1 ? d : `${d.slice(0, 1)}:${d.slice(1)}`;
};

/** `时:分` → 比赛分钟；读不懂就 null（不猜） */
const parseTime = (raw: string): number | null => {
  const d = raw.replace(/\D/g, '');
  if (d.length < 2 || d.length > 3) return null;
  const h = Number(d.charAt(0));
  const m = Number(d.slice(1));
  if (m > 59) return null;
  return h * 60 + m;
};

const byOrder = (a: GhostSub, b: GhostSub): number => a.p - b.p || a.t - b.t;

export function GhostPanel({ problems, durationMs, data, readOnly = false, onChange, onClear }: Props) {
  const show = data?.show ?? true;
  const subs = data?.subs ?? EMPTY;

  const [p, setP] = useState(0);
  const [r, setR] = useState<GhostResult>('AC');
  const [raw, setRaw] = useState('');
  const [hint, setHint] = useState('');
  const [bad, setBad] = useState(false);
  const [armed, setArmed] = useState(false);
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    setTimer(null);
    setArmed(false);
  };

  const aliasOf = (i: number): string => problems[i]?.alias ?? String.fromCharCode(65 + i);

  const fail = (msg: string): void => {
    setHint(msg);
    setBad(true);
  };

  const submit = (): void => {
    const min = parseTime(raw);
    if (min === null) return fail('时间填 时:分，例如 4:12');
    if (min * 60_000 > durationMs) return fail(`超过本场时长 ${hm(Math.floor(durationMs / 60_000))}`);
    if (r === 'AC' && subs.some((s) => s.p === p && s.r === 'AC')) return fail('该题已过题 · 先删掉那条 AC');
    setBad(false);
    setHint(`已记：第 ${aliasOf(p)} 题 · ${r} · ${hm(min)}`);
    onChange({ show, subs: [...subs, { p, t: min, r }].sort(byOrder) });
    setRaw('');
  };

  const remove = (ix: number): void => {
    const next = subs.slice();
    next.splice(ix, 1);
    setBad(false);
    setHint('');
    onChange({ show, subs: next });
  };

  const clear = (): void => {
    if (!armed) {
      setArmed(true);
      setTimer(setTimeout(disarm, 3000));
      return;
    }
    disarm();
    setHint('');
    onClear();
  };

  const sorted = [...subs].sort(byOrder);

  return (
    <PopShell head={{ title: '我的成绩', sub: '你 VP 时的逐发提交 · 罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）' }}>
      <div className="pop__rule" />
      {readOnly ? (
        <div className="ghhint">查看历史成绩：逐发只读；要修改请点顶栏「编辑成绩」。</div>
      ) : (
        <>
          <div className="ghform">
            <select className="ghsel" aria-label="题目" value={p} onChange={(e) => setP(Number(e.target.value))}>
              {problems.map((pr, i) => (
                <option key={pr.alias ?? i} value={i}>
                  {aliasOf(i)}
                </option>
              ))}
            </select>
            <select className="ghsel" aria-label="判名" value={r} onChange={(e) => setR(e.target.value as GhostResult)}>
              {GHOST_RESULTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <input
              className={'ghin ghin--t' + (bad ? ' is-bad' : '')}
              aria-label="提交时刻 时:分"
              inputMode="numeric"
              maxLength={4}
              placeholder="4:12"
              value={raw}
              onChange={(e) => {
                setRaw(formatTime(e.target.value));
                setBad(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
            <button className="btn btn--xs btn--go" onClick={submit}>
              提交
            </button>
          </div>
          <div className={'ghhint' + (bad ? ' is-bad' : '')}>{hint === '' ? '时间 = 时:分（自动补冒号）· 同一题第二个 AC 不收' : hint}</div>
        </>
      )}
      <div className="pop__rule" />
      <div className="ghsubs">
        {sorted.length === 0 ? (
          <div className="hint" style={{ padding: '6px 0' }}>
            还没录。选题 · 选判名 · 填 时:分 · 提交。
          </div>
        ) : (
          sorted.map((s, ix) => (
            <div className="ghsub" key={`${s.p}-${s.t}-${s.r}-${ix}`}>
              <b>{aliasOf(s.p)}</b>
              <span className="ghsub__t">{hm(s.t)}</span>
              <span className={resClass(s.r)}>{s.r}</span>
              <span />
              {readOnly ? null : (
                <button className="ghsub__x" aria-label={`删除第 ${aliasOf(s.p)} 题这发`} onClick={() => remove(ix)}>
                  ×
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="pop__rule" />
      <div className="ghfoot">
        <label className="switch">
          <input type="checkbox" checked={show} onChange={(e) => onChange({ show: e.target.checked, subs })} />
          展示我
        </label>
        <span className="spacer" />
        {readOnly ? null : (
          <button className="btn btn--xs btn--ghost" onClick={clear} onBlur={disarm} title="清除本场录入的成绩（两击确认）">
            {armed ? '再点一次确认清除' : '清除本场成绩'}
          </button>
        )}
      </div>
      <div className="ghnote">{readOnly ? '展示我只影响这次查看，不改存档。' : '逐发即明细：点榜上格子看每题；段内成绩按时间轴与封榜视角自动同口径。'}</div>
    </PopShell>
  );
}
