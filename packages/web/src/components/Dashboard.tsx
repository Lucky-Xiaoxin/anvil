import type { CSSProperties } from 'react';
import type { DashboardDto, StatusDto } from '@anvil/shared';
import { fmtInt } from '../format.ts';
import { ActivityGrid } from './ActivityGrid.tsx';
import { RatingChart } from './RatingChart.tsx';
import { Delta, Icon, MonthlyBars, Num, StreakTicks } from './ui.tsx';

export interface Notice {
  kind: 'err' | 'ok';
  text: string;
}

const sc = (v: string): CSSProperties => ({ '--sc': v }) as CSSProperties;

export function LockedMaster({ wide = false }: { wide?: boolean }) {
  return (
    <div className="locked rise" style={wide ? { padding: 'var(--sp-3)' } : undefined}>
      <Icon id={wide ? 'i-lock' : 'i-map'} style={wide ? { width: 24, height: 24 } : undefined} />
      <div>
        <div className="locked__t" style={wide ? { fontSize: 15 } : undefined}>
          掌握图 <span className="tag">{wide ? '切片 3' : '未解锁'}</span>
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
        {wide ? null : <div className="locked__go">切片 3</div>}
      </div>
    </div>
  );
}

export function LockedVp({ wide = false }: { wide?: boolean }) {
  return (
    <div className="locked rise" style={wide ? { padding: 'var(--sp-3)' } : undefined}>
      <Icon id={wide ? 'i-lock' : 'i-vp'} style={wide ? { width: 24, height: 24 } : undefined} />
      <div>
        <div className="locked__t" style={wide ? { fontSize: 15 } : undefined}>
          VP <span className="tag">{wide ? '切片 4' : '未解锁'}</span>
        </div>
        <p className="locked__p">
          {wide ? (
            <>
              拿一份历年榜单，把<b>当时真实的名次</b>叠回你这一场 —— 幽灵队伍、自动罚时、含打星排名。
            </>
          ) : (
            <>拿一份历年榜单，把当时的真实名次<em>叠回你这一场</em>。</>
          )}
        </p>
        {wide ? null : <div className="locked__go">切片 4</div>}
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

interface Props {
  dash: DashboardDto;
  today: Date;
  notice?: Notice | null;
}

export function Dashboard({ dash, today, notice }: Props) {
  const { activity, stats, rating } = dash;
  const currentMonth = stats.months[stats.months.length - 1];

  return (
    <div className="content">
      {notice ? <NoticeBar {...notice} /> : null}

      <div className="grid-4">
        <div className="stat" style={sc('var(--heat-3)')}>
          <div className="label stat__label">总过题数 · 去重</div>
          <div className="stat__num">
            <Num to={stats.totalSolved} />
            <span className="stat__unit">题</span>
          </div>
        </div>

        <div className="stat" style={sc('var(--accent-2)')}>
          <div className="label label--blue stat__label">当月过题</div>
          <div className="stat__num stat__num--blue">
            <Num to={currentMonth ? currentMonth.solved : null} />
            <span className="stat__unit">题</span>
          </div>
          <MonthlyBars months={stats.months} />
        </div>

        <div className="stat" style={sc('var(--accent-2)')}>
          <div className="label label--blue stat__label">CF Rating</div>
          <div className="stat__num stat__num--blue">
            <Num to={rating ? rating.current : null} />
            <span className="stat__unit">{rating ? rating.rankLabel : '—'}</span>
          </div>
          <div className="stat__sub">
            最高 <b className="num" style={{ color: 'var(--text-dim)' }}>{rating ? fmtInt(rating.max) : '—'}</b>
            <Delta text={rating?.lastDeltaText} tone={rating?.lastDeltaTone} />
            <span className="mute" title="上一场">
              {rating ? rating.lastContestShort : '—'}
            </span>
          </div>
        </div>

        <div className="stat" style={sc('var(--accent)')}>
          <div className="label label--accent stat__label">连续训练</div>
          <div className="stat__num stat__num--hot">
            <Num to={stats.streak.days} />
            <span className="stat__unit">天</span>
          </div>
          <div className="stat__sub">{stats.streak.sub}</div>
          <StreakTicks activity={activity} />
        </div>
      </div>

      <div className="card card--pad0 rise">
        <div className="card__head">
          <span className="label label--accent">Activity</span>
          <h3 className="card__title">活跃格子图</h3>
          <span className="spacer" />
          <span className="card__note">
            近 53 周 <b>{fmtInt(stats.activityTotal)}</b> 题次 · 生涯去重 <b>{fmtInt(stats.totalSolved)}</b> 题
          </span>
          <span className="legend" aria-hidden="true" style={{ marginLeft: 14 }}>
            少
            <i style={{ background: 'var(--heat-0)' }} />
            <i style={{ background: 'var(--heat-1)' }} />
            <i style={{ background: 'var(--heat-2)' }} />
            <i style={{ background: 'var(--heat-3)' }} />
            <i style={{ background: 'var(--heat-4)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.3)' }} />
            多
          </span>
        </div>
        <div className="agrid-body">
          <div className="agrid-scroll">
            <ActivityGrid activity={activity} today={today} totalLabel={stats.activityTotal} />
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
          <span className="card__note">日格 = 当日 AC 去重题数</span>
        </div>
      </div>

      <div className="row-split">
        <div className="card rise" style={{ paddingBottom: 18 }}>
          <div className="card__head" style={{ padding: '0 0 4px' }}>
            <span className="label label--blue">Rating</span>
            <h3 className="card__title">近 {rating ? fmtInt(rating.count) : '—'} 场</h3>
            <span className="spacer" />
            <span className="card__note">
              <b style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{rating ? rating.first : '—'}</b> →{' '}
              <b>{rating ? rating.current : '—'}</b> ·{' '}
              <span style={{ fontSize: '10.5px' }}>
                <Delta text={rating?.totalDelta} tone={rating?.totalDeltaTone} />
              </span>
            </span>
          </div>
          {rating ? <RatingChart series={rating.series} /> : <p className="hint">还没有 rating 记录。</p>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <LockedMaster />
          <LockedVp />
        </div>
      </div>
    </div>
  );
}

interface ColdProps {
  dash: DashboardDto | null;
  status: StatusDto;
  today: Date;
  notice?: Notice | null;
  onGoSettings: () => void;
}

/** 未配置 handle：空态 + 幽灵格子图 + 两张未解锁 */
export function ColdStart({ dash, status, today, notice, onGoSettings }: ColdProps) {
  return (
    <div className="content">
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
          {status.counts.submissions > 0 ? (
            <p className="hint">
              本地已有 <b className="num">{fmtInt(status.counts.submissions)}</b> 条提交 · 配好 handle 直接看图。
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

      <div className="grid-4" style={{ gridTemplateColumns: 'repeat(2,minmax(0,1fr))' }}>
        <LockedMaster wide />
        <LockedVp wide />
      </div>
    </div>
  );
}
