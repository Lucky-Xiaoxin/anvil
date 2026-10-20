import type { SyncSourceId, StatusDto } from '@anvil/shared';
import { rankColorFor, type DashboardDto } from '@anvil/shared';
import { fmtInt, relativeTime, shortStamp } from '../format.ts';
import { ActivityGrid } from './ActivityGrid.tsx';
import { RatingChart } from './RatingChart.tsx';
import { Delta, Icon, MonthlyBars, Num, StreakTicks } from './ui.tsx';

export interface Notice {
  kind: 'err' | 'ok';
  text: string;
}

const NAME: Record<SyncSourceId, string> = { cf: 'Codeforces', at: 'AtCoder' };

export function LockedMaster({ wide = false }: { wide?: boolean }) {
  return (
    <div className="locked rise" style={wide ? { padding: 'var(--sp-3)' } : undefined}>
      <Icon id={wide ? 'i-lock' : 'i-map'} style={wide ? { width: 24, height: 24 } : undefined} />
      <div>
        <div className="locked__t" style={wide ? { fontSize: 15 } : undefined}>
          工坊 <span className="tag">{wide ? '切片 5' : '未解锁'}</span>
        </div>
        <p className="locked__p">
          {wide ? (
            <>
              把你做过的题铺成一张<em>技能图</em>：颜色 = 你在这个节点上<b>稳定做得出来</b>的难度，不是玄学总分。
            </>
          ) : (
            <>把你做过的题铺成一张<em>技能图</em>。</>
          )}
        </p>
        {wide ? null : <div className="locked__go">切片 5</div>}
      </div>
    </div>
  );
}

export function NoticeBar(notice: Notice) {
  return (
    <div className={`alert alert--${notice.kind}`} role="status">
      <Icon id={notice.kind === 'err' ? 'i-x' : 'i-check'} />
      <div>{notice.text}</div>
    </div>
  );
}

/** 源异常才出现的降级条：一句话只讲"现在看到的是缓存"，行末留一个动作 */
function DegradeBar({ source, src, onSync }: { source: SyncSourceId; src: StatusDto['sources']['at']; onSync: () => void }) {
  const cacheLine =
    src.lastSyncAt === null ? '还没有可用缓存' : `显示本地缓存（${shortStamp(src.lastSyncAt)}）· 取不到的槽位显示 —`;

  if (src.status === 'down') {
    return (
      <div className="alert alert--warn rise" role="status">
        <Icon id="i-plug" />
        <div>
          <b>{NAME[source]} 同步失败</b> · {cacheLine}
          <br />
          {src.error}
        </div>
        <button className="alert__x" onClick={onSync}>
          重试
        </button>
      </div>
    );
  }
  return (
    <div className="alert alert--warn rise" role="status">
      <Icon id="i-warn" />
      <div>
        <b>
          缓存于 {src.lastSyncAt === null ? '—' : shortStamp(src.lastSyncAt)}（{relativeTime(src.lastSyncAt)}）
        </b>{' '}
        · {source === 'at' ? 'AT 不自动同步，' : ''}需要你点一次同步
      </div>
      <button className="alert__x" onClick={onSync}>
        立即同步
      </button>
    </div>
  );
}

interface Props {
  source: SyncSourceId;
  dash: DashboardDto;
  today: Date;
  notice?: Notice | null;
  /** 首次出现才播格子 stagger 与数字 count-up；换屏回来时图里已是终态 */
  firstPaint: boolean;
  srcStatus: StatusDto['sources']['at'] | null;
  onSync: () => void;
}

export function Dashboard({ source, dash, today, notice, firstPaint, srcStatus, onSync }: Props) {
  const { activity, stats, rating } = dash;
  const currentMonth = stats.months[stats.months.length - 1];
  const rankColor = rating ? rankColorFor(rating.current, source) : undefined;
  const animate = firstPaint;
  const warn =
    srcStatus && (srcStatus.status === 'down' || srcStatus.status === 'stale') ? (
      <DegradeBar source={source} src={srcStatus} onSync={onSync} />
    ) : null;

  return (
    <div className="content" id={`content-${source}`} role="tabpanel">
      {notice ? <NoticeBar {...notice} /> : null}
      {warn}

      <div className="grid-4">
        <div className="stat">
          <div className="label stat__label">总过题数 · 去重</div>
          <div className="stat__num">
            <Num to={stats.totalSolved} instant={!animate} />
            <span className="stat__unit">题</span>
          </div>
          {source === 'at' ? <div className="stat__sub2">首次 AC 计一道</div> : null}
        </div>

        <div className="stat">
          <div className="label label--blue stat__label">当月过题</div>
          <div className="stat__num stat__num--blue">
            <Num to={currentMonth ? currentMonth.solved : null} instant={!animate} />
            <span className="stat__unit">题</span>
          </div>
          <MonthlyBars months={stats.months} />
        </div>

        <div className="stat">
          <div className="label stat__label">{source === 'at' ? 'AT Rating' : 'CF Rating'}</div>
          <div className="stat__num" style={rankColor ? { color: rankColor } : undefined}>
            <Num to={rating ? rating.current : null} instant={!animate} />
            <span className="stat__unit" style={rankColor ? { color: rankColor } : undefined}>
              {rating ? rating.rankLabel : '—'}
            </span>
          </div>
          <div className="stat__sub">
            最高 <b className="num" style={{ color: 'var(--text-dim)' }}>{rating ? fmtInt(rating.max) : '—'}</b>
            <Delta text={rating?.lastDeltaText} tone={rating?.lastDeltaTone} />
            <span className="mute" title="上一场">
              {rating ? rating.lastContestShort : '—'}
            </span>
          </div>
          {stats.entryCount ? <div className="stat__sub2">{stats.entryCount}</div> : null}
        </div>

        <div className="stat">
          <div className="label label--accent stat__label">连续训练</div>
          <div className="stat__num stat__num--hot">
            <Num to={stats.streak.days} instant={!animate} />
            <span className="stat__unit">天</span>
          </div>
          <div className="stat__sub">{stats.streak.sub}</div>
          <StreakTicks activity={activity} />
        </div>
      </div>

      <div className="card card--pad0 rise">
        <div className="card__head">
          <span className="label label--pf">Activity</span>
          <h3 className="card__title">活跃格子图 · {NAME[source]}</h3>
          <span className="spacer" />
          <span className="card__note">
            近 53 周 <b>{fmtInt(stats.activityTotal)}</b> 题次 · 生涯去重 <b>{fmtInt(stats.totalSolved)}</b> 题
          </span>
          <span className="legend" aria-hidden="true" style={{ marginLeft: 14 }}>
            少
            {source === 'at'
              ? ['#17262B', '#1E4A50', '#0E6A6E', '#0E9EA4', 'var(--pf-at)'].map((c, i) => (
                  <i
                    key={c}
                    style={{
                      background: c,
                      boxShadow: i === 4 ? 'inset 0 1px 0 rgba(255,255,255,.3)' : undefined,
                    }}
                  />
                ))
              : [0, 1, 2, 3, 4].map((l) => (
                  <i
                    key={l}
                    style={{
                      background: `var(--heat-${l})`,
                      boxShadow: l === 4 ? 'inset 0 1px 0 rgba(255,255,255,.3)' : undefined,
                    }}
                  />
                ))}
            多
          </span>
        </div>
        <div className="agrid-body">
          <div className="agrid-scroll">
            <ActivityGrid
              activity={activity}
              today={today}
              totalLabel={stats.activityTotal}
              alt={source === 'at'}
              stagger={animate}
            />
          </div>
          <div className="readout">
            <div className="ro">
              <span className="ro__k">最长连续</span>
              <b className="ro__v">{stats.longestRun.days}</b>
              <span className="ro__n">{stats.longestRun.range}</span>
            </div>
            <div className="ro">
              <span className="ro__k">断档 ≥3 天</span>
              <b className="ro__v">{stats.gaps3}</b>
            </div>
            <div className="ro">
              <span className="ro__k">周末占比</span>
              <b className="ro__v">{stats.weekendPct ?? '—'}</b>
            </div>
          </div>
        </div>
        <div className="afoot">
          <span className="card__note">日格 = 当日 AC 去重题数 · 两源共用同一把阈值</span>
        </div>
      </div>

      <div className="card rise" style={{ paddingBottom: rating?.note ? 0 : 18 }}>
        <div className="card__head" style={{ padding: '0 0 4px' }}>
          <span className="label label--pf">Rating</span>
          <h3 className="card__title">{source === 'at' ? `全 ${rating ? fmtInt(rating.count) : '—'} 场 rated` : `近 ${rating ? fmtInt(rating.count) : '—'} 场`}</h3>
          <span className="spacer" />
          <span className="card__note">
            <b style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{rating ? rating.first : '—'}</b> →{' '}
            <b>{rating ? rating.current : '—'}</b> ·{' '}
            <span style={{ fontSize: '10.5px' }}>
              <Delta text={rating?.totalDelta} tone={rating?.totalDeltaTone} />
            </span>
          </span>
        </div>
        {rating ? <RatingChart series={rating.series} withPlace={source === 'at'} /> : <p className="hint">还没有 rating 记录。</p>}
        {rating?.note ? (
          <div className="card__foot">
            <span>{rating.note}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ColdProps {
  /** 当前选中的源：面板 id 必须跟着它走，否则 tab 的 aria-controls 指不到、落地也找不到节点 */
  source: SyncSourceId;
  dash: DashboardDto | null;
  status: StatusDto;
  today: Date;
  notice?: Notice | null;
  onGoSettings: () => void;
}

/** 一个 handle 都没配：空态 + 幽灵格子图 + 两张未解锁 */
export function ColdStart({ source, dash, status, today, notice, onGoSettings }: ColdProps) {
  const total = status.sources.cf.counts.submissions + status.sources.at.counts.submissions;
  return (
    <div className="content" id={`content-${source}`} role="tabpanel">
      {notice ? <NoticeBar {...notice} /> : null}
      <div className="card rise" style={{ padding: 'var(--sp-3)' }}>
        <div className="empty-hero">
          <div>
            <span className="label label--accent" style={{ marginBottom: 12 }}>
              Cold start
            </span>
            <h3 className="hero-title">
              铁砧还没热。
              <br />
              给我 <em>一个 handle</em>，剩下的我自己拉。
            </h3>
          </div>
          <div className="onb">
            <div className="onb__i">
              <div className="onb__n">01</div>
              <div className="onb__t">填 CF handle</div>
              <div className="onb__p">不要密码、不要 token。10 秒。</div>
            </div>
            <div className="onb__i">
              <div className="onb__n">02</div>
              <div className="onb__t">拉全量历史</div>
              <div className="onb__p">公开接口分页拉取，进度实时可见。</div>
            </div>
            <div className="onb__i">
              <div className="onb__n">03</div>
              <div className="onb__t">回来看图</div>
              <div className="onb__p">第一天就有整张历史 —— 不用等它慢慢长。</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-1)', alignItems: 'center' }}>
            <button className="btn btn--primary btn--lg" onClick={onGoSettings}>
              <Icon id="i-arrow" />
              开始设置
            </button>
          </div>
          {total > 0 ? (
            <p className="hint">
              本地已有 <b className="num">{fmtInt(total)}</b> 条提交 · 配好 handle 直接看图。
            </p>
          ) : null}
        </div>
      </div>

      <div className="card card--pad0 rise">
        <div className="card__head">
          <span className="label">Activity</span>
          <h3 className="card__title">活跃格子图</h3>
          <span className="spacer" />
          <span className="card__note">0 题</span>
        </div>
        <div className="ghostgrid">
          <ActivityGrid activity={dash?.activity ?? []} today={today} ghost />
          <div className="ghostgrid__veil">
            <div>
              <p>
                <b>跑一次同步，这里会亮起来。</b>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 切片 4 已交付模拟榜单，这里只剩工坊一块未解锁 */}
      <div className="grid-4" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
        <LockedMaster wide />
      </div>
    </div>
  );
}

/** 该源没配 handle：空态 + 去设置 CTA（docs/contracts/09 §1.3） */
export function Unconfigured({ source, onGoSettings }: { source: SyncSourceId; onGoSettings: () => void }) {
  return (
    <div className="content" id={`content-${source}`} role="tabpanel">
      <div className="card rise" style={{ padding: 'var(--sp-3)', maxWidth: 720 }}>
        <span className="label label--pf">Unconfigured</span>
        <h3 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', marginTop: 12 }}>
          还没填 {NAME[source]} handle
        </h3>
        <p className="dim" style={{ fontSize: 13, lineHeight: 1.75, marginTop: 10 }}>
          填好之后点一次同步，这一屏的过题、活跃格子与 rating 曲线就都是它的了。不要密码、不要 token。
        </p>
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <button className="btn btn--primary btn--lg" onClick={onGoSettings}>
            <Icon id="i-arrow" />
            去设置
          </button>
        </div>
      </div>
    </div>
  );
}
