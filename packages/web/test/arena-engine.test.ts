/**
 * 回放引擎单测（docs/16 §7）。纯函数、零网络、夹具全部自造（§2.4 许可证纪律）。
 * 形状照 2026-10-09 实测的 srk.json：`statuses[].time` = [值,'s']、`solutions[].time` = [值,'ms']。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREEZE_MS,
  EMPTY_CELL,
  buildBoard,
  buildModel,
  capAt,
  cellAt,
  elapsedOf,
  finish,
  ghostCell,
  inFreezeWindow,
  medalBands,
  minutesOf,
  pause,
  problemHeadState,
  resume,
  startSession,
  subsUntil,
  tick,
  toMs,
  unpause,
  type GhostMark,
  type SrkDoc,
  type SrkSolution,
} from '../src/components/arena/engine.ts';

const H = 3_600_000;
const M = 60_000;
const S = 1_000;

/* ---------- 单位换算 ---------- */

describe('时间单位换算', () => {
  it('[值, 单位] 元组按各自单位折算', () => {
    expect(toMs([5, 'h'])).toBe(5 * H);
    expect(toMs([90, 'min'])).toBe(90 * M);
    expect(toMs([6829, 's'])).toBe(6829 * S);
    expect(toMs([6829080, 'ms'])).toBe(6829080);
    expect(toMs([2, 'd'])).toBe(2 * 86_400_000);
  });

  it('两套单位对的是同一时刻：statuses 按整秒、solutions 带毫秒（实测差 80ms）', () => {
    // 实测上海站首行 A 题：statuses.time = [6829,'s']，solutions.time = [6829080,'ms']
    expect(toMs([6829, 's'])).toBe(6_829_000);
    expect(Math.abs(toMs([6829, 's']) - toMs([6829080, 'ms']))).toBeLessThan(1000);
    // 引擎读的是 solutions 的毫秒，分钟读数两边一致
    expect(minutesOf(toMs([6829, 's']))).toBe(minutesOf(toMs([6829080, 'ms'])));
  });

  it('读不懂的形状一律 0，不猜时刻', () => {
    expect(toMs(undefined)).toBe(0);
    expect(toMs(null)).toBe(0);
    expect(toMs('1h')).toBe(0);
    expect(toMs([NaN, 's'])).toBe(0);
    expect(toMs([])).toBe(0);
    expect(toMs(1234)).toBe(1234);
  });

  it('分钟读数向下取整（罚时口径）', () => {
    expect(minutesOf(6829 * S)).toBe(113);
    expect(minutesOf(114 * M - 1)).toBe(113);
  });
});

/* ---------- 夹具 ---------- */

const sol = (result: string, ms: number, language = 'C++17'): SrkSolution => ({ result, time: [ms, 'ms'], language });

/**
 * 3 题 5 队：
 *  T0 正式 · A 题 2 次 WA 后 AC(114:00) → 罚时 114 + 40
 *  T1 正式 · A 题 AC(60:00) 与 T0 同过题数、罚时更低
 *  T2 打星 · B 题 AC(10:00)
 *  T3 正式 · 封榜段内提交（终局才揭晓）
 *  T4 正式 · 只有 CE
 */
function fixture(overrides: Partial<SrkDoc> = {}): SrkDoc {
  const duration: [number, string] = [5, 'h'];
  return {
    contest: { title: { 'zh-CN': '自造上海站' }, startAt: '2025-11-23T09:00:00+08:00', duration, frozenDuration: [0, 'h'] },
    problems: [
      { alias: 'A', title: 'Alpha', statistics: { accepted: 2, submitted: 5 } },
      { alias: 'B', title: 'Bravo', statistics: { accepted: 1, submitted: 2 } },
      { alias: 'C', title: 'Charlie', statistics: { accepted: 0, submitted: 1 } },
    ],
    series: [
      {
        title: '#',
        segments: [
          { title: '金奖', style: 'gold' },
          { title: '银奖', style: 'silver' },
          { title: '铜奖', style: 'bronze' },
        ],
        rule: { preset: 'ICPC', options: { count: { value: [1, 2, 3] } } },
      },
      { title: 'R#', rule: { preset: 'Normal' } },
      { title: 'S#', rule: { preset: 'UniqByUserField', options: { field: 'organization', includeOfficialOnly: true } } },
    ],
    rows: [
      {
        user: { name: '一步之遥', id: 'B78', organization: '北京大学', teamMembers: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], official: true },
        statuses: [
          { result: 'AC', time: [6840, 's'], tries: 3, solutions: [sol('WA', 30 * M), sol('WA', 60 * M), sol('AC', 114 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: 'RJ', time: [0, 's'], tries: 1, solutions: [sol('TLE', 50 * M)] },
        ],
      },
      {
        user: { name: '下一队更强', id: 'A01', organization: '清华大学', teamMembers: [{ name: '丁' }], official: true },
        statuses: [
          { result: 'AC', time: [3600, 's'], tries: 1, solutions: [sol('AC', 60 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
      {
        user: { name: '长期打星', id: 'S01', organization: '北京大学', teamMembers: [{ name: '戊' }], official: false },
        statuses: [
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: 'FB', time: [600, 's'], tries: 1, solutions: [sol('FB', 10 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
      {
        user: { name: '快进到封榜', id: 'C07', organization: '复旦大学', teamMembers: [{ name: '己' }], official: true },
        statuses: [
          // 封榜段（4:00 之后）内交了一次并 AC —— 定格时只显 ?1，终局才揭晓为 AC 且挂「封榜后」
          { result: 'AC', time: [15600, 's'], tries: 1, solutions: [sol('AC', 260 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
      {
        user: { name: '编译通过', id: 'D02', organization: '上海交通大学', teamMembers: [{ name: '庚' }], official: true },
        statuses: [
          { result: 'RJ', time: [0, 's'], tries: 1, solutions: [sol('CE', 5 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
    ],
    ...overrides,
  };
}

/* ---------- 模型解析 ---------- */

describe('模型解析', () => {
  it('frozenDuration [0,\'h\'] = 未声明 → 缺省最后 60 分钟', () => {
    const m = buildModel(fixture());
    expect(m.duration).toBe(5 * H);
    expect(m.freezeDeclared).toBe(false);
    expect(m.freezeStart).toBe(5 * H - DEFAULT_FREEZE_MS);
    expect(m.freezeStart).toBe(4 * H);
  });

  it('真声明了封榜时长就按声明值走', () => {
    const m = buildModel(
      fixture({ contest: { title: { 'zh-CN': 'x' }, startAt: '', duration: [5, 'h'], frozenDuration: [90, 'min'] } }),
    );
    expect(m.freezeDeclared).toBe(true);
    expect(m.freezeStart).toBe(5 * H - 90 * M);
  });

  it('题目数与 statuses 长度不齐：缺的按空，不越界', () => {
    const m = buildModel(fixture({ problems: [{ alias: 'A' }, { alias: 'B' }, { alias: 'C' }, { alias: 'D' }] }));
    const b = buildBoard(m, 5 * H, false);
    expect(b.rows[0]?.cells).toHaveLength(4);
    expect(b.rows[0]?.cells[3]?.st).toBe('none');
  });

  it('solutions 预排序：上游乱序进来也按时刻升序', () => {
    const m = buildModel(
      fixture({
        rows: [
          {
            user: { name: '乱序队', id: 'X1', organization: '某大学', official: true },
            statuses: [
              { result: 'AC', time: [6840, 's'], solutions: [sol('AC', 114 * M), sol('WA', 30 * M), sol('WA', 60 * M)] },
            ],
          },
        ],
      }),
    );
    expect(m.teams[0]?.subs[0]?.map((x) => toMs(x.time))).toEqual([30 * M, 60 * M, 114 * M]);
  });

  it('双语对象队名 / 校名：中文优先，空串不吃掉回退', () => {
    const m = buildModel(
      fixture({
        rows: [
          {
            user: {
              name: { 'zh-CN': '自造甲队', en: 'Team Alpha', fallback: 'Team Alpha' },
              organization: { 'zh-CN': '自造大学', fallback: 'Ziu University' },
              teamMembers: [{ name: { 'zh-CN': '甲一', fallback: 'Jia One' } }, { name: '甲二' }, { name: { en: 'Third Only' } }, { name: {} }],
              official: true,
            },
            statuses: [],
          },
          { user: { name: { fallback: '仅回退名' }, organization: { en: 'English Only' }, official: true }, statuses: [] },
          { user: { name: { 'zh-CN': '', fallback: '非空回退' }, official: true }, statuses: [] },
          // 纯字符串形状（多数场次）与缺字段，走同一条归一
          { user: { name: '字符串队名', organization: '字符串校名', official: true }, statuses: [] },
          { user: { official: true }, statuses: [] },
        ],
      }),
    );
    const t = m.teams;
    expect(t[0]?.name).toBe('自造甲队');
    expect(t[0]?.org).toBe('自造大学');
    // 成员数组里对象名与字符串名混着来：各取对的，读不懂的那条按空滤掉
    expect(t[0]?.members).toEqual(['甲一', '甲二', 'Third Only']);
    expect(t[1]?.name).toBe('仅回退名');
    expect(t[1]?.org).toBe('English Only');
    expect(t[2]?.name).toBe('非空回退');
    expect(t[3]?.name).toBe('字符串队名');
    expect(t[3]?.org).toBe('字符串校名');
    expect(t[4]?.name).toBe('');
    expect(t[4]?.org).toBe('');
  });

  it('contest.title 与队名同一套归一（含只有 en 的形状）', () => {
    expect(buildModel(fixture({ contest: { title: { en: 'Only Latin Title' }, duration: [5, 'h'] } })).title).toBe('Only Latin Title');
    expect(buildModel(fixture({ contest: { title: '字符串标题', duration: [5, 'h'] } })).title).toBe('字符串标题');
  });

  it('S# 回归：校名是双语对象时同校头队照样拿号（修复前空串全撞组 → 只剩一支有号）', () => {
    const m = buildModel({
      contest: { title: { 'zh-CN': '对象校名' }, duration: [5, 'h'], frozenDuration: [0, 'h'] },
      problems: [{ alias: 'A' }, { alias: 'B' }],
      rows: [
        // 同校两队（A 过 2 题 = 头队，B 过 1 题）+ 另一校一队；校名全部是双语对象
        {
          user: { name: '同校头队', organization: { 'zh-CN': '自造大学', fallback: 'Ziu University' }, official: true },
          statuses: [
            { result: 'AC', time: [600, 's'], solutions: [sol('AC', 10 * M)] },
            { result: 'AC', time: [1200, 's'], solutions: [sol('AC', 20 * M)] },
          ],
        },
        {
          user: { name: '同校次队', organization: { 'zh-CN': '自造大学', fallback: 'Ziu University' }, official: true },
          statuses: [
            { result: 'AC', time: [600, 's'], solutions: [sol('AC', 10 * M)] },
            { result: null, time: [0, 's'], solutions: [] },
          ],
        },
        {
          user: { name: '另一校队', organization: { 'zh-CN': '另一大学', fallback: 'Another University' }, official: true },
          statuses: [
            { result: 'AC', time: [1200, 's'], solutions: [sol('AC', 20 * M)] },
            { result: null, time: [0, 's'], solutions: [] },
          ],
        },
      ],
    });
    const b = buildBoard(m, 5 * H, false);
    const byName = new Map(b.rows.map((r) => [m.teams[r.ti]!.name, r.srank]));
    expect(byName.get('同校头队')).toBe('1');
    expect(byName.get('同校次队')).toBe('');
    expect(byName.get('另一校队')).toBe('2');
  });
});

/* ---------- 题目格五态 + 终局两态 ---------- */

describe('题目格状态', () => {
  const m = buildModel(fixture());
  const t0 = m.teams[0]!;
  const t3 = m.teams[3]!;
  const t4 = m.teams[4]!;

  it('空 / 罚时中 / AC / 首杀 四态', () => {
    expect(cellAt(t0.subs[1] ?? [], 5 * H, 5 * H, m.freezeStart).st).toBe('none');
    const pen = cellAt([sol('WA', 30 * M), sol('TLE', 50 * M)], 3 * H, 3 * H, m.freezeStart);
    expect(pen.st).toBe('pen');
    expect(pen.n).toBe(2);
    expect(pen.t).toBe(50 * M);
    const ac = cellAt(t0.subs[0] ?? [], 5 * H, 5 * H, m.freezeStart);
    expect(ac.st).toBe('ac');
    expect(ac.n).toBe(3);
    expect(ac.fails).toBe(2);
    const fb = cellAt(m.teams[2]!.subs[1] ?? [], 5 * H, 5 * H, m.freezeStart);
    expect(fb.st).toBe('fb');
  });

  it('封榜 ?n：段内有活动、结果未知，不计名次', () => {
    // 4:20 时刻：T3 在 4:20 交了 A 题，cap 定在 4:00 → 该格是 ?1
    const frozen = cellAt(t3.subs[0] ?? [], 260 * M, capAt(260 * M, m.duration, m.freezeStart), m.freezeStart);
    expect(frozen.st).toBe('frz');
    expect(frozen.n).toBe(1);
    expect(frozen.post).toBe(false);
    // 同一格在终局解封后变 AC，并挂上「封榜后」
    const after = cellAt(t3.subs[0] ?? [], 5 * H, 5 * H, m.freezeStart);
    expect(after.st).toBe('ac');
    expect(after.post).toBe(true);
  });

  it('终局两态：封榜后通过 / 封榜后未过 都带 post，罚时中的 post 也在', () => {
    const penPost = cellAt([sol('WA', 250 * M)], 5 * H, 5 * H, m.freezeStart);
    expect(penPost.st).toBe('pen');
    expect(penPost.post).toBe(true);
  });

  it('CE 不算失败，单独成一档', () => {
    const ce = cellAt(t4.subs[0] ?? [], 5 * H, 5 * H, m.freezeStart);
    expect(ce.st).toBe('ce');
    expect(ce.n).toBe(0);
    expect(ce.fails).toBe(0);
  });

  it('CE 之后 AC：次数读数不含 CE，罚时不罚 CE', () => {
    const withCe = cellAt([sol('CE', 10 * M), sol('WA', 20 * M), sol('AC', 30 * M)], 1 * H, 1 * H, m.freezeStart);
    expect(withCe.st).toBe('ac');
    expect(withCe.fails).toBe(1);
    expect(withCe.n).toBe(2);
  });
});

/* ---------- 罚时 / 排名 / S# / 奖牌 ---------- */

describe('罚时与排名', () => {
  const m = buildModel(fixture());

  it('ICPC 罚时 = AC 分钟 + 20 × AC 前失败次数', () => {
    const b = buildBoard(m, 5 * H, false);
    const row = b.rows.find((r) => r.ti === 0)!;
    expect(row.solved).toBe(1);
    expect(row.pen).toBe(114 + 2 * 20);
  });

  it('罚时口径钉死为「每题折整分钟再累加」（契约 §4），不是裸秒累加最后折', () => {
    // 两题分别在 6829s(113.8min) 与 1000s(16.6min)：分钟口径 = 113+16 = 129；裸秒口径会得 130
    const m = buildModel({
      contest: { title: { 'zh-CN': '口径' }, duration: [5, 'h'], frozenDuration: [0, 'h'] },
      problems: [{ alias: 'A' }, { alias: 'B' }],
      rows: [
        {
          user: { name: '甲', official: true },
          statuses: [
            { result: 'AC', time: [6829, 's'], solutions: [sol('AC', 6829080)] },
            { result: 'AC', time: [1000, 's'], solutions: [sol('AC', 1000000)] },
          ],
        },
      ],
    });
    const b = buildBoard(m, 5 * H, false);
    expect(b.rows[0]?.pen).toBe(129);
  });

  it('重判撤销（result RJ 而 solutions 里有 AC）不算过题', () => {
    const m = buildModel({
      contest: { title: { 'zh-CN': '重判' }, duration: [5, 'h'], frozenDuration: [0, 'h'] },
      problems: [{ alias: 'A' }],
      rows: [
        {
          user: { name: '甲', official: true },
          statuses: [{ result: 'RJ', time: [200, 'min'], tries: 3, solutions: [sol('AC', 100 * M), sol('WA', 150 * M), sol('WA', 200 * M)] }],
        },
      ],
    });
    const b = buildBoard(m, 5 * H, false);
    expect(b.rows[0]?.solved).toBe(0);
    expect(b.rows[0]?.cells[0]?.st).toBe('pen');
    expect(b.rows[0]?.cells[0]?.n).toBe(3);
    // 弹层里那发 AC 按终局判名标成 RJ，不与红格自相矛盾
    expect(subsUntil(m.teams[0]!.subs[0]!, 5 * H, 5 * H, 'RJ').map((x) => x.r)).toEqual(['RJ', 'WA', 'WA']);
  });

  it('过题降序、罚时升序', () => {
    const b = buildBoard(m, 5 * H, false);
    const order = b.rows.filter((r) => !r.star).map((r) => [r.ti, r.solved, r.pen]);
    expect(order[0]).toEqual([1, 1, 60]);
    expect(order[1]).toEqual([0, 1, 154]);
  });

  it('并列同名次、其后跳号（1,2,2,4）', () => {
    const mk = (mins: number[]) =>
      buildModel({
        contest: { title: { 'zh-CN': 't' }, duration: [5, 'h'], frozenDuration: [0, 'h'] },
        problems: [{ alias: 'A' }],
        rows: mins.map((v, i) => ({
          user: { name: `队 ${i}`, official: true },
          statuses: [{ result: 'AC', time: [v * 60, 's'], solutions: [sol('AC', v * M)] }],
        })),
      });
    // 队 1 与队 2 同 2 分钟过题 = 同过题同罚时 → 并列第 2，其后跳到 4
    expect(buildBoard(mk([1, 2, 2, 5]), 5 * H, false).rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(buildBoard(mk([1, 2, 2, 5]), 5 * H, false).rows.map((r) => r.place)).toEqual([1, 2, 2, 4]);
  });

  it('打星队不占奖牌带、不占 S#，名次照列', () => {
    const b = buildBoard(m, 5 * H, false);
    const star = b.rows.find((r) => r.star)!;
    expect(star.medal).toBeNull();
    expect(star.place).toBeNull();
    expect(star.srank).toBe('');
    const official = b.rows.filter((r) => !r.star);
    expect(official.map((r) => r.medal)).toEqual(['gold', 'silver', 'bronze', null]);
    expect(official.map((r) => r.place)).toEqual([1, 2, 3, 4]);
  });

  it('S# = 每校头队序号，同校后续队为空串', () => {
    const b = buildBoard(m, 5 * H, false);
    const byTi = new Map(b.rows.map((r) => [r.ti, r]));
    expect(byTi.get(0)?.srank).toBe('2'); // 清华只有一支 → 头名 2（北大头队是 1）
    expect(byTi.get(1)?.srank).toBe('1');
    expect(byTi.get(3)?.srank).toBe('3');
  });

  it('仅正式队过滤：打星队整行退出，读数随之变化', () => {
    const all = buildBoard(m, 5 * H, false);
    const formal = buildBoard(m, 5 * H, true);
    expect(all.rows).toHaveLength(5);
    expect(formal.rows).toHaveLength(4);
    expect(formal.rows.every((r) => !r.star)).toBe(true);
    expect(formal.col[1]?.ac).toBe(0); // B 题唯一一次过题来自打星队
  });
});

describe('奖牌带解析', () => {
  const segs = [
    { title: '金奖', style: 'gold' },
    { title: '银奖', style: 'silver' },
    { title: '铜奖', style: 'bronze' },
  ];

  it('preset ICPC 的 count.value 是累计上界', () => {
    const bands = medalBands([{ title: '#', segments: segs, rule: { preset: 'ICPC', options: { count: { value: [30, 60, 90] } } } }], 356, 331);
    expect(bands.map((b) => [b.style, b.upTo])).toEqual([
      ['gold', 30],
      ['silver', 60],
      ['bronze', 90],
    ]);
  });

  it('ratio 与 count 并存 → 逐段取 min(count, ratio×denom)', () => {
    const withRatio = [{ title: '#', segments: segs, rule: { preset: 'ICPC', options: { count: { value: [100, 200, 300] }, ratio: { value: [0.1, 0.2, 0.3] } } } }];
    expect(medalBands(withRatio, 356, 331).map((b) => b.upTo)).toEqual([35, 71, 106]);
    const scored = [
      {
        title: '#',
        segments: segs,
        rule: { preset: 'ICPC', options: { count: { value: [100, 200, 300] }, ratio: { value: [0.1, 0.2, 0.3] }, denom: 'scored' } },
      },
    ];
    expect(medalBands(scored, 356, 331).map((b) => b.upTo)).toEqual([33, 66, 99]);
  });

  it('没有 series 信息 → 不挂带（不猜）', () => {
    expect(medalBands(undefined, 10, 10)).toEqual([]);
    expect(medalBands([{ title: 'R#', rule: { preset: 'Normal' } }], 10, 10)).toEqual([]);
    expect(medalBands([{ title: '#', segments: segs }], 10, 10)).toEqual([]);
    const m = buildModel(fixture({ series: [] }));
    expect(m.bands).toEqual([]);
    expect(buildBoard(m, 5 * H, false).rows.every((r) => r.medal === null)).toBe(true);
  });
});

/* ---------- 封榜定格与列头读数 ---------- */

describe('封榜定格', () => {
  const m = buildModel(fixture());

  it('cap：回放中随 elapsed 走，封榜后定格在 4:00，终局全量解封', () => {
    expect(capAt(1 * H, m.duration, m.freezeStart)).toBe(1 * H);
    expect(capAt(4 * H + 1, m.duration, m.freezeStart)).toBe(4 * H);
    expect(capAt(5 * H, m.duration, m.freezeStart)).toBe(5 * H);
  });

  it('封榜时刻的榜：T3 的 AC 不进门次与过题，格上只显 ?1', () => {
    const b = buildBoard(m, 260 * M, false);
    const t3 = b.rows.find((r) => r.ti === 3)!;
    expect(t3.solved).toBe(0);
    expect(t3.pen).toBe(0);
    expect(t3.cells[0]?.st).toBe('frz');
    expect(b.cap).toBe(4 * H);
  });

  it('封榜带读数：未知格数与涉及队数', () => {
    const b = buildBoard(m, 260 * M, false);
    expect(b.frzCells).toBe(1);
    expect(b.frozenRows).toBe(1);
  });

  it('终局解封后不再有 ?，且总过题数上升', () => {
    const frozen = buildBoard(m, 260 * M, false);
    const final = buildBoard(m, 5 * H, false);
    expect(final.frzCells).toBe(0);
    expect(final.solvedTotal).toBeGreaterThan(frozen.solvedTotal);
    expect(final.rows.length).toBe(frozen.rows.length);
  });

  it('列头「过 N / 交 M」按 cap 口径，封榜段不泄密', () => {
    const frozen = buildBoard(m, 260 * M, false);
    const final = buildBoard(m, 5 * H, false);
    expect(frozen.col[0]?.ac).toBe(2);
    expect(final.col[0]?.ac).toBe(3);
    expect(frozen.col[0]!.sub).toBeLessThan(final.col[0]!.sub);
    expect(final.solvedTotal).toBe(4);
  });

  it('inFreezeWindow：4:00 起、5:00 止', () => {
    expect(inFreezeWindow(4 * H, m.duration, m.freezeStart)).toBe(false);
    expect(inFreezeWindow(4 * H + 1, m.duration, m.freezeStart)).toBe(true);
    expect(inFreezeWindow(5 * H, m.duration, m.freezeStart)).toBe(false);
  });
});

/* ---------- 回顾解封视界（unsealed = 回顾默认态） ---------- */

describe('回顾解封视界（unsealed）', () => {
  const m = buildModel(fixture());

  it('unsealed=true 在封榜段内 cap === elapsed：AC 直接揭晓且带「封榜后」两态', () => {
    const b = buildBoard(m, 260 * M, false, true);
    expect(b.cap).toBe(260 * M);
    // T3 的 A 题在 4:20 交并 AC（落在封榜段内）：解封视界下就是 ac + post
    const t3 = b.rows.find((r) => r.ti === 3)!;
    expect(t3.cells[0]?.st).toBe('ac');
    expect(t3.cells[0]?.post).toBe(true);
    expect(t3.solved).toBe(1);
    expect(b.frzCells).toBe(0);
  });

  it('unsealed=false 维持现状：同一时刻同一格仍是 ?1、cap 定格在 4:00', () => {
    const b = buildBoard(m, 260 * M, false);
    expect(b.cap).toBe(4 * H);
    const t3 = b.rows.find((r) => r.ti === 3)!;
    expect(t3.cells[0]?.st).toBe('frz');
    expect(t3.cells[0]?.post).toBe(false);
    expect(t3.solved).toBe(0);
    expect(b.frzCells).toBe(1);
  });

  it('unsealed 只在封榜段内有差别：封榜前与终局两态一致', () => {
    expect(buildBoard(m, 2 * H, false, true).cap).toBe(buildBoard(m, 2 * H, false).cap);
    const finalA = buildBoard(m, 5 * H, false, true);
    const finalB = buildBoard(m, 5 * H, false);
    expect(finalA.cap).toBe(finalB.cap);
    expect(finalA.solvedTotal).toBe(finalB.solvedTotal);
    expect(finalA.frzCells).toBe(0);
  });
});

/* ---------- 列头四档（语义 B） ---------- */

describe('题号列头状态', () => {
  it('无人提交 / 待定 / 交而没过 / 有人过 / 封榜后才解开', () => {
    expect(problemHeadState({ ac: 0, sub: 0, frz: 0, postAc: 0 })).toBe('quiet');
    expect(problemHeadState({ ac: 0, sub: 7, frz: 0, postAc: 0 })).toBe('noone');
    // 段内有活动还没定：不能报"没人交"，也不能报"没人过"
    expect(problemHeadState({ ac: 0, sub: 0, frz: 4, postAc: 0 })).toBe('pending');
    expect(problemHeadState({ ac: 5, sub: 20, frz: 0, postAc: 0 })).toBe('any');
    // 全部通过都发生在封榜后 → 才叫"这题直到封榜后才被解开"
    expect(problemHeadState({ ac: 3, sub: 9, frz: 0, postAc: 3 })).toBe('late');
    // 有一队封榜前就过了，就不升级成黄，那几队进 tooltip
    expect(problemHeadState({ ac: 4, sub: 9, frz: 0, postAc: 3 })).toBe('any');
    // 已有定论的通过优先于待定：绿/黄不被斜纹盖掉
    expect(problemHeadState({ ac: 2, sub: 9, frz: 3, postAc: 0 })).toBe('any');
  });

  it('postAc 只在解封之后才有值：回放中这类格还是 ?', () => {
    const m = buildModel(fixture());
    const frozen = buildBoard(m, 260 * M, false);
    const final = buildBoard(m, 5 * H, false);
    // A 题：T3 的 AC 落在封榜段（260 分）
    expect(frozen.col[0]!.postAc).toBe(0);
    expect(final.col[0]!.postAc).toBe(1);
    expect(final.col[0]!.ac).toBe(3);
    expect(problemHeadState(frozen.col[0]!)).toBe('any');
    expect(problemHeadState(final.col[0]!)).toBe('any');
    // B 题唯一一次通过来自打星队的封榜前 FB；C 题只有一发 TLE → 交而没过
    expect(problemHeadState(final.col[1]!)).toBe('any');
    expect(problemHeadState(final.col[2]!)).toBe('noone');
  });

  it('一题只有封榜后才被解开 → 终榜列头翻黄', () => {
    const m = buildModel(
      fixture({
        rows: [
          {
            user: { name: '晚解队', id: 'Z1', organization: '某大学', official: true },
            statuses: [{ result: 'AC', time: [260 * 60, 's'], solutions: [sol('AC', 260 * M)] }],
          },
        ],
        problems: [{ alias: 'A', title: 'Alpha' }],
      }),
    );
    const frozen = buildBoard(m, 260 * M, false);
    const final = buildBoard(m, 5 * H, false);
    expect(problemHeadState(frozen.col[0]!)).toBe('pending'); // 段内有活动、结果未定 → 不撒谎说"没人交"
    expect(problemHeadState(final.col[0]!)).toBe('late'); // 终局揭晓：唯一一次通过在封榜后 → 黄
  });
});

/* ---------- 无逐次提交场次的近似重建（实测约 1/8 的快照如此） ---------- */

describe('近似榜（只有终局判名）', () => {
  const approxDoc: SrkDoc = {
    contest: { title: { 'zh-CN': '只有判名的一场' }, duration: [5, 'h'], frozenDuration: [0, 'h'] },
    problems: [{ alias: 'A' }, { alias: 'B' }, { alias: 'C' }],
    rows: [
      {
        user: { name: '甲队', id: 'A1', organization: 'X', official: true },
        statuses: [
          { result: 'AC', time: [120, 'min'], tries: 3 },
          { result: 'RJ', time: [260, 'min'], tries: 5 },
          { result: null, time: [0, 'min'], tries: 0 },
        ],
      },
      {
        user: { name: '乙队', id: 'A2', organization: 'Y', official: true },
        statuses: [
          { result: 'FB', time: [30, 'min'], tries: 1 },
          { result: null, time: [0, 'min'], tries: 0 },
          { result: null, time: [0, 'min'], tries: 0 },
        ],
      },
    ],
  };

  it('没有任何 solutions → approx = true', () => {
    expect(buildModel(approxDoc).approx).toBe(true);
    expect(buildModel(fixture()).approx).toBe(false);
  });

  it('格子只在判名那一刻出现；罚时按 tries 折算', () => {
    const m = buildModel(approxDoc);
    const early = buildBoard(m, 60 * M, false);
    // 60 分钟时：甲队 A 题（120 分才过）还没影，乙队 A 题首杀已过
    expect(early.rows.find((r) => r.ti === 0)?.cells[0]?.st).toBe('none');
    expect(early.rows.find((r) => r.ti === 1)?.cells[0]?.st).toBe('fb');
    const fin = buildBoard(m, 5 * H, false);
    const a = fin.rows.find((r) => r.ti === 0)!;
    expect(a.solved).toBe(1);
    // 120 分钟 + 20 ×（3 发 − 1 发 AC）= 160
    expect(a.pen).toBe(120 + 40);
    expect(a.cells[1]?.st).toBe('pen');
    expect(a.cells[1]?.n).toBe(5);
    expect(a.cells[2]?.st).toBe('none');
  });

  it('封榜段内定论的格子照样算 ?，不提前泄露', () => {
    const m = buildModel(approxDoc);
    const frozen = buildBoard(m, 261 * M, false);
    const cell = frozen.rows.find((r) => r.ti === 0)!.cells[1]!;
    expect(cell.st).toBe('frz');
    expect(cell.n).toBe(5);
    // 未过的那题在定格名次里不算
    expect(frozen.rows.find((r) => r.ti === 0)?.solved).toBe(1);
  });

  it('列头在近似榜下也不撒谎：有活动未定 → 待定而不是无人提交', () => {
    const m = buildModel(approxDoc);
    const frozen = buildBoard(m, 261 * M, false);
    expect(problemHeadState(frozen.col[1]!)).toBe('pending');
    expect(problemHeadState(buildBoard(m, 5 * H, false).col[1]!)).toBe('noone');
  });
});

/* ---------- 幽灵行「我的成绩」（docs/20 §2.2） ---------- */

describe('幽灵格 ghostCell', () => {
  const freezeStart = 4 * H; // 5 小时场 · 未声明封榜 → 缺省最后 60 分钟
  const liveCap = 4 * H; // 回放中封榜段内的定格点

  it('没录入 / 录了个空 → 空格，不占任何读数', () => {
    expect(ghostCell(undefined, 5 * H, 5 * H, freezeStart)).toEqual(EMPTY_CELL);
    expect(ghostCell({ p: 3 }, 5 * H, 5 * H, freezeStart)).toEqual(EMPTY_CELL);
  });

  it('只有失败 → pen 且 t = 0：输入里没有末次时刻，显示层只出 −n', () => {
    expect(ghostCell({ p: 1, fails: 2 }, 260 * M, liveCap, freezeStart)).toEqual({
      st: 'pen', t: 0, n: 2, fails: 2, nCap: 2, post: false,
    });
    expect(minutesOf(ghostCell({ p: 1, fails: 2 }, 5 * H, 5 * H, freezeStart).t)).toBe(0);
  });

  it('ac ≤ cap → ac，n = fails + 1，罚时按「AC 分钟 + 20 × AC 前失败」', () => {
    const c = ghostCell({ p: 0, ac: 113, fails: 2 }, 5 * H, 5 * H, freezeStart);
    expect(c).toEqual({ st: 'ac', t: 113 * M, n: 3, fails: 2, nCap: 3, post: false });
    expect(minutesOf(c.t) + c.fails * 20).toBe(113 + 40);
  });

  it('封榜前 AC 且一发就过 → ×1（界面靠 n > 1 才显次数）', () => {
    expect(ghostCell({ p: 0, ac: 45 }, 5 * H, 5 * H, freezeStart)).toEqual({
      st: 'ac', t: 45 * M, n: 1, fails: 0, nCap: 1, post: false,
    });
  });

  it('封榜段（cap < ac ≤ elapsed）→ frz ?(fails+1)，不提前泄判名', () => {
    expect(ghostCell({ p: 0, ac: 250, fails: 1 }, 260 * M, liveCap, freezeStart)).toEqual({
      st: 'frz', t: 250 * M, n: 2, fails: 0, nCap: 2, post: false,
    });
  });

  it('还没走到那一刻（ac > elapsed）→ 按未过处理：有失败显 −fails，没有就空', () => {
    expect(ghostCell({ p: 0, ac: 250, fails: 3 }, 60 * M, 60 * M, freezeStart)).toEqual({
      st: 'pen', t: 0, n: 3, fails: 3, nCap: 3, post: false,
    });
    expect(ghostCell({ p: 0, ac: 250 }, 60 * M, 60 * M, freezeStart)).toEqual(EMPTY_CELL);
  });

  it('解封视界（cap = elapsed）下段内的 AC 直接显结果并挂 post', () => {
    expect(ghostCell({ p: 0, ac: 250, fails: 1 }, 260 * M, 260 * M, freezeStart)).toEqual({
      st: 'ac', t: 250 * M, n: 2, fails: 1, nCap: 2, post: true,
    });
  });
});

describe('幽灵行入榜（占名额 + 三排除）', () => {
  const m = buildModel(fixture());

  it('走正式队通道：占 place、吃奖牌带，其下队伍的名次与奖牌重排一位', () => {
    const plain = buildBoard(m, 5 * H, false);
    const b = buildBoard(m, 5 * H, false, false, [{ p: 1, ac: 100 }]);
    expect(b.rows.map((r) => r.ti)).toEqual([2, 1, -1, 0, 3, 4]);
    const g = b.rows.find((r) => r.ghost)!;
    expect(g).toMatchObject({ ti: -1, rank: 3, place: 2, medal: 'silver', srank: '', solved: 1, pen: 100 });
    const byTi = new Map(b.rows.map((r) => [r.ti, r]));
    const before = new Map(plain.rows.map((r) => [r.ti, r]));
    // 幽灵之下的队伍：名次 +1、奖牌往下挪一档（原来 gold 的 T1 不动，silver 的 T0 变 bronze）
    expect(before.get(0)).toMatchObject({ rank: 3, place: 2, medal: 'silver' });
    expect(byTi.get(0)).toMatchObject({ rank: 4, place: 3, medal: 'bronze' });
    expect(byTi.get(0)).toMatchObject({ rank: 4, place: 3, medal: 'bronze' });
    expect(byTi.get(3)).toMatchObject({ rank: 5, place: 4, medal: null });
    expect(byTi.get(1)!.medal).toBe('gold');
  });

  it('三排除：S# 不给号、列头读数不动、榜脚「累计过题」不计', () => {
    const plain = buildBoard(m, 5 * H, false);
    const b = buildBoard(m, 5 * H, false, false, [{ p: 1, ac: 100 }]);
    expect(b.rows.find((r) => r.ghost)?.srank).toBe('');
    // 幽灵的 B 题 AC 不进列头「过 N / 交 M」
    expect(b.col).toEqual(plain.col);
    // 榜脚累计过题 = 没有幽灵时一样（幽灵那 1 题不算）
    expect(b.solvedTotal).toBe(plain.solvedTotal);
    expect(b.solvedTotal).toBe(4);
    // S# 序号不被幽灵的「我的成绩」吃掉：北大头队照旧是 2
    const byTi = new Map(b.rows.map((r) => [r.ti, r]));
    expect(byTi.get(0)?.srank).toBe('2');
    expect(byTi.get(1)?.srank).toBe('1');
  });

  it('并列时 ti = -1 排在最前（沿用引擎既有 sameScore + (last, ti) 裁决）', () => {
    const b = buildBoard(m, 5 * H, false, false, [{ p: 1, ac: 60 }]);
    expect(b.rows.map((r) => r.ti)).toEqual([2, -1, 1, 0, 3, 4]);
    expect(b.rows.map((r) => r.rank)).toEqual([1, 2, 2, 4, 5, 6]);
  });

  it('仅正式队开着也显示：打星队退场，幽灵不是打星队', () => {
    const b = buildBoard(m, 5 * H, true, false, [{ p: 1, ac: 100 }]);
    expect(b.rows.map((r) => r.ti)).toEqual([1, -1, 0, 3, 4]);
    expect(b.rows.every((r) => !r.star)).toBe(true);
  });

  it('封榜带读数计入：幽灵的段内格也是「结果未知」', () => {
    const plain = buildBoard(m, 260 * M, false);
    const b = buildBoard(m, 260 * M, false, false, [{ p: 0, ac: 250 }]);
    expect([plain.frzCells, plain.frozenRows]).toEqual([1, 1]);
    expect([b.frzCells, b.frozenRows]).toEqual([2, 2]);
    const g = b.rows.find((r) => r.ghost)!;
    expect(g.cells[0]).toMatchObject({ st: 'frz', n: 1 });
    expect([g.solved, g.pen]).toEqual([0, 0]);
  });

  it('回顾解封视界：段内的 AC 进门次与罚时，格上带「封榜后」', () => {
    const b = buildBoard(m, 260 * M, false, true, [{ p: 0, ac: 250, fails: 1 }]);
    const g = b.rows.find((r) => r.ghost)!;
    expect(g.cells[0]).toMatchObject({ st: 'ac', post: true, n: 2 });
    expect([g.solved, g.pen]).toEqual([1, 250 + 20]);
    expect(b.frzCells).toBe(0);
  });

  it('ghostTeam 是合成队伍：ti = -1 / 队名「你」/ 校名「我的成绩」/ 机位「—」', () => {
    const b = buildBoard(m, 5 * H, false, false, [{ p: 1, ac: 100 }]);
    expect(b.ghostTeam).toMatchObject({ ti: -1, name: '你', org: '我的成绩', seat: '—', star: false, members: [] });
    expect(buildBoard(m, 5 * H, false).ghostTeam).toBeNull();
    expect(buildBoard(m, 5 * H, false, false, null).ghostTeam).toBeNull();
  });

  /** 13 题 A–M 的空场：只为把 mock v7 `GHOSTVAL` 的手算钉进单测（docs/20 §2.4 验收 1） */
  const sheet = buildModel({
    contest: { title: { 'zh-CN': '手算场' }, startAt: '', duration: [5, 'h'], frozenDuration: [0, 'h'] },
    problems: 'ABCDEFGHIJKLM'.split('').map((a) => ({ alias: a })),
    rows: [
      {
        user: { name: '参照队', id: 'R1', organization: '参照大学', official: true },
        statuses: [{ result: 'AC', time: [3600, 's'], tries: 1, solutions: [sol('AC', 60 * M)] }],
      },
    ],
  });
  const GHOSTVAL: GhostMark[] = [
    { p: 0, ac: 113 }, { p: 1, ac: 45, fails: 2 }, { p: 2, ac: 231 }, { p: 3, ac: 210 }, { p: 4, ac: 65 },
    { p: 5, ac: 40 }, { p: 6, ac: 187, fails: 1 }, { p: 7, ac: 96 }, { p: 8, ac: 88 }, { p: 9, ac: 55 },
    { p: 10, fails: 2 }, { p: 11, ac: 250 }, { p: 12, ac: 30 },
  ];

  it('手算：拖到 4:32 · 定格视角 = 11 过 / 罚时 1220（L 的 250′ 还在封榜段）', () => {
    const b = buildBoard(sheet, 272 * M, false, false, GHOSTVAL);
    const g = b.rows.find((r) => r.ghost)!;
    expect([g.solved, g.pen]).toEqual([11, 1220]);
    expect(g.cells[11]).toMatchObject({ st: 'frz', n: 1 }); // L：250′ 段内 → ?1
    expect(g.cells[10]).toMatchObject({ st: 'pen', t: 0, n: 2 }); // K：只 2 发、未过
    expect(g.cells[0]).toMatchObject({ st: 'ac', t: 113 * M, n: 1 });
  });

  it('手算：同一场关「封榜视角」（解封视界）= 12 过 / 罚时 1470', () => {
    const b = buildBoard(sheet, 272 * M, false, true, GHOSTVAL);
    const g = b.rows.find((r) => r.ghost)!;
    expect([g.solved, g.pen]).toEqual([12, 1470]);
    expect(g.cells[11]).toMatchObject({ st: 'ac', t: 250 * M, post: true });
    expect(b.frzCells).toBe(0);
  });

  it('未过题的失败不计罚时：K 的 2 发不进 pen，AC 前的失败才 ×20', () => {
    const b = buildBoard(sheet, 272 * M, false, false, [{ p: 0, ac: 100, fails: 1 }, { p: 1, fails: 9 }]);
    const g = b.rows.find((r) => r.ghost)!;
    expect([g.solved, g.pen]).toEqual([1, 100 + 20]);
  });
});

/* ---------- 弹层 ---------- */

describe('提交明细弹层', () => {
  const m = buildModel(fixture());

  it('逐次结果 + 时刻，语言照给', () => {
    const list = subsUntil(m.teams[0]!.subs[0] ?? [], 5 * H, 5 * H);
    expect(list.map((x) => [x.r, x.t])).toEqual([
      ['WA', 30 * M],
      ['WA', 60 * M],
      ['AC', 114 * M],
    ]);
    expect(list[0]?.language).toBe('C++17');
  });

  it('封榜段内的记录标 frozen，界面据此显示 Frozen 而不是判名', () => {
    const list = subsUntil(m.teams[3]!.subs[0] ?? [], 260 * M, capAt(260 * M, m.duration, m.freezeStart));
    expect(list).toHaveLength(1);
    expect(list[0]?.frozen).toBe(true);
    expect(list[0]?.r).toBe('AC');
  });

  it('elapsed 之后的提交不进弹层', () => {
    expect(subsUntil(m.teams[0]!.subs[0] ?? [], 45 * M, 45 * M).map((x) => x.r)).toEqual(['WA']);
  });
});

/* ---------- 时钟 ---------- */

describe('时钟与会话', () => {
  const dur = 5 * H;

  it('开钟后按真实时刻走', () => {
    const t0 = 1_000_000;
    const s = startSession(t0);
    expect(elapsedOf(s, dur, t0 + 90 * M)).toBe(90 * M);
  });

  it('续钟：中途回来 = now - started，超整场 = 落终局', () => {
    const started = Date.now() - 1000;
    expect(resume(started, dur, Date.now()).elapsed).toBeGreaterThanOrEqual(1000);
    const ancient = Date.now() - dur - 60_000;
    const r = resume(ancient, dur, Date.now());
    expect(r).toEqual({ elapsed: dur, ended: true });
    expect(resume(Date.now() + 5000, dur, Date.now())).toEqual({ elapsed: 0, ended: false });
  });

  it('暂停冻结读数，继续从那一秒接钟', () => {
    const t0 = 1_000_000;
    const s0 = startSession(t0);
    const e = 2 * H;
    const paused = pause(s0, e);
    expect(elapsedOf(paused, dur, t0 + 4 * H)).toBe(e);
    const later = unpause(paused, e, t0 + 4 * H);
    expect(later.paused).toBe(false);
    expect(later.hold).toBe(false);
    expect(elapsedOf(later, dur, t0 + 4 * H + 30 * M)).toBe(e + 30 * M);
  });

  it('走钟到点自动落回顾（ended + 滑条到终榜）', () => {
    const s = startSession(0);
    expect(tick(s, dur, 3 * H)).toEqual({ session: s, elapsed: 3 * H });
    const done = tick(s, dur, dur + 1);
    expect(done.session.ended).toBe(true);
    expect(done.session.hold).toBe(true);
    expect(done.session.scrubMs).toBe(dur);
    expect(done.elapsed).toBe(dur);
  });

  it('暂停中不会被走钟偷偷推进，也不会自动落回顾', () => {
    const paused = pause(startSession(0), 2 * H);
    const got = tick(paused, dur, dur + 1000);
    expect(got.elapsed).toBe(2 * H);
    expect(got.session.ended).toBe(false);
  });

  it('结束 = 停钟 + 落终榜', () => {
    const f = finish(startSession(0), dur);
    expect(f.hold).toBe(true);
    expect(f.ended).toBe(true);
    expect(f.at).toBe(dur);
    expect(elapsedOf(f, dur, Date.now())).toBe(dur);
  });
});
