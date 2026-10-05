import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StatusDto, SyncStateDto } from '@anvil/shared';
import { ApiError, saveHandles } from '../api.ts';
import { fmtInt, messageOf } from '../format.ts';
import { Icon } from './ui.tsx';

type Phase = 'input' | 'checking' | 'ready' | 'syncing' | 'done';

interface Props {
  status: StatusDto | null;
  /** 同步进度由 App 拥有：切走再回来也还对得上 */
  sync: SyncStateDto | null;
  onStatus: (status: StatusDto) => void;
  /** 起跑并轮询到落定，返回最后一帧状态；已经在跑则返回 null */
  onRun: () => Promise<SyncStateDto | null>;
  onEnterDashboard: () => void;
}

/** 只有"正在跑"才接管面板；跑完/失败的落点由本次 run 自己负责，否则设置页就没有回 Step 1 换 handle 的路了 */
function initialPhase(sync: SyncStateDto | null): Phase {
  return sync && (sync.phase === 'fetching' || sync.phase === 'storing') ? 'syncing' : 'input';
}

export function Wizard({ status, sync, onStatus, onRun, onEnterDashboard }: Props) {
  const [phase, setPhase] = useState<Phase>(() => initialPhase(sync));
  const [handle, setHandle] = useState(status?.handle ?? '');
  const [checkErr, setCheckErr] = useState<{ kind: string; message: string } | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setHandle((h) => (h === '' ? (status?.handle ?? '') : h));
  }, [status]);
  // 正在跑的那次同步归 App：不管是谁起跑的，面板都跟得上
  useEffect(() => {
    if (!sync || phase !== 'syncing') return;
    if (sync.phase === 'done') {
      setSyncErr(null);
      setPhase('done');
    } else if (sync.phase === 'error') {
      setSyncErr(sync.error ?? '同步失败');
      setPhase('ready');
    }
  }, [sync, phase]);

  const busy = phase === 'checking' || phase === 'syncing';
  const step = phase === 'input' ? 1 : phase === 'checking' ? 2 : phase === 'done' ? 4 : 3;
  const hasData = (status?.counts.submissions ?? 0) > 0;
  // 失败那一次不算完的步骤，日志里别把没发生的请求画出来
  const shown = syncErr ? null : sync;

  async function check() {
    const name = handle.trim();
    if (name === '') return;
    setPhase('checking');
    setCheckErr(null);
    try {
      onStatus(await saveHandles({ cfHandle: name }));
      if (!alive.current) return;
      setPhase('ready');
    } catch (err) {
      if (!alive.current) return;
      const e = err instanceof ApiError ? err : new ApiError(messageOf(err));
      setCheckErr({ kind: e.kind, message: e.message });
      setPhase('input');
    }
  }

  async function run() {
    setPhase('syncing');
    setSyncErr(null);
    try {
      const state = await onRun();
      if (!alive.current) return;
      if (!state) {
        setPhase('ready');
        return;
      }
      if (state.phase === 'error') {
        setSyncErr(state.error ?? '同步失败');
        setPhase('ready');
        return;
      }
      setPhase('done');
    } catch (err) {
      if (!alive.current) return;
      setSyncErr(messageOf(err));
      setPhase('ready');
    }
  }

  const log: { mark: string; cls?: string; text: ReactNode }[] = [];
  if (phase !== 'input' && phase !== 'checking' && !checkErr) {
    log.push({ mark: '✓', cls: 'blue', text: <>校验通过 · user.status?count=1</> });
  }
  if (phase === 'checking') log.push({ mark: '→', cls: 'run', text: <>正在校验 handle…</> });
  if (phase === 'ready' && !shown) {
    log.push({ mark: '·', text: <>限速 <span style={{ color: 'var(--warn)' }}>1 请求 / 2 秒</span> · 写入 vault/anvil.db</> });
  }
  if (shown?.resetNote) log.push({ mark: '!', cls: 'run', text: <>{shown.resetNote}</> });
  for (let p = 0; p < (shown?.pages ?? 0); p++) {
    log.push({
      mark: '→',
      cls: 'run',
      text: (
        <>
          GET user.status?handle={handle.trim()}&amp;from={p * 10000 + 1}&amp;count=10000
        </>
      ),
    });
  }
  if (shown && shown.phase !== 'fetching') {
    log.push({ mark: '→', cls: 'run', text: <>GET user.rating?handle={handle.trim()}</> });
    log.push({
      mark: '→',
      cls: 'blue',
      text: <>哨兵值 relativeTimeSeconds=2147483647 → <b>NULL</b>（场外提交 {fmtInt(shown.offsite ?? 0)} 条）</>,
    });
  }
  if (shown && shown.phase === 'done') {
    log.push({
      mark: '✓',
      cls: 'ok',
      text: (
        <>
          落库 {fmtInt(shown.total)} 条 · {fmtInt(shown.problems)} 道去重题 · {fmtInt(shown.ratingContests)} 场 rating 变化
        </>
      ),
    });
  }
  if (syncErr) log.push({ mark: '■', text: <span style={{ color: 'var(--bad)' }}>{syncErr}</span> });

  const done =
    shown && shown.phase === 'done'
      ? shown
      : {
          total: status?.counts.submissions ?? 0,
          problems: status?.counts.problems ?? 0,
          ratingContests: 0,
          offsite: 0,
          pages: 0,
          stored: 0,
          fetched: 0,
          phase: 'done' as const,
        };

  const pct = !shown
    ? 0
    : shown.phase === 'done'
      ? 100
      : Math.min(99, Math.round((shown.stored / Math.max(1, shown.total)) * 100));

  return (
    <div className="content" style={{ maxWidth: 760 }}>
      <div className="steps">
        {['输入 handle', '校验', '全量同步', '完成'].map((label, idx) => {
          const i = idx + 1;
          const cls = `step${i === step ? ' is-on' : i < step ? ' is-done' : ''}`;
          return (
            <Fragment key={label}>
              <div className={cls}>
                <b>{i < step ? '✓' : i}</b>
                {label}
              </div>
              {i < 4 ? <span className="step__bar" /> : null}
            </Fragment>
          );
        })}
      </div>

      <div className="card rise" style={{ padding: 'var(--sp-3)' }}>
        {phase === 'input' || phase === 'checking' ? (
          <div>
            <span className="label label--accent" style={{ marginBottom: 10 }}>
              Step 1
            </span>
            <h3 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>接上你的 Codeforces</h3>
            <p className="dim" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.7 }}>
              只要 handle —— 不要密码、不要 token，数据不离开这台机器。
            </p>
            <div className="field" style={{ marginTop: 'var(--sp-3)' }}>
              <label className="label" htmlFor="handleIn">
                CF handle
              </label>
              <div className="field__row">
                <input
                  className={`input${checkErr ? ' input--err' : ''}`}
                  id="handleIn"
                  value={handle}
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby="handleHint"
                  onChange={(e) => setHandle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void check();
                    }
                  }}
                />
                <button className="btn btn--primary" style={{ flex: '0 0 auto' }} disabled={busy} onClick={() => void check()}>
                  <Icon id="i-arrow" />
                  校验 handle
                </button>
              </div>
              <p className="hint" id="handleHint">
                区分大小写 · 与 CF 主页 URL 里 <code>/profile/</code> 后面那一段一致
              </p>
            </div>

            <div style={{ marginTop: 'var(--sp-2)' }}>
              {phase === 'checking' ? (
                <div className="prow" style={{ color: 'var(--text-mute)' }}>
                  <span className="run">正在校验</span>…
                </div>
              ) : null}
              {checkErr ? (
                <div className="alert alert--err">
                  <Icon id="i-x" />
                  <div>
                    {checkErr.kind === 'not-found' ? (
                      <>
                        <b>未找到 handle “{handle.trim()}”</b>
                        <br />
                        Codeforces 返回：<code>{checkErr.message}</code>
                        <br />
                        下一步：核对 CF 主页 <code>/profile/</code> 后那一段；<b>大小写敏感</b>，不要带空格。
                      </>
                    ) : (
                      <>
                        <b>校验失败</b>
                        <br />
                        {checkErr.message}
                        <br />
                        下一步：确认这台机器能上 codeforces.com，稍后再试。
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="plog" style={{ marginTop: 'var(--sp-3)', minHeight: 'auto', lineHeight: 2.1 }}>
              预计约 8 秒 · 限速 <b>1 请求 / 2 秒</b>
              <br />
              断网也能打开：读本地缓存 + 明确提示，不崩。
            </div>
          </div>
        ) : null}

        {phase === 'ready' || phase === 'syncing' ? (
          <div>
            <span className="label label--accent" style={{ marginBottom: 10 }}>
              Step 3
            </span>
            <h3 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>
              {phase === 'syncing' ? (shown?.phase === 'storing' ? '正在写入本地' : '正在拉取历史') : '准备同步'}
            </h3>
            <p className="dim" style={{ fontSize: 13, marginTop: 8 }}>
              <code>{handle.trim()}</code> · {hasData ? '从上次停下的地方接着拉' : '从第 1 条开始，一页 10 000 条'}
            </p>
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <div className="bar">
                <i style={{ width: `${pct}%` }} />
              </div>
              <div className="prow" style={{ marginTop: 10, justifyContent: 'space-between' }}>
                <span>
                  {shown && phase === 'syncing'
                    ? `已拉取 ${fmtInt(shown.fetched)} 条 / 约 ${fmtInt(shown.total)} 条 · 第 ${shown.pages} 页`
                    : '待开始'}
                </span>
                <span>{pct}%</span>
              </div>
            </div>
            <div className="plog" role="status" aria-live="polite">
              {log.map((l, i) => (
                <div className="prow" key={i}>
                  <span className={l.cls}>{l.mark}</span> {l.text}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 'var(--sp-2)', display: 'flex', gap: 'var(--sp-1)' }}>
              <button className="btn" disabled={phase === 'syncing'} onClick={() => void run()}>
                <Icon id="i-sync" />
                {hasData ? '拉取增量' : '开始全量同步'}
              </button>
              {phase === 'syncing' ? <button className="btn btn--ghost" disabled>同步进行中…</button> : null}
            </div>
          </div>
        ) : null}

        {phase === 'done' ? (
          <div>
            <span className="label" style={{ color: 'var(--ok)', marginBottom: 10 }}>
              Done
            </span>
            <h3 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>炉子点着了</h3>
            <div className="alert alert--ok" style={{ marginTop: 14 }}>
              <Icon id="i-check" />
              <div>
                写入 <b>{fmtInt(done.total)}</b> 条提交 · <b>{fmtInt(done.problems)}</b> 道去重题 ·{' '}
                <b>{fmtInt(done.ratingContests)}</b> 场 rating 变化
                <br />
                已存 <code>vault/anvil.db</code>（WAL）· 下次启动只拉增量
              </div>
            </div>
            <div style={{ display: 'flex', gap: 'var(--sp-1)', marginTop: 'var(--sp-3)' }}>
              <button className="btn btn--primary btn--lg" onClick={onEnterDashboard}>
                <Icon id="i-dash" />
                进入仪表盘
              </button>
              <button className="btn btn--lg" onClick={() => void run()}>
                再同步一次
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
