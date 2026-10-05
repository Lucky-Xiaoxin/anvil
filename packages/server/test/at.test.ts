import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  AtClient,
  AtError,
  SUBMISSIONS_PAGE_SIZE,
  atContestKey,
  createAtSource,
  parseAtHistory,
  parseAtSubmission,
  syncAt,
  type AtHistoryRaw,
  type AtSubmissionRaw,
} from '../src/sync/at.ts';
import {
  countDistinctOkProblems,
  countRatingContests,
  countRatingEntries,
  countSubmissions,
  getMeta,
  getSyncState,
  handleMetaKey,
  initSchema,
  insertSubmissions,
  loadRatingRows,
  setSyncState,
  submissionTimeRange,
  syncKey,
  upsertRatingHistory,
} from '../src/db.ts';

/** 上海日历的正午（04:00Z）：夹具不依赖运行机时区 */
const TS = Math.floor(Date.UTC(2026, 9, 1, 4) / 1000);

/** kenkoooo 提交明细一行（字段名照上游原样） */
const rawSub = (id: number, over: Partial<AtSubmissionRaw> = {}): AtSubmissionRaw => ({
  id,
  epoch_second: TS + id,
  problem_id: `abc300_${(id % 8) + 1}`,
  contest_id: 'abc300',
  user_id: 'tester',
  language: 'C++20 (GCC 13-64)',
  point: 100,
  length: 512,
  result: 'AC',
  execution_time: 120,
  ...over,
});

/** atcoder.jp/users/{h}/history/json 一条（字段名照上游原样） */
const rawHistory = (over: Partial<AtHistoryRaw> = {}): AtHistoryRaw => ({
  IsRated: true,
  Place: 59,
  OldRating: 1200,
  NewRating: 1345,
  Performance: 1455,
  InnerPerformance: 1455,
  ContestScreenName: 'abc300.contest.atcoder.jp',
  ContestName: 'AtCoder Beginner Contest 300',
  ContestNameEn: '',
  EndTime: '2023-04-29T22:45:00+09:00',
  ...over,
});

type Reply = { status: number; body: unknown };

function makeAt(
  respond: (url: string, call: number) => Reply,
  opts: { failFirst?: number } = {},
): AtClient & { urls: string[]; sleeps: number[] } {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const client = new AtClient({
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (opts.failFirst !== undefined && urls.length <= opts.failFirst) throw new TypeError('fetch failed');
      const r = respond(url, urls.length);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return { status: r.status, text: async () => text } as unknown as Response;
    }) as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => 0,
  });
  return Object.assign(client, { urls, sleeps });
}

const mem = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
};

/** 提交明细的假上游：`pages` 按 from_second 指定这一页给几条，没列出的页给空 */
function subsHandler(pages: { from: number; n: number }[], history: AtHistoryRaw[] = [rawHistory()]) {
  return ((url: string): Reply => {
    if (url.includes('/history/json')) return { status: 200, body: history };
    const from = Number(new URL(url).searchParams.get('from_second'));
    const n = pages.find((p) => p.from === from)?.n ?? 0;
    return {
      status: 200,
      body: Array.from({ length: n }, (_, i) => rawSub(from + i + 1, { epoch_second: from + i + 1 })),
    };
  }) as (url: string, call: number) => Reply;
}

const cfRow = (id: number) => ({
  id,
  contestId: 2268,
  problemKey: `cf:2268:${String.fromCharCode(64 + id)}`,
  problemName: 'A',
  problemRating: 800,
  problemTagsJson: '[]',
  verdict: 'OK',
  language: 'C++20',
  participantType: 'CONTESTANT',
  createdTs: TS,
  relativeTs: 60,
});

describe('kenkoooo 提交明细解析', () => {
  it('AC → OK、题键加 at: 前缀、contest_id 不塞进 INTEGER 列', () => {
    expect(parseAtSubmission(rawSub(1))).toMatchObject({
      id: 1,
      contestId: null,
      problemKey: 'at:abc300_2',
      verdict: 'OK',
      createdTs: TS + 1,
      relativeTs: null,
      participantType: null,
      language: 'C++20 (GCC 13-64)',
    });
  });

  it('非 AC 判定原样存，不进过题口径', () => {
    expect(parseAtSubmission(rawSub(2, { result: 'WA' })).verdict).toBe('WA');
    expect(parseAtSubmission(rawSub(3, { result: 'TLE' })).verdict).toBe('TLE');
  });

  it('难度 / 标签本切片不拉 → NULL；题号缺失退化到提交键，绝不把两道题并成一道', () => {
    const r = parseAtSubmission(rawSub(4, { problem_id: null }));
    expect(r.problemRating).toBeNull();
    expect(r.problemTagsJson).toBeNull();
    expect(r.problemKey).toBe('at:sub:4');
  });
});

describe('官方参赛史解析（docs/09 §2 的坑）', () => {
  it('ContestScreenName 去掉 .contest.atcoder.jp 后缀当 contest_key', () => {
    expect(atContestKey('agc078.contest.atcoder.jp')).toBe('agc078');
    expect(atContestKey('abc300.contest.atcoder.jp')).toBe('abc300');
    expect(atContestKey('code-festival-2015-final-open.contest.atcoder.jp')).toBe('code-festival-2015-final-open');
    // 上游哪天换了写法也别把整串后缀留在键里
    expect(atContestKey('abc300')).toBe('abc300');
  });

  it('EndTime(+09:00) → epoch 秒；Place → rank', () => {
    const r = parseAtHistory(rawHistory())!;
    expect(r.contestKey).toBe('abc300');
    expect(r.contestName).toBe('AtCoder Beginner Contest 300');
    expect(r.rank).toBe(59);
    expect(r.isRated).toBe(true);
    expect(r.performance).toBe(1455);
    expect(r.updatedTs).toBe(Math.floor(Date.parse('2023-04-29T22:45:00+09:00') / 1000));
  });

  it('IsRated:false 的平段：不入曲线、Perf 0 转 NULL、仍算一场参赛', () => {
    const r = parseAtHistory(
      rawHistory({ IsRated: false, OldRating: 2872, NewRating: 2872, Performance: 0, ContestScreenName: 'abc073.contest.atcoder.jp' }),
    )!;
    expect(r.isRated).toBe(false);
    expect(r.performance).toBeNull();
    expect(r.newRating).toBe(2872);
    expect(r.contestKey).toBe('abc073');
  });

  it('未上榜（Place 缺失或 0）→ rank null，界面渲染 —', () => {
    expect(parseAtHistory(rawHistory({ Place: null }))!.rank).toBeNull();
    expect(parseAtHistory(rawHistory({ Place: 0 }))!.rank).toBeNull();
  });

  it('EndTime 读不懂的行直接丢，别把 1970 塞进曲线', () => {
    expect(parseAtHistory(rawHistory({ EndTime: '不是时间' }))).toBeNull();
  });
});

describe('handle 校验走页面状态码', () => {
  it('200 → ok，404 → not-found；打的不是 history/json', async () => {
    const f = makeAt((url) => ({ status: url.includes('no_such') ? 404 : 200, body: 'ok' }));
    expect(await f.checkHandle('tester')).toEqual({ ok: true });
    expect(await f.checkHandle('no_such')).toMatchObject({ ok: false, kind: 'not-found' });
    expect(f.urls.every((u) => !u.includes('history'))).toBe(true);
    expect(f.urls[0]).toBe('https://atcoder.jp/users/tester');
  });

  it('非 200/404 归 unavailable，别让校验假装成功', async () => {
    const f = makeAt(() => ({ status: 503, body: 'down' }));
    expect(await f.checkHandle('tester')).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('200 + [] 不能用来判存在性：那是「没打过比赛」', async () => {
    const f = makeAt(() => ({ status: 200, body: [] }));
    expect(await f.history('tester')).toEqual([]);
  });
});

describe('kenkoooo 翻页与限流（2026-10-05 本机复测：每请求上限 500 条）', () => {
  it('一页铺满就接着拉，from_second 沿时间前沿推进', async () => {
    const db = mem();
    const f = makeAt(subsHandler([{ from: 0, n: SUBMISSIONS_PAGE_SIZE }]));
    const state = await syncAt(db, 'tester', f);

    expect(state.phase).toBe('done');
    const subUrls = f.urls.filter((u) => u.includes('user/submissions'));
    expect(subUrls).toHaveLength(2);
    expect(new URL(subUrls[1]!).searchParams.get('from_second')).toBe(String(SUBMISSIONS_PAGE_SIZE));
    expect(countSubmissions(db, 'at')).toBe(SUBMISSIONS_PAGE_SIZE);
    db.close();
  });

  it('不足一页 = 到底，一次拉完', async () => {
    const db = mem();
    const f = makeAt(subsHandler([{ from: 0, n: 3 }]));
    await syncAt(db, 'tester', f);
    expect(f.urls.filter((u) => u.includes('user/submissions'))).toHaveLength(1);
    expect(countSubmissions(db, 'at')).toBe(3);
    db.close();
  });

  it('同一秒挤满一页时停手，不原地打转', async () => {
    const db = mem();
    const f = makeAt(() => ({
      status: 200,
      body: Array.from({ length: SUBMISSIONS_PAGE_SIZE }, (_, i) => rawSub(1000 + i, { epoch_second: TS })),
    }));
    const state = await syncAt(db, 'tester', f);
    expect(state.phase).toBe('done');
    expect(f.urls.filter((u) => u.includes('user/submissions'))).toHaveLength(2);
    db.close();
  });

  it('全程串行：除第一次外每个请求前都等满 1 秒', async () => {
    const db = mem();
    const f = makeAt(subsHandler([{ from: 0, n: SUBMISSIONS_PAGE_SIZE }]));
    await syncAt(db, 'tester', f);
    expect(f.sleeps).toHaveLength(f.urls.length - 1);
    expect(f.sleeps.every((s) => s === 1000)).toBe(true);
    db.close();
  });

  it('增量同步从已存的最晚一条接着拉', async () => {
    const db = mem();
    await syncAt(db, 'tester', makeAt(subsHandler([{ from: 0, n: 3 }])));
    const max = submissionTimeRange(db, 'at')!.max;

    const second = makeAt(subsHandler([]));
    await syncAt(db, 'tester', second);
    expect(new URL(second.urls[0]!).searchParams.get('from_second')).toBe(String(max));
    db.close();
  });
});

describe('社区源退避重试（≤2 次）', () => {
  it('503 两次后成功', async () => {
    const db = mem();
    let n = 0;
    const f = makeAt(() => {
      n++;
      return n <= 2 ? { status: 503, body: 'Service Unavailable' } : { status: 200, body: [rawSub(1)] };
    });
    const state = await syncAt(db, 'tester', f);
    expect(state.phase).toBe('done');
    expect(countSubmissions(db, 'at')).toBe(1);
    expect(f.sleeps).toContain(1000);
    expect(f.sleeps).toContain(2000);
    db.close();
  });

  it('一直 5xx：报「已退避重试 2 次」，并把原因落进 at:last_error', async () => {
    const db = mem();
    const f = makeAt(() => ({ status: 503, body: 'down' }));
    const state = await syncAt(db, 'tester', f);
    expect(state.phase).toBe('error');
    expect(state.error).toContain('已退避重试 2 次');
    expect(getSyncState(db, syncKey('at', 'last_error'))).toContain('503');
    expect(f.urls).toHaveLength(3);
    db.close();
  });

  it('连不上：报网络错，不拖累另一源', async () => {
    const db = mem();
    insertSubmissions(db, 'cf', [cfRow(1)]);
    const f = makeAt(() => ({ status: 200, body: [] }), { failFirst: Number.POSITIVE_INFINITY });
    const state = await syncAt(db, 'tester', f);
    expect(state.phase).toBe('error');
    expect(countSubmissions(db, 'cf')).toBe(1);
    db.close();
  });

  it('上游回 HTML：转可读错误，不让 JSON.parse 抛穿', async () => {
    const db = mem();
    const f = makeAt(() => ({ status: 200, body: '<html>维护中</html>' }));
    const state = await syncAt(db, 'tester', f);
    expect(state.phase).toBe('error');
    expect(state.error).toContain('不是 JSON');
    db.close();
  });

  it('history 404 → AtError not-found', async () => {
    const f = makeAt(() => ({ status: 404, body: [] }));
    await expect(f.history('ghost')).rejects.toBeInstanceOf(AtError);
    await expect(f.history('ghost')).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('AT 同步作业', () => {
  it('提交 + 参赛史一起落库；同步状态写 at: 前缀键；快照不带 pages / offsite', async () => {
    const db = mem();
    const f = makeAt(
      subsHandler([{ from: 0, n: 3 }], [
        rawHistory({ ContestScreenName: 'abc300.contest.atcoder.jp', EndTime: '2023-04-29T22:45:00+09:00' }),
        rawHistory({
          IsRated: false,
          Place: 16,
          ContestScreenName: 'abc073.contest.atcoder.jp',
          EndTime: '2017-09-09T22:40:00+09:00',
        }),
      ]),
    );
    const state = await syncAt(db, 'tester', f);

    expect(state.phase).toBe('done');
    expect(state.total).toBe(3);
    expect(state.problems).toBe(3);
    expect(state.ratingContests).toBe(2); // AT 侧这个读数走「参赛 N 场」口径，含非 rated
    expect(countDistinctOkProblems(db, 'at')).toBe(3);
    expect(countRatingContests(db, 'at')).toBe(1); // 曲线只数 rated
    expect(loadRatingRows(db, 'at').map((r) => r.contestKey)).toEqual(['abc073', 'abc300']);
    expect(getSyncState(db, syncKey('at', 'last_sync_at'))).not.toBeNull();
    expect(getMeta(db, handleMetaKey('at'))).toBe('tester');
    // AT 没有分页 / 场外概念，快照里就不该出这两个键
    expect('pages' in state).toBe(false);
    expect('offsite' in state).toBe(false);
    db.close();
  });

  it('参赛史整域重建：上游撤掉的一场必须从本地消失，两源键序稳定', async () => {
    const db = mem();
    upsertRatingHistory(db, 'at', [
      { contestKey: 'abc299', contestName: 'ABC 299', rank: 1, oldRating: 0, newRating: 1, isRated: true, performance: null, updatedTs: TS },
    ]);
    await syncAt(
      db,
      'tester',
      makeAt(
        subsHandler([{ from: 0, n: 1 }], [
          rawHistory({ ContestScreenName: 'abc300.contest.atcoder.jp', EndTime: '2023-04-29T22:45:00+09:00' }),
          rawHistory({ IsRated: false, Place: 16, ContestScreenName: 'abc073.contest.atcoder.jp', EndTime: '2017-09-09T22:40:00+09:00' }),
        ]),
      ),
    );
    expect(countRatingEntries(db, 'at')).toBe(2);
    expect(countRatingContests(db, 'at')).toBe(1); // 曲线只数 rated
    expect(loadRatingRows(db, 'at').map((r) => r.contestKey)).toEqual(['abc073', 'abc300']);
    db.close();
  });

  it('200 + [] 判空：没提交没参赛，算成功不算错误', async () => {
    const db = mem();
    const state = await syncAt(db, 'tester', makeAt(() => ({ status: 200, body: [] })));
    expect(state.phase).toBe('done');
    expect(state.total).toBe(0);
    expect(state.error).toBeUndefined();
    expect(countSubmissions(db, 'at')).toBe(0);
    expect(countRatingEntries(db, 'at')).toBe(0);
    expect(getSyncState(db, syncKey('at', 'last_error'))).toBe('');
    db.close();
  });

  it('换 AT handle：清掉 AT 旧数据为新人重建，CF 一行不动', async () => {
    const db = mem();
    insertSubmissions(db, 'cf', [cfRow(1)]);
    upsertRatingHistory(db, 'cf', [
      { contestKey: '2268', contestName: 'Round', rank: 5, oldRating: 1400, newRating: 1438, isRated: true, performance: null, updatedTs: TS },
    ]);
    setSyncState(db, syncKey('cf', 'last_sync_at'), '1789000000');

    await syncAt(db, 'oldGuy', makeAt(subsHandler([{ from: 0, n: 2 }])));
    expect(countSubmissions(db, 'at')).toBe(2);

    const state = await syncAt(db, 'newGuy', makeAt(subsHandler([{ from: 0, n: 1 }])));

    expect(state.resetNote).toContain('oldGuy');
    expect(countSubmissions(db, 'at')).toBe(1);
    expect(countRatingEntries(db, 'at')).toBe(1);
    expect(getMeta(db, handleMetaKey('at'))).toBe('newGuy');
    expect(countSubmissions(db, 'cf')).toBe(1);
    expect(countRatingContests(db, 'cf')).toBe(1);
    expect(getSyncState(db, syncKey('cf', 'last_sync_at'))).toBe('1789000000');
    db.close();
  });

  it('换 handle 但第一页就没拉到：旧缓存原样留着，不空库', async () => {
    const db = mem();
    await syncAt(db, 'oldGuy', makeAt(subsHandler([{ from: 0, n: 2 }])));

    const state = await syncAt(db, 'newGuy', makeAt(subsHandler([]), { failFirst: 99 }));
    expect(state.phase).toBe('error');
    expect(countSubmissions(db, 'at')).toBe(2);
    expect(getMeta(db, handleMetaKey('at'))).toBe('oldGuy');
    db.close();
  });

  it('提交成功但参赛史失败：提交留在库里当缓存，错误如实报', async () => {
    const db = mem();
    const respond = subsHandler([{ from: 0, n: 2 }]);
    const f = makeAt((url, call) => (url.includes('/history/json') ? { status: 500, body: 'boom' } : respond(url, call)));
    const state = await syncAt(db, 'tester', f);
    expect(state.phase).toBe('error');
    expect(countSubmissions(db, 'at')).toBe(2);
    expect(getSyncState(db, syncKey('at', 'last_error'))).toContain('500');
    db.close();
  });

  it('进度按源上报：fetching → storing → done', async () => {
    const db = mem();
    const phases: string[] = [];
    await syncAt(db, 'tester', makeAt(subsHandler([{ from: 0, n: 2 }])), (s) => phases.push(s.phase));
    expect(phases).toEqual(['fetching', 'storing', 'done']);
    db.close();
  });

  it('SyncSource 接口形状冻结：id / checkHandle / sync（docs/09 §3.3）', () => {
    const db = mem();
    const source = createAtSource(db, makeAt(subsHandler([])));
    expect(source.id).toBe('at');
    expect(typeof source.checkHandle).toBe('function');
    expect(typeof source.sync).toBe('function');
    db.close();
  });
});
