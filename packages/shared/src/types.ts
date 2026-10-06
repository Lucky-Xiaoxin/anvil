/** 接口契约（docs/09 §4，继承 docs/04 §4.4；XCPC 段见 docs/14 §2/§4）：字段名与视觉基线的 data-bind 一一对应。 */

export type SyncSourceId = 'cf' | 'at';

/** 仪表盘可寻址的源：xcpc 只有占位屏，没有数据 */
export type SourceId = SyncSourceId | 'xcpc';

/**
 * 源状态点四态（docs/09 §1.1 / mock-02 屏 4）：
 * idle = 未配置，down = 最近一次同步没打通，stale = 缓存过期，ok = 正常。
 */
export type SourceState = 'ok' | 'stale' | 'down' | 'idle';

/** 单个源的读数：tab 条与设置页两行共用 */
export interface SourceStatusDto {
  configured: boolean;
  handle: string | null;
  /** epoch 秒；成品串由前端按此格式化，接口不给（会过期） */
  lastSyncAt: number | null;
  counts: { submissions: number; problems: number };
  status: SourceState;
  /** 最近一次同步的失败原因；成功为 null。降级条与 tooltip 用 */
  error: string | null;
  /** tab 条次行的当前 rating；没打过比赛 → null → 渲染 — 。段位色名由前端按 source 走 rankLabelFor() */
  rating: number | null;
}

export interface StatusDto {
  /** 顶层四字段 = CF 源的原样镜像，保持切片 1 兼容（docs/09 §4） */
  configured: boolean;
  handle: string | null;
  lastSyncAt: number | null;
  counts: { submissions: number; problems: number };
  sources: Record<SyncSourceId, SourceStatusDto>;
  /** XCPC 走认领而非 handle，不进 `sources`（它没有提交粒度、也不跑 /api/sync runner） */
  xcpc: XcpcStatusDto;
}

export type SyncPhase = 'idle' | 'fetching' | 'storing' | 'done' | 'error';

export interface SyncStateDto {
  phase: SyncPhase;
  fetched: number;
  stored: number;
  error?: string;
  total: number;
  problems: number;
  ratingContests: number;
  /** CF 专有：user.status 已拉页数。AT 每请求 500 条，页数对用户没意义 → 不出这个键 */
  pages?: number;
  /** CF 专有：哨兵值转 NULL 的场外提交数。AT 无此概念 → 不出这个键 */
  offsite?: number;
  /** 换 handle 时清空重建的说明；没换人则为 null */
  resetNote?: string | null;
}

/** GET /api/sync/state 按源分列（docs/09 §4）：单源失败不牵连另一源 */
export interface SyncStatesDto {
  cf: SyncStateDto;
  at: SyncStateDto;
}

export interface ActivityCellDto {
  /** 上海日 "YYYY-MM-DD"；数组缺项 = 那天还没到 */
  day: string;
  solved: number;
}

export interface MonthBucketDto {
  month: string;
  solved: number;
  partial: boolean;
}

export interface StreakDto {
  days: number;
  sub: string;
}

export interface LongestRunDto {
  days: string;
  range: string;
}

export interface StatsDto {
  totalSolved: number;
  /** 题次：格子求和，与 totalSolved 无加法关系 */
  activityTotal: number;
  months: MonthBucketDto[];
  streak: StreakDto;
  longestRun: LongestRunDto;
  gaps3: string;
  weekendPct: string | null;
  emptyCells: string;
  /** AT 专有：「参赛 18 场 · 非 rated 2 场」成品串（docs/09 §4/§5）。CF 不出这个键 */
  entryCount?: string;
}

export interface RatingPointDto {
  ts: string;
  newRating: number;
  contestName: string;
  delta: number;
  /** 非 rated 场不入曲线，只计参赛数（docs/09 §2） */
  isRated: boolean;
  /** AT 专有：本场上游名次；CF 无此字段 → null */
  place?: number | null;
  /** AT 专有：本场 Performance；非 rated 上游给 0 → 转 null */
  performance?: number | null;
}

export interface RatingDto {
  /** 曲线点数 = rated 场次 */
  count: number;
  current: number;
  first: number;
  max: number;
  rankLabel: string;
  totalDelta: string;
  totalDeltaTone: number;
  lastDeltaText: string;
  lastDeltaTone: number;
  lastContestShort: string;
  lastContest: string;
  series: RatingPointDto[];
  /** AT 专有：诚实标注一行（docs/09 §5）。CF 无 → null */
  note: string | null;
}

export interface DashboardDto {
  activity: ActivityCellDto[];
  stats: StatsDto;
  rating: RatingDto | null;
}

/** 一条 AC 事件：上海日 + 去重题键 */
export interface AcEvent {
  day: string;
  problemKey: string;
}

/** rating_history 行（docs/09 §3.1） */
export interface RatingRow {
  /** CF: "2268" / AT: "abc300" */
  contestKey: string;
  contestName: string;
  /** AT 的 Place；未上榜为 null */
  rank: number | null;
  oldRating: number;
  newRating: number;
  isRated: boolean;
  /** 非 rated 上游给 0 → 转 null */
  performance: number | null;
  updatedTs: number;
}

/* ==========================================================================
   XCPC（切片 3 · docs/14）—— 选手档案走社区快照，不进 CF/AT 那套提交/rating 表
   ========================================================================== */

export type XcpcTier = 'final' | 'regional' | 'invitational' | 'provincial';

export type XcpcMetal = 'gold' | 'silver' | 'bronze';

/**
 * tier 与金属的固定序：荣誉陈列的行序、勋章的摆序、medals 桶的归一化都读这两张表。
 * 契约口径（docs/14 §2.3 / §5.3），服务端与前端共用一份，免得两边各写一遍走岔。
 */
export const XCPC_TIERS: readonly XcpcTier[] = ['final', 'regional', 'invitational', 'provincial'];
export const XCPC_METALS: readonly XcpcMetal[] = ['gold', 'silver', 'bronze'];

/** 搜索分片的一行（docs/14 §2 紧凑行 `[key,name,org,contests]`） */
export interface XcpcSearchRow {
  key: string;
  name: string;
  org: string;
  contests: number;
}

/** 聚合奖牌桶：零奖牌 tier 上游整个省略，无奖牌者整字段省略 → 读时 defensive */
export type XcpcMedals = Partial<Record<XcpcTier, Partial<Record<XcpcMetal, number>>>>;

/**
 * 逐场一行，服务端只做完官方单口径映射（docs/14 §4）：
 * `rank/teams/rankPercent/perf/ratingAfter` 取的是 `*Official` 套装，打星场（`star`）整组为 null。
 * 数值原样给 —— 取整与百分比格式都是前端的显示口径。
 */
export interface XcpcHistoryRow {
  contestId: string;
  title: string;
  /** 上游原样 +08:00 ISO 串；日期取前 10 位，不做时区换算 */
  startAt: string;
  teamName: string;
  /** 上游只有四档 tier，但真实数据里存在缺失行 → null → 界面给「—」 */
  tier: XcpcTier | null;
  /**
   * 网络赛。上游把网络预选赛归进 `regional`，所以这不是第五档 tier，而是**并列的一枚标签**。
   * 判据 = contestId 含 `preliminary` 且标题含「网络」/ `Online`：单看 contestId 会把
   * 「广东省赛预赛」「安徽初赛」也标成网络赛（实测该分片 189 条里 7 条是这种）。
   */
  online: boolean;
  solved: number;
  star: boolean;
  rank: number | null;
  teams: number | null;
  rankPercent: number | null;
  perf: number | null;
  ratingAfter: number | null;
  /** 罚时比 / 首 A / 末小时：非官方榜字段，打星行照给 */
  dirt: number | null;
  firstATime: number | null;
  lastHourSolved: number | null;
}

export interface XcpcPlayerDto {
  key: string;
  name: string;
  org: string;
  contests: number;
  /** 官方榜口径读数；当前分显示的是 officialRating 取整 */
  officialRating: number;
  officialRank: number;
  medals: XcpcMedals;
  /** 升序（上游即升序） */
  history: XcpcHistoryRow[];
}

/** 档案载荷：GET /api/xcpc、claim 成功、refresh 成功三处共用（docs/14 §4） */
export interface XcpcProfileDto {
  player: XcpcPlayerDto;
  /** 上游 meta.json 的 generatedAt 原样串；展示取日期部分 */
  snapshotAt: string | null;
  /** 本地拉取时刻（epoch 秒）；与「数据版本」分开记、分开显 */
  fetchedAt: number | null;
  /** 官方榜分母；取不到 → null → 显示 — */
  rankTotal: number | null;
}

/** refresh 载荷：`updated:false` = 快照版本没变，只动了上次同步时刻 */
export interface XcpcRefreshDto extends XcpcProfileDto {
  updated: boolean;
  status: SourceState;
}

/** XCPC 的源读数：`fetchedAt`/`snapshotAt` 两钟口径 separate（docs/14 §2.4） */
export interface XcpcStatusDto {
  claimed: boolean;
  key: string | null;
  officialRating: number | null;
  snapshotAt: string | null;
  fetchedAt: number | null;
  status: SourceState;
  error: string | null;
}
