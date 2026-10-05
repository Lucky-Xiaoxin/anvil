import { useEffect, useState } from 'react';
import { rankColorFor, type StatusDto, type SyncSourceId, type SyncStatesDto } from '@anvil/shared';
import { ApiError, saveHandles, SOURCE_NAME } from '../api.ts';
import { fmtInt, fullStamp, messageOf, relativeTime } from '../format.ts';
import { Icon } from './ui.tsx';

const KEYS: Record<SyncSourceId, 'cfHandle' | 'atHandle'> = { cf: 'cfHandle', at: 'atHandle' };
const DOT: Record<string, string> = { ok: 'dot--ok', stale: 'dot--stale', down: 'dot--down', idle: 'dot--idle' };
const STATE_TEXT: Record<string, string> = {
  ok: '源正常',
  stale: '缓存过期',
  down: '源不可达',
  idle: '未同步过',
};

interface Props {
  status: StatusDto;
  states: SyncStatesDto | null;
  busy: Record<SyncSourceId, boolean>;
  onStatus: (status: StatusDto) => void;
  /** 起跑并轮询到落定 */
  onRun: (source: SyncSourceId) => Promise<void>;
}

function Row({ source, status, states, busy, onStatus, onRun }: Props & { source: SyncSourceId }) {
  const src = status.sources[source];
  const [input, setInput] = useState(src.handle ?? '');
  const [err, setErr] = useState<{ kind: string; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setInput(src.handle ?? '');
  }, [src.handle]);

  const sync = states?.[source];
  const running = busy[source];
  // 空/纯空白不算 dirty：否则「校验」按钮点下去是静默 no-op（check() 会直接 return）
  const dirty = input.trim() !== '' && input.trim() !== (src.handle ?? '');

  async function check() {
    const name = input.trim();
    if (name === '' || name === src.handle) return;
    setChecking(true);
    setErr(null);
    try {
      onStatus(await saveHandles({ [KEYS[source]]: name }));
    } catch (e) {
      const api = e instanceof ApiError ? e : new ApiError(messageOf(e));
      setErr({ kind: api.kind, message: api.message });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="srcrow">
      <div className="srcrow__head">
        <i className={`dot ${DOT[src.status] ?? 'dot--idle'}`} />
        <span className="srcrow__name">{SOURCE_NAME[source]}</span>
        {src.rating !== null ? (
          <span className="srcrow__meta" style={{ color: rankColorFor(src.rating, source) }}>
            {src.rating}
          </span>
        ) : null}
        <span className="srcrow__spacer" />
        <button
          className={`btn btn--sm${running ? ' is-busy' : ''}`}
          disabled={!src.configured || running}
          onClick={() => void onRun(source)}
        >
          <Icon id="i-sync" />
          {running ? '拉取中…' : '同步本源'}
        </button>
      </div>

      <div className="field__row">
        <input
          className={`input${err ? ' input--err' : ''}`}
          style={{ height: 34, fontSize: 13 }}
          value={input}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${SOURCE_NAME[source]} handle`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void check();
            }
          }}
        />
        <button className="btn btn--sm" style={{ flex: '0 0 auto' }} disabled={checking || !dirty} onClick={() => void check()}>
          <Icon id="i-arrow" />
          {checking ? '校验中…' : '校验并保存'}
        </button>
      </div>

      <div className="srcrow__meta">
        <span>{STATE_TEXT[src.status] ?? '未配置'}</span>
        <span>·</span>
        <span>
          上次同步 <b>{src.lastSyncAt === null ? '从未' : `${relativeTime(src.lastSyncAt)}（${fullStamp(src.lastSyncAt)}）`}</b>
        </span>
        <span>·</span>
        <span>
          <b className="num">{fmtInt(src.counts.submissions)}</b> 条提交 ·{' '}
          <b className="num">{fmtInt(src.counts.problems)}</b> 题
        </span>
        {source === 'at' ? (
          <>
            <span>·</span>
            <span>不自动同步，只在你点击时发请求</span>
          </>
        ) : null}
      </div>

      {running && sync ? (
        <div className="srcrow__meta">
          <span className="run">
            {sync.phase === 'storing' ? '正在写入本地' : '正在拉取'} · 已存 <b className="num">{fmtInt(sync.stored)}</b> /{' '}
            约 <b className="num">{fmtInt(sync.total)}</b> 条
          </span>
        </div>
      ) : null}

      {src.error && src.status === 'down' && !running ? (
        <div className="alert alert--err">
          <Icon id="i-x" />
          <div>{src.error}</div>
        </div>
      ) : null}

      {err ? (
        <div className="alert alert--err">
          <Icon id="i-x" />
          <div>
            <b>校验失败</b>
            <br />
            {err.message}
            <br />
            下一步：核对 {SOURCE_NAME[source]} 主页 <code>/profile/</code> 或 <code>/users/</code> 后那一段；大小写敏感，不要带空格。
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 设置页两行：CF / AT，各含 handle 输入、校验、源状态、上次同步、单源同步按钮（docs/09 §3.2） */
export function Settings(props: Props) {
  return (
    <div className="content" style={{ maxWidth: 760 }}>
      <div className="card rise" style={{ padding: 'var(--sp-3)' }}>
        <div className="srcrows">
          <Row source="cf" {...props} />
          <Row source="at" {...props} />
        </div>
        <p className="footnote" style={{ marginTop: 'var(--sp-2)', borderTop: '1px solid var(--line-soft)', paddingTop: 'var(--sp-2)' }}>
          时区口径：Asia/Shanghai（固定）
        </p>
      </div>
    </div>
  );
}
