/** 接口契约（docs/04 §4.4）：字段名与视觉基线的 data-bind 一一对应。 */

export interface StatusDto {
  configured: boolean;
  handle: string | null;
  /** epoch 秒；成品串由前端按此格式化，接口不给（会过期） */
  lastSyncAt: number | null;
  counts: { submissions: number; problems: number };
}

export type SyncPhase = 'idle' | 'fetching' | 'storing' | 'done' | 'error';

export interface SyncStateDto {
  phase: SyncPhase;
  fetched: number;
  stored: number;
  error?: string;
  total: number;
  pages: number;
  problems: number;
  ratingContests: number;
  /** 哨兵值转 NULL 的场外提交数 */
  offsite: number;
}

export interface ActivityCellDto {
  /** 本地日 "YYYY-MM-DD"；数组缺项 = 那天还没到 */
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
}

export interface RatingPointDto {
  ts: string;
  newRating: number;
  contestName: string;
  delta: number;
}

export interface RatingDto {
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
}

export interface DashboardDto {
  activity: ActivityCellDto[];
  stats: StatsDto;
  rating: RatingDto | null;
}

/** 一条 AC 事件：本地日 + 去重题键 */
export interface AcEvent {
  day: string;
  problemKey: string;
}

/** rating_history 行 */
export interface RatingRow {
  contestId: number;
  contestName: string;
  rank: number;
  oldRating: number;
  newRating: number;
  updatedTs: number;
}
