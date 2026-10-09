/**
 * 回放引擎（docs/16 §4）：纯函数、零依赖、零 DOM。
 *
 * 榜单不是「存下来的」，是按当前时刻从逐次提交**重建**出来的 —— 稿内参照实现（mock-04 的 s2 引擎）
 * 的口径整体移植，数据换成 srk.json 的真实形状（2026-10-09 实测）。
 *
 * 单位陷阱（§2 的实测更正）：`statuses[].time` 是 `[值, 单位]` 元组（实测秒），
 * `solutions[].time` 同样是元组但单位是毫秒；引擎内部一律折算成毫秒。
 */

/* ---------- 原始形状（只声明引擎要用的字段，其余原样透传不解读） ---------- */

export interface SrkSolution {
  result?: string | null;
  time?: unknown;
  language?: string;
}

export interface SrkStatus {
  result?: string | null;
  time?: unknown;
  tries?: number;
  solutions?: SrkSolution[];
}

export interface SrkProblem {
  alias?: string;
  title?: string;
  statistics?: { accepted?: number; submitted?: number };
}

export interface SrkUser {
  name?: string;
  id?: string;
  organization?: string;
  teamMembers?: { name?: string }[];
  official?: boolean;
}

export interface SrkRow {
  user?: SrkUser;
  statuses?: SrkStatus[];
}

export interface SrkContest {
  title?: { 'zh-CN'?: string; fallback?: string };
  startAt?: string;
  duration?: unknown;
  frozenDuration?: unknown;
}

export interface SrkSeries {
  title?: string;
  segments?: { title?: string; style?: string }[];
  rule?: {
    preset?: string;
    options?: {
      count?: { value?: number[] };
      ratio?: { value?: number[] };
      denom?: unknown;
      field?: string;
      includeOfficialOnly?: boolean;
    };
  };
}

export interface SrkDoc {
  contest?: SrkContest;
  problems?: SrkProblem[];
  rows?: SrkRow[];
  series?: SrkSeries[];
}

/* ---------- 时间单位 ---------- */

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `[值, 单位]` 元组 → 毫秒。裸数字按毫秒解读；读不懂 → 0 ——
 * 宁可把这格当作没发生过，也不把它插到一个猜出来的时刻上。
 */
export function toMs(input: unknown): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  if (Array.isArray(input)) {
    const n = Number(input[0]);
    if (!Number.isFinite(n)) return 0;
    const unit = typeof input[1] === 'string' ? input[1] : 'ms';
    return Math.round(n * (UNIT_MS[unit] ?? 1));
  }
  return 0;
}

/** 榜上的「分钟」读数：向下取整（ICPC 罚时口径） */
export const minutesOf = (ms: number): number => Math.floor(ms / 60_000);

/** 未声明封榜时长（实测常为 `[0,'h']`）时的缺省：最后 60 分钟（§4） */
export const DEFAULT_FREEZE_MS = 3_600_000;

/* ---------- 单元格状态 ---------- */

export type CellState = 'none' | 'pen' | 'ac' | 'fb' | 'frz' | 'ce';

export interface Cell {
  st: CellState;
  /** 时刻（毫秒）；`none` 为 0 */
  t: number;
  /** 次数读数：AC = 第几次过、罚时中 = 失败次数、冻结 = 全部活动次数 */
  n: number;
  /** AC 前的失败次数（罚时用） */
  fails: number;
  /** `cap` 之前的提交次数（列头「交 M」按同一个定格点累计） */
  nCap: number;
  /** 终榜 / 回顾专用：这一格发生在封榜段内、没有改变定格名次 */
  post: boolean;
}

export const EMPTY_CELL: Cell = { st: 'none', t: 0, n: 0, fails: 0, nCap: 0, post: false };

const isAccept = (r: string | null | undefined): boolean => r === 'AC' || r === 'FB';

/**
 * 没有 `solutions[]` 时的兜底读数（实测约 1/8 的场次只有终局判名）：
 * 判名 + 最后一次时刻 + 次数。逐次时刻上游没给，就不猜 —— 近似出来的榜用 `approx` 标出来。
 */
export interface StatusSummary {
  accepted: boolean;
  fb: boolean;
  /** 终局判名对应的时刻（毫秒）；AC 是过题时刻，未过是末次提交时刻 */
  t: number;
  tries: number;
}

export function summaryOf(status: SrkStatus | undefined): StatusSummary | undefined {
  if (status === undefined) return undefined;
  const tries = Number.isFinite(status.tries) ? (status.tries as number) : 0;
  const t = toMs(status.time);
  const accepted = isAccept(status.result);
  if (!accepted && tries === 0 && t === 0) return undefined;
  return { accepted, fb: status.result === 'FB', t, tries };
}

/** 兜底路径下的格子：只知道"何时定论、共几发"，段内一律算未定 */
function cellFromSummary(s: StatusSummary, elapsed: number, cap: number, freezeStart: number): Cell {
  if (s.t > elapsed) return EMPTY_CELL;
  const nCap = s.t <= cap ? s.tries : 0;
  if (s.accepted) {
    if (s.t > cap) return { st: 'frz', t: s.t, n: s.tries, fails: 0, nCap, post: false };
    const fails = Math.max(0, s.tries - 1);
    return { st: s.fb ? 'fb' : 'ac', t: s.t, n: fails + 1, fails, nCap, post: s.t > freezeStart };
  }
  if (s.t > cap) return { st: 'frz', t: s.t, n: s.tries, fails: 0, nCap, post: false };
  return { st: 'pen', t: s.t, n: s.tries, fails: s.tries, nCap, post: s.t > freezeStart };
}

/**
 * 该题在 `elapsed` 时刻的格子状态（`cap` = 计分截止点，封榜段内即定格时刻）。
 *
 * `verdict` = `statuses[].result`，**终局判名**。它优先于 `solutions[]`：实测有重判撤销的题
 * （`result:'RJ'` 而 solutions 里仍留着那发 AC），照 solutions 数就会多数一题过
 * （2026-10-09 东北省赛 14 届「队九王里长」即此例，上游 score 记 4、按 solutions 数出 5）。
 * 传 undefined = 无从判断（单测 / 老数据），退回"照 solutions 信"。
 */
export function cellAt(
  subs: SrkSolution[],
  elapsed: number,
  cap: number,
  freezeStart: number,
  summary?: StatusSummary,
  verdict?: string | null,
): Cell {
  if (subs.length === 0 && summary !== undefined) return cellFromSummary(summary, elapsed, cap, freezeStart);
  const trust = verdict === undefined || isAccept(verdict);
  let last: SrkSolution | null = null;
  let ac: SrkSolution | null = null;
  let fails = 0;
  let nAll = 0;
  let nCap = 0;
  let after = false;
  for (const x of subs) {
    const t = toMs(x.time);
    if (t > elapsed) break;
    nAll++;
    last = x;
    if (t <= cap) {
      nCap++;
      if (trust && isAccept(x.result)) {
        if (ac === null || t > toMs(ac.time)) ac = x;
      } else if (x.result !== 'CE') fails++;
    } else after = true;
  }
  if (last === null) return EMPTY_CELL;
  if (ac !== null) {
    const acT = toMs(ac.time);
    let nf = 0;
    for (const y of subs) {
      const t = toMs(y.time);
      if (t > acT) break;
      if (t <= cap && !(trust && isAccept(y.result)) && y.result !== 'CE') nf++;
    }
    return { st: ac.result === 'FB' ? 'fb' : 'ac', t: acT, n: nf + 1, fails: nf, nCap, post: acT > freezeStart };
  }
  // 封榜段内有活动但结果未公开：只说「有 n 次提交」，不透露任何判名
  if (after) return { st: 'frz', t: toMs(last.time), n: nAll, fails: 0, nCap, post: false };
  const t = toMs(last.time);
  if (fails === 0 && last.result === 'CE') return { st: 'ce', t, n: 0, fails: 0, nCap, post: t > freezeStart };
  return { st: 'pen', t, n: fails, fails, nCap, post: t > freezeStart };
}

/* ---------- 重建后的榜 ---------- */

export interface BoardRow {
  /** 队伍序号（= `rows[]` 下标），弹层寻址与稳定 tie-break 用 */
  ti: number;
  rank: number;
  /** 正式队名次（奖牌带按这条划段）；打星队为 null */
  place: number | null;
  /** 每校头队序号（`S#`）；非头队与打星队是空串 */
  srank: string;
  medal: 'gold' | 'silver' | 'bronze' | null;
  medalTitle: string;
  solved: number;
  pen: number;
  star: boolean;
  cells: Cell[];
}

export interface Board {
  rows: BoardRow[];
  /** 每题列头读数：过题队数 / 提交次数 / 封榜未定格数 / 封榜后才通过的队数（都按 cap 口径） */
  col: { ac: number; sub: number; frz: number; postAc: number }[];
  frzCells: number;
  frozenRows: number;
  solvedTotal: number;
  cap: number;
}

/**
 * 计分截止点 cap：回放中 = min(elapsed, 封榜起点)（封榜即定格，名次 / 过题 / 罚时只算 cap 前）；
 * 终局与回顾 = elapsed 本身（终榜即 duration，全量解封）。
 */
export function capAt(elapsed: number, duration: number, freezeStart: number): number {
  return elapsed >= duration ? elapsed : Math.min(elapsed, freezeStart);
}

/** 队伍在 `elapsed` 之前、该题的逐次提交（弹层用；`frozen` = 落在封榜段内，判名一律不泄露） */
export function subsUntil(
  subs: SrkSolution[],
  elapsed: number,
  cap: number,
  verdict?: string | null,
): { r: string; t: number; language: string; frozen: boolean }[] {
  // 重判撤销的题：solutions 里那发 AC 已经不是结果，按终局判名标出去，别和红色格子自相矛盾
  const trust = verdict === undefined || isAccept(verdict);
  const out: { r: string; t: number; language: string; frozen: boolean }[] = [];
  for (const x of subs) {
    const t = toMs(x.time);
    if (t > elapsed) break;
    const raw = x.result ?? '?';
    out.push({ r: trust || !isAccept(raw) ? raw : 'RJ', t, language: x.language ?? '', frozen: t > cap });
  }
  return out;
}

/* ---------- 赛前一次性解析：题目 / 队伍 / 奖牌段 ---------- */

export interface TeamModel {
  ti: number;
  name: string;
  org: string;
  members: string[];
  seat: string;
  star: boolean;
  /** 每题一列，已按时刻升序（§4 性能口径：solutions 预排序） */
  subs: SrkSolution[][];
  /** 无逐次提交那批场次的兜底：每题的终局判名摘要（有 solutions 时为 undefined） */
  summaries: (StatusSummary | undefined)[];
  /** 每题的终局判名（`statuses[].result`）：重判撤销的题靠它才数对 */
  verdicts: (string | null | undefined)[];
}

export interface MedalBand {
  /** 累计上界（正式队名次 ≤ 该值即入段） */
  upTo: number;
  style: 'gold' | 'silver' | 'bronze';
  title: string;
}

export interface ContestModel {
  title: string;
  startAt: string;
  /** 比赛时长（毫秒） */
  duration: number;
  /** 封榜起点（毫秒，相对开赛）；未声明按缺省最后 60 分钟 */
  freezeStart: number;
  /** `frozenDuration` 是否真由数据声明 —— 顶栏要说清「本场未声明 · 按缺省」 */
  freezeDeclared: boolean;
  /** 本场快照没有逐次提交，榜按终局判名近似重建（界面必须标注，别假装是逐发回放） */
  approx: boolean;
  problems: SrkProblem[];
  teams: TeamModel[];
  bands: MedalBand[];
}

const METALS = new Set(['gold', 'silver', 'bronze']);

/**
 * 奖牌带：取 `series[]` 里同时带 `segments` 与 `rule` 的那支（实测 preset `ICPC`、
 * `count.value` = 累计上界 [30,60,90]）。`ratio` 与 `count` 并存时逐段取 `min(count, ratio×denom)`，
 * `denom` = all（全部队）或 scored（计分队）。没有这支 = 不挂带，不猜。
 */
export function medalBands(series: SrkSeries[] | undefined, teams: number, scored: number): MedalBand[] {
  const entry = series?.find((s) => Array.isArray(s.segments) && s.segments.length > 0 && s.rule !== undefined);
  if (entry?.segments === undefined) return [];
  const opts = entry.rule?.options;
  const counts = opts?.count?.value;
  const ratios = opts?.ratio?.value;
  if (!Array.isArray(counts) && !Array.isArray(ratios)) return [];
  const denom = String(opts?.denom ?? 'all').toLowerCase() === 'scored' ? scored : teams;
  const n = Math.max(counts?.length ?? 0, ratios?.length ?? 0);
  const out: MedalBand[] = [];
  for (let i = 0; i < n; i++) {
    const seg = entry.segments[i];
    const style = seg?.style ?? '';
    if (!METALS.has(style)) continue;
    const c = Array.isArray(counts) ? Number(counts[i]) : Number.POSITIVE_INFINITY;
    const r = Array.isArray(ratios) ? Number(ratios[i]) * denom : Number.POSITIVE_INFINITY;
    const upTo = Math.min(Number.isFinite(c) ? c : Number.POSITIVE_INFINITY, r);
    if (!Number.isFinite(upTo)) continue;
    out.push({ upTo: Math.floor(upTo), style: style as MedalBand['style'], title: seg?.title ?? style });
  }
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** srk.json → 一次性解析的模型（每秒重建只读它，不再遍历原始 JSON） */
export function buildModel(doc: SrkDoc): ContestModel {
  const contest = doc.contest ?? {};
  const duration = toMs(contest.duration);
  const frozen = toMs(contest.frozenDuration);
  const freezeDeclared = frozen > 0;
  const problems = Array.isArray(doc.problems) ? doc.problems : [];
  const rows = Array.isArray(doc.rows) ? doc.rows : [];

  const teams: TeamModel[] = rows.map((row, ti) => {
    const user = row.user ?? {};
    const statuses = Array.isArray(row.statuses) ? row.statuses : [];
    const subs = problems.map((_, p) => {
      const list = statuses[p]?.solutions;
      if (!Array.isArray(list)) return [] as SrkSolution[];
      return [...list].sort((a, b) => toMs(a.time) - toMs(b.time));
    });
    const summaries = problems.map((_, p) => (subs[p]!.length > 0 ? undefined : summaryOf(statuses[p])));
    const verdicts = problems.map((_, p) => (statuses[p] === undefined ? undefined : statuses[p]?.result ?? null));
    return {
      ti,
      name: str(user.name),
      org: str(user.organization),
      members: (Array.isArray(user.teamMembers) ? user.teamMembers : []).map((m) => str(m?.name)).filter((s) => s !== ''),
      seat: str(user.id),
      star: user.official !== true,
      subs,
      summaries,
      verdicts,
    };
  });

  /*
   * 近似榜判定：整场一发的逐次提交都没有（实测约 1/8 的场次如此，与 srk 版本号无关）。
   * 这时榜仍能按终局判名 + 次数重建，但"哪一发在什么时候"是上游没给的信息 —— 界面必须说清，
   * 不能让用户以为在看真·逐次回放。
   */
  const approx = teams.length > 0 && teams.every((t) => t.subs.every((list) => list.length === 0));

  return {
    title: str(contest.title?.['zh-CN']) || str(contest.title?.fallback),
    startAt: str(contest.startAt),
    duration,
    freezeStart: Math.max(0, duration - (freezeDeclared ? frozen : DEFAULT_FREEZE_MS)),
    freezeDeclared,
    approx,
    problems,
    teams,
    bands: medalBands(doc.series, teams.length, teams.filter((t) => !t.star).length),
  };
}

/** 并列判据 = 过题 + 罚时（与 ICPC 一致）；`last` 只做展示顺序的 tie-break */
const sameScore = (a: { solved: number; pen: number }, b: { solved: number; pen: number }): boolean =>
  a.solved === b.solved && a.pen === b.pen;

/**
 * 题号列头的档位（用户 2026-10-09 定的语义 B：黄 = 这题直到封榜后才被解开）。
 *
 * 「直到封榜后才被解开」取 `ac > 0 且全部通过都在封榜后`，而不是「有任意一格在封榜后通过」——
 * 一题有 100 队封榜前就过了、3 队封榜后才过，说它是"晚解题"是噪音，那 3 队进 tooltip。
 *
 * 多出来的 `pending` 档不是加分项而是必需：封榜段内的提交不计入 `sub`（口径与 cap 一致），
 * 若只按"四档"判，一题在封榜段被人动过、却还没定，列头会显示成「无人提交」——那是撒谎。
 * 所以段内有活动、还没有任何已定通过 → 显"待定"（斜纹灰，与格子 `?n` 同一语言），终局自动翻成红 / 绿 / 黄。
 */
export type HeadState = 'quiet' | 'pending' | 'noone' | 'any' | 'late';

export function problemHeadState(col: { ac: number; sub: number; frz: number; postAc: number }): HeadState {
  if (col.ac > 0) return col.postAc === col.ac ? 'late' : 'any';
  if (col.frz > 0) return 'pending';
  if (col.sub > 0) return 'noone';
  return 'quiet';
}

interface Acc {
  ti: number;
  solved: number;
  pen: number;
  last: number;
  star: boolean;
  org: string;
  cells: Cell[];
}

/**
 * 按 `elapsed` 重建整张榜（§4）。
 *
 * 每秒的成本只在「队伍 × 题数」的一遍扫描；行组件按 `cells` 引用 memo，未变动的行不重渲。
 */
export function buildBoard(model: ContestModel, elapsed: number, onlyFormal: boolean): Board {
  const { duration, freezeStart, teams, problems, bands } = model;
  const cap = capAt(elapsed, duration, freezeStart);
  const n = problems.length;

  const accs: Acc[] = [];
  for (const team of teams) {
    if (onlyFormal && team.star) continue;
    let solved = 0;
    let pen = 0;
    let last = 0;
    const cells: Cell[] = [];
    for (let p = 0; p < n; p++) {
      const c = cellAt(team.subs[p] ?? [], elapsed, cap, freezeStart, team.summaries[p], team.verdicts[p]);
      cells.push(c);
      if (c.st === 'ac' || c.st === 'fb') {
        solved++;
        // 契约 §4 的 ICPC 口径：每题时刻折整分钟再累加（上游另有按裸秒存的场次，见交付报告）
        pen += minutesOf(c.t) + c.fails * 20;
        if (minutesOf(c.t) > last) last = minutesOf(c.t);
      }
    }
    accs.push({ ti: team.ti, solved, pen, last, star: team.star, org: team.org, cells });
  }
  accs.sort((a, b) => b.solved - a.solved || a.pen - b.pen || a.last - b.last || a.ti - b.ti);

  /*
   * 名次：并列同名次、其后跳号（1,2,2,4）。打星队占位但不进 `place`，
   * 奖牌带按 `place`（正式队名次）划段 —— §4 的 1-30 / 31-60 / 61-90。
   * `S#` = 每校头队（`UniqByUserField organization` · 官方队）：只有该校最好的一支拿到序号。
   */
  const rows: BoardRow[] = [];
  const col = Array.from({ length: n }, () => ({ ac: 0, sub: 0, frz: 0, postAc: 0 }));
  const seenOrg = new Set<string>();
  let rank = 0;
  let place = 0;
  let officialSeen = 0;
  let frzCells = 0;
  let frozenRows = 0;
  let solvedTotal = 0;
  let prev: Acc | null = null;
  let prevOfficial: Acc | null = null;

  accs.forEach((a, ix) => {
    if (prev === null || !sameScore(a, prev)) rank = ix + 1;
    if (!a.star) {
      officialSeen++;
      if (prevOfficial === null || !sameScore(a, prevOfficial)) place = officialSeen;
      prevOfficial = a;
    }
    prev = a;

    const band = a.star ? undefined : bands.find((b) => place <= b.upTo);
    let srank = '';
    if (!a.star && !seenOrg.has(a.org)) {
      seenOrg.add(a.org);
      srank = String(seenOrg.size);
    }
    let has = false;
    for (let p = 0; p < n; p++) {
      const c = a.cells[p]!;
      col[p]!.sub += c.nCap;
      if (c.st === 'ac' || c.st === 'fb') {
        col[p]!.ac++;
        // 封榜后才通过的：只有终榜 / 回顾才算得出来（回放中这类格还是 ?）
        if (c.post) col[p]!.postAc++;
      } else if (c.st === 'frz') {
        col[p]!.frz++;
        has = true;
        frzCells++;
      }
    }
    if (has) frozenRows++;
    solvedTotal += a.solved;
    rows.push({
      ti: a.ti,
      rank,
      place: a.star ? null : place,
      srank,
      medal: band?.style ?? null,
      medalTitle: band?.title ?? '',
      solved: a.solved,
      pen: a.pen,
      star: a.star,
      cells: a.cells,
    });
  });

  return { rows, col, frzCells, frozenRows, solvedTotal, cap };
}

/* ---------- 时钟（§3：localStorage 每场一条会话，刷新按开始时刻续钟） ---------- */

export interface Session {
  /** 开钟时刻（epoch 毫秒）；暂停后再起来时它是重新接上的锚点 */
  started: number;
  /** 钟停着（暂停或已结束）：走钟不再推进 */
  hold: boolean;
  paused: boolean;
  ended: boolean;
  /** 回顾滑条位置（毫秒） */
  scrubMs: number;
  /** 暂停 / 结束时冻结住的那个时刻（毫秒）：刷新回来仍停在这一秒 */
  at: number;
  /**
   * 本场时长（毫秒），进回放拿到 srk 后补上。
   * 目录那行「回放中 · 时刻」要在不拉 1.5MB 榜单的前提下封顶，所以把它单独记一条。
   */
  durationMs: number;
}

/** 「开始模拟」= 开钟，没有准备页 */
export const startSession = (now: number): Session => ({
  started: now,
  hold: false,
  paused: false,
  ended: false,
  scrubMs: 0,
  at: 0,
  durationMs: 0,
});

/** 当前比赛时刻：暂停 / 结束读冻结住的 `at`，否则按开始时刻推 */
export function elapsedOf(s: Session, duration: number, now: number): number {
  const raw = s.hold ? s.at : now - s.started;
  return Math.max(0, Math.min(duration, raw));
}

/** 续钟：按记录的开始时刻推回当前时刻；整场已走完 → 直接落回顾 */
export function resume(started: number, duration: number, now: number): { elapsed: number; ended: boolean } {
  const raw = now - started;
  if (raw < 0) return { elapsed: 0, ended: false };
  return raw >= duration ? { elapsed: duration, ended: true } : { elapsed: raw, ended: false };
}

export const pause = (s: Session, elapsed: number): Session => ({ ...s, hold: true, paused: true, at: elapsed });

/** 继续 = 从暂停那一秒接钟 */
export const unpause = (s: Session, elapsed: number, now: number): Session => ({
  ...s,
  hold: false,
  paused: false,
  started: now - elapsed,
});

/** 结束 = 停钟 + 清续钟记录 + 落终榜回顾 */
export const finish = (s: Session, duration: number): Session => ({
  ...s,
  hold: true,
  paused: false,
  ended: true,
  at: duration,
  scrubMs: duration,
});

/** 走钟：到 `duration` 自动落回顾。只由「暂停」拦 —— reduced-motion 关的是装饰动效，不是比赛钟 */
export function tick(s: Session, duration: number, now: number): { session: Session; elapsed: number } {
  const elapsed = elapsedOf(s, duration, now);
  if (!s.hold && elapsed >= duration && !s.ended) return { session: finish(s, duration), elapsed: duration };
  return { session: s, elapsed };
}

/** 顶栏 pill 与封榜带共用的判据：当前时刻是否落在封榜段内 */
export const inFreezeWindow = (elapsed: number, duration: number, freezeStart: number): boolean =>
  elapsed > freezeStart && elapsed < duration;
