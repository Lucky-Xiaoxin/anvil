/** 接口契约（docs/09 §4，继承 docs/04 §4.4）：字段名与视觉基线的 data-bind 一一对应。 */

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
