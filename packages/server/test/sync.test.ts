import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { CfClient, CfError, PAGE_SIZE, parseSubmission } from '../src/sync/cf.ts';
import { META_HANDLE, syncOnce } from '../src/sync/job.ts';
import { countOffsite, countRatingContests, countSubmissions, getMeta, initSchema } from '../src/db.ts';

const TS = Math.floor(new Date(2026, 8, 1, 12).getTime() / 1000);

const sub = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  contestId: 2268,
  creationTimeSeconds: TS,
  relativeTimeSeconds: 3600,
  programmingLanguage: 'C++20 (GCC 13-64)',
  verdict: 'OK',
  problem: { contestId: 2268, index: 'A', name: 'Iron Anvil', rating: 1200, tags: ['math'] },
  author: { participantType: 'CONTESTANT' },
  ...over,
});

const ratingRow = (contestId = 2268, newRating = 1438) => ({
  contestId,
  contestName: 'Codeforces Round 1100 (Div. 2)',
  handle: 'tester',
  rank: 3,
  ratingUpdateTimeSeconds: TS,
  oldRating: 1400,
  newRating,
});

const ok = (result: unknown) => ({ status: 'OK', comment: '', result });

function makeClient(
  respond: (url: string, call: number) => unknown,
  opts: { failFirst?: number } = {},
): { urls: string[]; sleeps: number[]; client: CfClient } {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const client = new CfClient({
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (opts.failFirst !== undefined && urls.length <= opts.failFirst) throw new TypeError('fetch failed');
      return { status: 200, text: async () => JSON.stringify(respond(url, urls.length)) } as unknown as Response;
    }) as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => 0,
  });
  return { urls, sleeps, client };
}

const mem = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
};

const pageOne = Array.from({ length: PAGE_SIZE }, (_, i) => sub(300000000 - i));
const pageTwo = [sub(299989999), sub(299989998), sub(299989997)];

describe('全量同步：分页循环', () => {
  it('一页满就接着拉，不足一页收工', async () => {
    const db = mem();
    const f = makeClient((url) =>
      url.includes('user.rating')
        ? ok([ratingRow()])
        : ok(Number(new URL(url).searchParams.get('from')) === 1 ? pageOne : pageTwo),
    );

    const state = await syncOnce(db, 'tester', f.client);

    expect(state.phase).toBe('done');
    expect(state.pages).toBe(2);
    expect(state.fetched).toBe(PAGE_SIZE + 3);
    expect(state.stored).toBe(PAGE_SIZE + 3);
    expect(state.total).toBe(PAGE_SIZE + 3);
    expect(state.ratingContests).toBe(1);
    expect(countSubmissions(db)).toBe(PAGE_SIZE + 3);
    expect(f.urls.filter((u) => u.includes('user.status'))).toHaveLength(2);
    expect(f.urls.some((u) => u.includes('user.rating'))).toBe(true);
    db.close();
  });

  it('限速：除第一次外，每个请求前都等满 2 秒', async () => {
    const db = mem();
    const f = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok([sub(1), sub(2)])));
    await syncOnce(db, 'tester', f.client);
    expect(f.urls).toHaveLength(2);
    expect(f.sleeps).toEqual([2000]);
    db.close();
  });
});

describe('增量同步：遇到已存 id 即停', () => {
  it('第二次只拉新的一页，不重复落库', async () => {
    const db = mem();
    const full = makeClient((url) =>
      url.includes('user.rating')
        ? ok([ratingRow()])
        : ok(Number(new URL(url).searchParams.get('from')) === 1 ? pageOne : pageTwo),
    );
    await syncOnce(db, 'tester', full.client);
    const before = countSubmissions(db);

    // 新→旧：页首 2 条是新的，后面全是已存 id；凑满一页以证明靠「见存即停」退出
    const mixed = [sub(400001), sub(400002), ...pageOne.slice(0, PAGE_SIZE - 2)];
    const inc = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok(mixed)));
    const state = await syncOnce(db, 'tester', inc.client);

    expect(state.pages).toBe(1);
    expect(state.stored).toBe(2);
    expect(countSubmissions(db)).toBe(before + 2);
    expect(inc.urls.filter((u) => u.includes('user.status'))).toHaveLength(1);
    db.close();
  });

  it('全量重跑一次也不会多出记录', async () => {
    const db = mem();
    const first = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow(1), ratingRow(2)]) : ok([sub(1), sub(2), sub(3)])));
    const second = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow(1), ratingRow(2)]) : ok([sub(1), sub(2), sub(3)])));
    await syncOnce(db, 'tester', first.client);
    const state = await syncOnce(db, 'tester', second.client);
    expect(state.stored).toBe(0);
    expect(countSubmissions(db)).toBe(3);
    expect(countRatingContests(db)).toBe(2);
    db.close();
  });
});

describe('实测坑位', () => {
  it('relativeTimeSeconds 哨兵值 → NULL', () => {
    const r = parseSubmission(sub(1, { relativeTimeSeconds: 2147483647 }));
    expect(r.relativeTs).toBeNull();
    expect(parseSubmission(sub(2)).relativeTs).toBe(3600);
  });

  it('gym 题没有 rating / tags → NULL + 空数组', () => {
    const r = parseSubmission(
      sub(3, { contestId: 999999, problem: { contestId: 999999, index: 'C', name: 'Gym Problem', type: 'PROGRAMMING' } }),
    );
    expect(r.problemKey).toBe('cf:999999:C');
    expect(r.problemRating).toBeNull();
    expect(r.problemTagsJson).toBe('[]');
  });

  it('participantType 原样落库', () => {
    expect(parseSubmission(sub(4, { author: { participantType: 'VIRTUAL' } })).participantType).toBe('VIRTUAL');
  });

  it('哨兵值在库里记成场外数，同步状态如实报', async () => {
    const db = mem();
    const f = makeClient((url) =>
      url.includes('user.rating')
        ? ok([ratingRow()])
        : ok([sub(1, { relativeTimeSeconds: 2147483647 }), sub(2, { relativeTimeSeconds: 2147483647 }), sub(3)]),
    );
    const state = await syncOnce(db, 'tester', f.client);
    expect(state.offsite).toBe(2);
    expect(countOffsite(db)).toBe(2);
    db.close();
  });
});

describe('本地库只归属一个 handle', () => {
  it('换 handle：先清空重建，两个人的提交与同一场 rating 不叠加', async () => {
    const db = mem();
    const benq = makeClient((url) =>
      url.includes('user.rating') ? ok([ratingRow(2262, 3857)]) : ok([sub(1, { verdict: 'OK' }), sub(2, { verdict: 'OK' })]),
    );
    await syncOnce(db, 'Benq', benq.client);
    expect(countSubmissions(db)).toBe(2);

    const me = makeClient((url) =>
      url.includes('user.rating') ? ok([ratingRow(2262, 1278)]) : ok([sub(900), sub(901), sub(902)]),
    );
    const state = await syncOnce(db, 'jywlq', me.client);

    expect(state.resetNote).toContain('Benq');
    expect(state.stored).toBe(3);
    const ids = (db.prepare('SELECT id FROM submissions ORDER BY id').all() as { id: number }[]).map((r) => Number(r.id));
    expect(ids).toEqual([900, 901, 902]);
    // 同一 contest_id 不再被两个人的 rating 互相覆盖
    expect(countRatingContests(db)).toBe(1);
    expect(db.prepare('SELECT new_rating FROM rating_history WHERE contest_id = 2262').get()).toEqual({ new_rating: 1278 });
    db.close();
  });

  it('换 handle 但第一页没拉到：旧缓存原样留着，不空库', async () => {
    const db = mem();
    const first = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok([sub(1), sub(2)])));
    await syncOnce(db, 'Benq', first.client);

    const offline = makeClient(() => {
      throw new TypeError('fetch failed');
    });
    const state = await syncOnce(db, 'jywlq', offline.client);

    expect(state.phase).toBe('error');
    expect(state.resetNote).toContain('Benq');
    expect(countSubmissions(db)).toBe(2);
    expect(getMeta(db, META_HANDLE)).toBe('Benq');
    db.close();
  });

  it('同一个 handle 重复同步不清空', async () => {
    const db = mem();
    const first = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok([sub(1), sub(2)])));
    await syncOnce(db, 'jywlq', first.client);
    const second = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok([sub(1), sub(2)])));
    const state = await syncOnce(db, 'jywlq', second.client);
    expect(state.resetNote).toBeNull();
    expect(state.stored).toBe(0);
    expect(countSubmissions(db)).toBe(2);
    db.close();
  });

  it('空库首次同步不提清空', async () => {
    const db = mem();
    const f = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok([sub(1)])));
    const state = await syncOnce(db, 'jywlq', f.client);
    expect(state.resetNote).toBeNull();
    expect(countSubmissions(db)).toBe(1);
    db.close();
  });

  it('老库没有归属标记：清掉并说明「无法归属」', async () => {
    const db = mem();
    const f = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow()]) : ok([sub(1), sub(2)])));
    await syncOnce(db, 'Benq', f.client);
    db.prepare("DELETE FROM meta WHERE k = 'cf_handle'").run();

    const g = makeClient((url) => (url.includes('user.rating') ? ok([ratingRow(2270)]) : ok([sub(500)])));
    const state = await syncOnce(db, 'jywlq', g.client);
    expect(state.resetNote).toContain('无法归属');
    expect(countSubmissions(db)).toBe(1);
    db.close();
  });
});

describe('失败与错误文案', () => {
  it('非 OK 状态：不重试，给出可读错误', async () => {
    const db = mem();
    const f = makeClient(() => ({ status: 'FAILED', comment: 'handle not found of type [user]', result: null }));
    const state = await syncOnce(db, 'nope', f.client);
    expect(state.phase).toBe('error');
    expect(state.error).toContain('handle not found of type [user]');
    expect(f.urls).toHaveLength(1);
    expect(countSubmissions(db)).toBe(0);
    db.close();
  });

  it('临时故障：重试 3 次，指数退避', async () => {
    const f = makeClient(() => ok([sub(1)]), { failFirst: 2 });
    await expect(f.client.call('user.status', { handle: 'x', count: 1 })).resolves.toBeTruthy();
    expect(f.urls).toHaveLength(3);
    expect(f.sleeps).toContain(1000);
    expect(f.sleeps).toContain(2000);
  });

  it('一直连不上：报「已重试 3 次」', async () => {
    const f = makeClient(() => ok([]), { failFirst: Number.POSITIVE_INFINITY });
    await expect(f.client.call('user.status', { handle: 'x', count: 1 })).rejects.toMatchObject({
      name: 'CfError',
      kind: 'network',
    });
    expect(f.urls).toHaveLength(4);
    try {
      await f.client.call('user.status', { handle: 'x', count: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(CfError);
      expect((err as CfError).message).toContain('已重试 3 次');
    }
  });

  it('限流注释算临时故障', async () => {
    let n = 0;
    const f = makeClient(() =>
      ++n === 1
        ? { status: 'FAILED', comment: 'Calls to this method have been temporarily rate limited', result: null }
        : ok([sub(1)]),
    );
    await expect(f.client.call('user.status', { handle: 'x', count: 1 })).resolves.toBeTruthy();
    expect(f.urls).toHaveLength(2);
  });
});
