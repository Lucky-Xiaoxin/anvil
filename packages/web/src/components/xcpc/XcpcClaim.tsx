/**
 * 认领屏与同款搜索组件（docs/14 §1.2 / §5.2）：搜索 → 候选 → 确认 → 完成。
 * 设置页的换人用同一个 `XcpcPicker`，只是完成条上不给「看档案」动作。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { XcpcProfileDto, XcpcSearchRow } from '@anvil/shared';
import { ApiError, claimXcpc, searchXcpc } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { snapshotDate } from './derive.ts';
import { Icon } from '../ui.tsx';

/** 站点自身的防抖节奏（docs/14 §5.2） */
const DEBOUNCE_MS = 260;

type Phase = 'idle' | 'loading' | 'results' | 'confirm' | 'done';

interface PickerProps {
  ariaLabel: string;
  /** 完成条上的动作；不给就不画按钮（换人就地完成） */
  onDone?: () => void;
  /** 认领成功就地把档案交回上层：App 据此切长卷 */
  onClaimed: (profile: XcpcProfileDto) => void;
  /** 搜索框下方的口径提示 */
  hint?: string;
  /** 有档案时换人的提醒 */
  swapHint?: string;
  autoFocus?: boolean;
}

export function XcpcPicker({ ariaLabel, onDone, onClaimed, hint, swapHint, autoFocus = false }: PickerProps) {
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [results, setResults] = useState<XcpcSearchRow[]>([]);
  const [picked, setPicked] = useState<XcpcSearchRow | null>(null);
  const [done, setDone] = useState<XcpcProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const timer = useRef<number | null>(null);
  /** 迟到的响应不许把用户已经推进的状态拽回去 */
  const seq = useRef(0);

  const run = useCallback(async (query: string) => {
    const my = ++seq.current;
    setPhase('loading');
    setError(null);
    try {
      const { results: list } = await searchXcpc(query);
      if (my !== seq.current) return;
      setResults(list);
      setPhase('results');
    } catch (err) {
      if (my !== seq.current) return;
      setResults([]);
      setError(messageOf(err));
      setPhase('results');
    }
  }, []);

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const trimmed = q.trim();
    if (trimmed === '') {
      // 清空输入就回到初始态：上一次的结果 / 确认块都不该还挂着
      seq.current++;
      setPhase('idle');
      setResults([]);
      setPicked(null);
      setError(null);
      return;
    }
    timer.current = window.setTimeout(() => void run(trimmed), DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [q, run]);

  const claim = async (row: XcpcSearchRow): Promise<void> => {
    setClaiming(true);
    setError(null);
    try {
      const profile = await claimXcpc(row.key);
      setDone(profile);
      setPhase('done');
      onClaimed(profile);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `认领失败：${messageOf(err)}`);
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div className="srchwrap">
      <div className="search">
        <Icon id="i-search" />
        <input
          type="text"
          value={q}
          placeholder="姓名或学校"
          aria-label={ariaLabel}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value);
            setPicked(null);
            if (phase === 'confirm') setPhase('results');
            if (phase === 'done') setPhase('results');
          }}
        />
      </div>
      {hint ? <div className="hint" style={{ marginTop: 8 }}>{hint}</div> : null}
      {swapHint ? <div className="hint" style={{ marginTop: 8 }}>{swapHint}</div> : null}

      {phase === 'loading' ? (
        <div className="srchres">
          <div className="skel">
            <i />
            {`正在搜索「${q.trim()}」…`}
          </div>
        </div>
      ) : null}

      {phase === 'results' && error !== null ? (
        <div className="srchres">
          <div className="alert alert--err">
            <Icon id="i-plug" />
            <div>
              <b>XCPC 快照暂不可达</b> · 请稍后重试
              <br />
              {error}
            </div>
            <button className="alert__x" onClick={() => void run(q.trim())}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'results' && error === null && results.length === 0 ? (
        <div className="srchres">
          <div className="skel">没有匹配的档案 · 换一种写法试试</div>
        </div>
      ) : null}

      {(phase === 'results' || phase === 'confirm') && error === null && results.length > 0 ? (
        <div className="srchres">
          {results.map((row) => (
            <button
              key={row.key}
              type="button"
              className={`cand${picked?.key === row.key ? ' is-picked' : ''}`}
              onClick={() => {
                setPicked(row);
                setPhase('confirm');
              }}
            >
              <span className="cand__av">{row.name.slice(0, 1)}</span>
              <span className="cand__who">
                {row.name} <span className="cand__org">@{row.org}</span>
              </span>
              <span className="cand__n">{row.contests} 场</span>
              {picked?.key === row.key ? <Icon id="i-check" className="cand__ck" /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {phase === 'confirm' && picked !== null ? (
        <div className="srchconfirm">
          <div className="confirm">
            <div className="confirm__id">
              <span className="label">已选中</span>
              <b>{picked.key}</b>
            </div>
            <span style={{ flex: '1 1 auto' }} />
            <button className="btn btn--primary" disabled={claiming} onClick={() => void claim(picked)}>
              <Icon id="i-check" />
              {claiming ? '认领中…' : '认出我的档案'}
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => {
                setPicked(null);
                setPhase('results');
              }}
            >
              换一个
            </button>
          </div>
          {error !== null ? (
            <div className="alert alert--err" style={{ marginTop: 12 }}>
              <Icon id="i-x" />
              <div>{error}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === 'done' && done !== null ? (
        <div className="srchdone">
          <div className="alert alert--ok" role="status">
            <Icon id="i-check" />
            <div>
              <b>{`已认领 ${done.player.key}`}</b> · {done.player.contests} 场 · 数据版本{' '}
              <code>{snapshotDate(done.snapshotAt)}</code>
            </div>
            {onDone ? (
              <button className="alert__x" style={{ color: 'var(--accent-2)' }} onClick={onDone}>
                看档案
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

    </div>
  );
}

interface Props {
  onClaimed: (profile: XcpcProfileDto) => void;
  onGoDossier: () => void;
}

/** 未认领的空态屏：单卡 hero，认领动作全在 `XcpcPicker` 里 */
export function XcpcClaim({ onClaimed, onGoDossier }: Props) {
  return (
    <div className="content" id="content-xcpc" role="tabpanel">
      <div className="stack">
        <div className="card hero-card rise">
          <div className="empty-hero">
            <div>
              <span className="label label--pf">XCPC</span>
              <h3 className="hero-title" style={{ marginTop: 12 }}>
                还没有认领 <em>XCPC</em> 选手档案。
              </h3>
              <p className="dim" style={{ fontSize: 13, lineHeight: 1.7, marginTop: 8 }}>
                输入姓名或学校 —— 从快照名单里认出你自己。
              </p>
            </div>
            <XcpcPicker
              ariaLabel="搜索 XCPC 选手"
              hint="重名请对照学校"
              onClaimed={onClaimed}
              onDone={onGoDossier}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
