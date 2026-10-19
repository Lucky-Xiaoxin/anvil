/**
 * XCPC 服务端单测（docs/14 §7）。一律 mock fetch —— 单测禁止打真实网络（技术锁）。
 * 夹具是真实快照裁剪件：`李鑫杰@佛山大学` 的 PlayerDetail（skillPanel 已删）+ 同分片里
 * 一条真实的 official:false 打星行。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { countSubmissions, getSyncState, initSchema, loadXcpcPlayer, replaceXcpcPlayer, setSyncState, syncKey, upsertRatingHistory } from '../src/db.ts';
import { registerApi } from '../src/api.ts';
import { ArenaClient } from '../src/arena.ts';
import {
  MISSING_IN_SNAPSHOT,
  XCPC_STALE_AFTER_DAYS,
  XcpcClient,
  XcpcError,
  bucketOf,
  claimXcpc,
  refreshXcpc,
  shardOf,
  snapshotAgeDays,
  toPlayerDto,
  xcpcProfile,
  xcpcStatus,
  type XcpcStore,
} from '../src/sync/xcpc.ts';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/xcpc-player.json', import.meta.url), 'utf8')) as {
  snapshotAt: string;
  rankTotal: number;
  detail: Record<string, unknown>;
  starRow: { key: string; row: Record<string, unknown> };
};
const KEY = '李鑫杰@佛山大学';
const BASE = 'https://heimaom.cn/data/';

/* ---------- mock fetch：未登记的路径一律 404（= 空桶 / 没有这个文件） ---------- */

interface Mock {
  client: XcpcClient;
  calls: string[];
  /** 让包含 needle 的请求挂住不返回，用来演互斥；release 之前一直悬着 */
  hang: (needle: string) => void;
  release: () => void;
}

const reply = (status: number, body: unknown) =>
  ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }) as Response;

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

function mock(routes: Record<string, unknown>, extra: { fail?: string[]; serverError?: string[] } = {}): Mock {
  const calls: string[] = [];
  let blocked: { needle: string; gate: Gate } | null = null;
  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = String(typeof input === 'string' ? input : (input as { url: string }).url);
    calls.push(url);
    if (extra.fail?.some((f) => url.includes(f))) throw new Error('ECONNREFUSED');
    if (extra.serverError?.some((f) => url.includes(f))) return reply(503, '{}');
    if (blocked !== null && url.includes(blocked.needle)) await blocked.gate.promise;
    const hit = routes[url];
    return hit === undefined ? reply(404, '{}') : reply(200, hit);
  };

  return {
    calls,
    client: new XcpcClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    hang: (needle: string) => {
      blocked = { needle, gate: gate() };
    },
    release: () => {
      blocked?.gate.open();
    },
  };
}

const bucketUrl = (hex: string) => `${BASE}search/players/${hex}.json`;
/** 快照日期跟着「现在」走：状态判定按真实时钟算，钉死夹具日期会让 ok / down 断言在 10 天后集体过期 */
const META = { generatedAt: new Date(Date.now() - 86_400_000).toISOString(), counts: { players: 68940 } };
const LB = { total: FIX.rankTotal, pageSize: 100, pageCount: 632 };
/** store() 额外带一个读回认领标记的口，方便断言 */
type Store = XcpcStore & { key: () => string };

const ROW = [KEY, '李鑫杰', '佛山大学', 3] as const;

function claimRoutes(rows: readonly unknown[] = [ROW]): Record<string, unknown> {
  return {
    [`${BASE}players/${shardOf(KEY)}.json`]: { [KEY]: FIX.detail },
    [`${BASE}meta.json`]: META,
    [`${BASE}leaderboards/official/meta.json`]: LB,
    [bucketUrl(bucketOf('李'))]: rows,
  };
}

/* ---------- 库 + 认领标记 ---------- */

const mem = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
};

function store(db: DatabaseSync): Store {
  let key = '';
  return {
    db,
    key: () => key,
    getKey: () => key,
    setKey: (next: string) => {
      key = next;
    },
  };
}

/* ---------- 分桶键与声母 ---------- */

describe('分桶键（docs/14 §2.1）', () => {
  it('详情分片 = md5(key)[:2]，与实测的 b1 一致', () => {
    expect(shardOf(KEY)).toBe('b1');
  });

  it('桶名 = md5(小写首字符)[:2]：姓名首字与校名首字各入一桶', () => {
    expect(bucketOf('李')).toBe('46');
    expect(bucketOf('佛')).toBe('20');
    expect(bucketOf('lxj')).toBe('2d');
    expect(bucketOf('chi')).toBe('4a');
  });
});

/* ---------- 搜索 ---------- */

describe('搜索一段式（docs/14 §2.2 修订版：拼音检索已取消）', () => {
  it('首字符进桶、桶内对姓名 + 校名做子串匹配：只发一个桶请求', async () => {
    const m = mock(claimRoutes());
    const out = await m.client.search('李');
    expect(out).toEqual([{ key: KEY, name: '李鑫杰', org: '佛山大学', contests: 3 }]);
    expect(m.calls).toEqual([bucketUrl('46')]);
  });

  it('校名同样能搜 —— 从校名第一个字起头', async () => {
    const m = mock({ [bucketUrl('20')]: [ROW] });
    expect((await m.client.search('佛山大学')).map((r) => r.key)).toEqual([KEY]);
  });

  it('固有边界：中间词搜不到（「邮电」进的是「邮」的桶，不是北京邮电大学）', async () => {
    const m = mock(claimRoutes());
    expect(await m.client.search('邮电')).toEqual([]);
    expect(m.calls).toEqual([bucketUrl(bucketOf('邮'))]);
  });

  it('拼音串不再触发 256 桶兜底全扫', async () => {
    const m = mock({ [bucketUrl('2d')]: [ROW] });
    expect(await m.client.search('lxj')).toEqual([]);
    expect(m.calls.filter((u) => u.includes('/search/players/'))).toHaveLength(1);
  });

  it('查询串先 trim + 小写，再取第一个码点', async () => {
    const latin = ['K9', 'Li Lei', '佛山大学', 1];
    const m = mock({ [bucketUrl('2d')]: [latin] });
    expect((await m.client.search('  LI LEI ')).map((r) => r.key)).toEqual(['K9']);
    expect(m.calls).toEqual([bucketUrl('2d')]);
  });

  it('空串与纯空白不发请求', async () => {
    const m = mock({});
    expect(await m.client.search('')).toEqual([]);
    expect(await m.client.search('   ')).toEqual([]);
    expect(m.calls).toEqual([]);
  });

  it('404 桶按空处理，不算不可达', async () => {
    const m = mock({});
    expect(await m.client.search('李')).toEqual([]);
  });

  it('结果上限 8 条', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`K${i}`, `李${i}`, '佛山大学', 1]);
    const m = mock({ [bucketUrl('46')]: rows });
    expect(await m.client.search('李')).toHaveLength(8);
  });

  it('桶硬失败 → 抛出转 502；错误串只带原因，不带主机名与路径', async () => {
    const m = mock({}, { serverError: ['search/players'] });
    const err = await m.client.search('李').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XcpcError);
    expect((err as XcpcError).message).toBe('HTTP 503 · 已重试 1 次');
    expect((err as XcpcError).message).not.toContain('heimaom');
  });
});

/* ---------- DTO 映射 ---------- */

describe('官方单口径映射（docs/14 §4）', () => {
  it('取的是 *Official 套装，数值原样给', () => {
    const player = toPlayerDto(FIX.detail)!;
    expect(player.key).toBe(KEY);
    expect(player.officialRating).toBe(1353.13);
    expect(player.officialRank).toBe(41867);
    expect(player.contests).toBe(3);
    const first = player.history[0]!;
    expect(first).toMatchObject({
      rank: 119,
      teams: 232,
      perf: 1412.52,
      ratingAfter: 1394.04,
      star: false,
      // solved / dirt / firstATime 不是官方榜字段，保留真实值
      solved: 4,
      dirt: 1.5,
      firstATime: 21.03,
    });
    expect(first.rankPercent).toBeCloseTo(51.293103448275865, 9);
  });

  /** 真实样本自带对照：省赛那条不是网络赛，两场 EC 网络预选赛是 */
  it('网络赛标签 = contestId 含 preliminary 且标题表态（网络 / Online）', () => {
    const online = (contestId: string, title: string): boolean => {
      const base = (FIX.detail.history as Record<string, unknown>[])[0]!;
      const detail = { ...FIX.detail, history: [{ ...base, contestId, title }] };
      return toPlayerDto(detail)!.history[0]!.online;
    };
    expect(online('ccpc__ccpc2022__ccpc2022preliminary', '2022 年中国大学生程序设计竞赛网络预选赛')).toBe(true);
    expect(online('icpc__icpc2022__icpc2022preliminary-2', 'The 2022 ICPC Asia Regionals Online Contest (II)')).toBe(true);
    // 这两条是真实数据里的误伤样本：id 带 preliminary，但那是"预赛 / 初赛"
    expect(online('ccpc__ccpc2025__ccpc2025invitational-guangdong-preliminary', '2025 年（第二十二届）广东省大学生程序设计竞赛邀请赛（广东）预赛')).toBe(false);
    expect(online('provincial__ah__ahcpc2026preliminary', '2026年安徽省机器人大赛——算法设计赛道 初赛')).toBe(false);
    expect(online('provincial__gd__gdcpc23rd', '广东省第二十三届大学生程序设计竞赛')).toBe(false);

    const real = toPlayerDto(FIX.detail)!.history;
    expect(real.map((r) => r.online)).toEqual([false, true, true]);
  });

  it('tier 只认四档，缺失或不认识的值 → null（界面给 —，不硬套一档）', () => {
    const tierOf = (tier: unknown): unknown => {
      const base = (FIX.detail.history as Record<string, unknown>[])[0]!;
      return toPlayerDto({ ...FIX.detail, history: [{ ...base, tier }] })!.history[0]!.tier;
    };
    expect(tierOf('provincial')).toBe('provincial');
    expect(tierOf(null)).toBeNull();
    expect(tierOf(undefined)).toBeNull();
    expect(tierOf('preliminary')).toBeNull();
  });

  it('打星行：star 为真、官方套装整组 null，过题数照给', () => {
    const detail = { ...FIX.detail, history: [FIX.starRow.row] };
    const row = toPlayerDto(detail)!.history[0]!;
    expect(row).toMatchObject({
      star: true,
      rank: null,
      teams: null,
      rankPercent: null,
      perf: null,
      ratingAfter: null,
      solved: 7,
    });
  });

  it('medals 缺字段 / 零奖牌 tier 都不炸（读时 defensive）', () => {
    expect(toPlayerDto({ ...FIX.detail, medals: undefined })!.medals).toEqual({});
    const p = toPlayerDto({ ...FIX.detail, medals: { provincial: { gold: 0, silver: 0, bronze: 1 }, final: { gold: 0 } } })!;
    expect(p.medals).toEqual({ provincial: { bronze: 1 } });
  });

  it('history 不是数组也不炸', () => {
    expect(toPlayerDto({ key: 'x', history: null })!.history).toEqual([]);
  });
});

/* ---------- claim ---------- */

describe('claim（docs/14 §4）', () => {
  it('成功：三个请求都到位才落库 + 写 config', async () => {
    const db = mem();
    const s = store(db);
    const m = mock(claimRoutes());
    const profile = await claimXcpc(s, m.client, KEY);
    expect(profile.rankTotal).toBe(FIX.rankTotal);
    expect(profile.snapshotAt).toBe(META.generatedAt);
    expect(m.calls).toHaveLength(3);
    const row = loadXcpcPlayer(db)!;
    expect(row.key).toBe(KEY);
    expect(row.snapshotAt).toBe(META.generatedAt);
    expect(JSON.parse(row.payload).name).toBe('李鑫杰');
    expect(s.key()).toBe(KEY);
    expect(getSyncState(db, syncKey('xcpc', 'last_sync_at'))).not.toBeNull();
    db.close();
  });

  it('setKey 失败会回滚旧档案，不把 DB 和 config 拆成两个 key', async () => {
    const db = mem();
    const other = '陈一鸣@南京邮电大学';
    replaceXcpcPlayer(db, {
      key: other,
      payload: JSON.stringify({ ...FIX.detail, key: other, name: '陈一鸣' }),
      snapshotAt: META.generatedAt,
      rankTotal: FIX.rankTotal,
      fetchedAt: 1,
    });
    setSyncState(db, syncKey('xcpc', 'last_sync_at'), '222');
    setSyncState(db, syncKey('xcpc', 'last_error'), 'old');
    let key = other;
    const failingStore: XcpcStore = {
      db,
      getKey: () => key,
      setKey: () => {
        throw new Error('EPERM');
      },
    };
    const m = mock(claimRoutes());
    await expect(claimXcpc(failingStore, m.client, KEY)).rejects.toThrow('EPERM');
    expect(loadXcpcPlayer(db)?.key).toBe(other);
    expect(key).toBe(other);
    expect(getSyncState(db, syncKey('xcpc', 'last_sync_at'))).toBe('222');
    expect(getSyncState(db, syncKey('xcpc', 'last_error'))).toBe('old');
    db.close();
  });

  it('单档案语义：换人把旧档案整域清掉', async () => {
    const db = mem();
    const s = store(db);
    const other = '陈一鸣@南京邮电大学';
    const routes = claimRoutes();
    const urlA = `${BASE}players/${shardOf(KEY)}.json`;
    const urlB = `${BASE}players/${shardOf(other)}.json`;
    // 两个 key 各自的 md5 前缀可能撞同一片，合并成同一张表最省事
    const merged = {
      ...(routes[urlA] as Record<string, unknown>),
      ...(routes[urlB] as Record<string, unknown>),
      [other]: { ...FIX.detail, key: other, name: '陈一鸣' },
    };
    routes[urlA] = merged;
    routes[urlB] = merged;
    const m = mock(routes);
    await claimXcpc(s, m.client, KEY);
    await claimXcpc(s, m.client, other);
    const rows = db.prepare('SELECT key FROM xcpc_players').all() as { key: string }[];
    expect(rows.map((r) => r.key)).toEqual([other]);
    expect(s.key()).toBe(other);
    db.close();
  });

  it('分片里没这个 key → not-found，现状不动', async () => {
    const db = mem();
    const s = store(db);
    const m = mock({ [`${BASE}meta.json`]: META, [`${BASE}leaderboards/official/meta.json`]: LB });
    await expect(claimXcpc(s, m.client, '不存在@不存在')).rejects.toMatchObject({ kind: 'not-found' });
    expect(loadXcpcPlayer(db)).toBeNull();
    expect(s.key()).toBe('');
    db.close();
  });

  it('上游不在线 → unavailable，且没写脏库', async () => {
    const db = mem();
    const s = store(db);
    const routes = claimRoutes();
    delete routes[`${BASE}meta.json`];
    const m = mock(routes, { fail: ['meta.json'] });
    await expect(claimXcpc(s, m.client, KEY)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(loadXcpcPlayer(db)).toBeNull();
    expect(getSyncState(db, syncKey('xcpc', 'last_error'))).toBeNull();
    db.close();
  });

  it('进行中再来一次 → busy（进程内串行）', async () => {
    const db = mem();
    const s = store(db);
    const m = mock(claimRoutes());
    m.hang(`players/${shardOf(KEY)}`);
    const first = claimXcpc(s, m.client, KEY);
    await expect(claimXcpc(s, m.client, KEY)).rejects.toMatchObject({ kind: 'busy' });
    m.release();
    await expect(first).resolves.toBeTruthy();
    db.close();
  });

  it('官方榜分母 404 不挡认领：rankTotal 交回 null，界面显示 —', async () => {
    const db = mem();
    const s = store(db);
    const routes = claimRoutes();
    delete routes[`${BASE}leaderboards/official/meta.json`];
    const m = mock(routes);
    const profile = await claimXcpc(s, m.client, KEY);
    expect(profile.rankTotal).toBeNull();
    expect(loadXcpcPlayer(db)!.rankTotal).toBeNull();
    db.close();
  });

  it('认领会先清缓存：旧版本的桶不会顶替现行快照', async () => {
    const db = mem();
    const s = store(db);
    const m = mock(claimRoutes());
    await m.client.search('李');                 // 暖桶
    await claimXcpc(s, m.client, KEY);
    await m.client.search('李');                 // 缓存已被认领清掉 → 重新打桶
    expect(m.calls.filter((u) => u === bucketUrl(bucketOf('李')))).toHaveLength(2);
    db.close();
  });
});

/* ---------- refresh ---------- */

describe('refresh（docs/14 §4）', () => {
  async function claimed(): Promise<{ db: DatabaseSync; s: Store; routes: Record<string, unknown>; calls: string[] }> {
    const db = mem();
    const s = store(db);
    const routes = claimRoutes();
    const m = mock(routes);
    await claimXcpc(s, m.client, KEY);
    return { db, s, routes, calls: m.calls };
  }

  it('版本没变：只更 last_sync_at，不重拉分片', async () => {
    const { db, s, routes } = await claimed();
    const before = loadXcpcPlayer(db)!;
    const m = mock(routes);
    const out = await refreshXcpc(s, m.client);
    expect(out.updated).toBe(false);
    expect(out.status).toBe('ok');
    // 只打了 meta.json
    expect(m.calls.filter((u) => u.includes('/players/'))).toHaveLength(0);
    expect(loadXcpcPlayer(db)!.fetchedAt).toBe(before.fetchedAt);
    expect(Number(getSyncState(db, syncKey('xcpc', 'last_sync_at')))).toBeGreaterThanOrEqual(before.fetchedAt);
    db.close();
  });

  it('新版快照：重拉分片与分母，档案整份换新', async () => {
    const { db, s, routes } = await claimed();
    const newer = '2026-10-06T03:00:00.000000+00:00';
    const next: Record<string, unknown> = { ...routes, [`${BASE}meta.json`]: { ...META, generatedAt: newer } };
    const detail = next[`${BASE}players/b1.json`] as Record<string, Record<string, unknown>>;
    detail[KEY] = { ...detail[KEY], officialRating: 1401.5, contests: 4 };
    const m = mock(next);
    const out = await refreshXcpc(s, m.client);
    expect(out.updated).toBe(true);
    expect(out.snapshotAt).toBe(newer);
    expect(out.player.officialRating).toBe(1401.5);
    expect(m.calls.some((u) => u.includes('/players/'))).toBe(true);
    expect(loadXcpcPlayer(db)!.snapshotAt).toBe(newer);
    db.close();
  });

  it('新版里找不到这个 key：保留旧数据 + last_error，状态转 down', async () => {
    const { db, s, routes } = await claimed();
    const before = loadXcpcPlayer(db)!;
    const newer = '2026-10-06T03:00:00.000000+00:00';
    const next = {
      ...routes,
      [`${BASE}meta.json`]: { ...META, generatedAt: newer },
      [`${BASE}players/b1.json`]: { SomeoneElse: FIX.detail },
    };
    const out = await refreshXcpc(s, mock(next).client);
    expect(out.updated).toBe(false);
    expect(out.status).toBe('down');
    const row = loadXcpcPlayer(db)!;
    expect(row.snapshotAt).toBe(before.snapshotAt);
    expect(row.payload).toBe(before.payload);
    expect(getSyncState(db, syncKey('xcpc', 'last_error'))).toBe(MISSING_IN_SNAPSHOT);
    expect(xcpcStatus(s).status).toBe('down');
    db.close();
  });

  it('meta 拉不通：写 last_error 并抛出（502）', async () => {
    const { db, s, routes } = await claimed();
    const m = mock(routes, { fail: ['meta.json'] });
    await expect(refreshXcpc(s, m.client)).rejects.toBeInstanceOf(XcpcError);
    expect(getSyncState(db, syncKey('xcpc', 'last_error'))).toContain('ECONNREFUSED');
    db.close();
  });

  it('失败后同版本重试成功：last_error 清掉，红点不留在屏上', async () => {
    const { db, s, routes } = await claimed();
    await expect(refreshXcpc(s, mock(routes, { fail: ['meta.json'] }).client)).rejects.toBeInstanceOf(XcpcError);
    expect(xcpcStatus(s).status).toBe('down');

    const before = loadXcpcPlayer(db)!;
    const out = await refreshXcpc(s, mock(routes).client);
    expect(out.updated).toBe(false);
    expect(out.status).toBe('ok');
    expect(getSyncState(db, syncKey('xcpc', 'last_error'))).toBe('');
    expect(xcpcStatus(s).error).toBeNull();
    expect(loadXcpcPlayer(db)!.payload).toBe(before.payload);
    db.close();
  });

  it('换版本：同一个 client 里先清缓存再取数，旧分片不顶替新版本', async () => {
    const db = mem();
    const s = store(db);
    const routes: Record<string, unknown> = claimRoutes();
    const m = mock(routes);
    await claimXcpc(s, m.client, KEY);           // 这一步把分片暖进了缓存

    const newer = '2026-10-06T03:00:00.000000+00:00';
    routes[`${BASE}meta.json`] = { ...META, generatedAt: newer };
    routes[`${BASE}players/${shardOf(KEY)}.json`] = { [KEY]: { ...FIX.detail, officialRating: 1500.25 } };

    const out = await refreshXcpc(s, m.client);
    expect(out.updated).toBe(true);
    expect(out.snapshotAt).toBe(newer);
    expect(out.player.officialRating).toBe(1500.25);
    expect(loadXcpcPlayer(db)!.snapshotAt).toBe(newer);
    db.close();
  });
});

/* ---------- 状态四态 ---------- */

describe('XCPC 状态（docs/14 §4）', () => {
  const NOW = Date.UTC(2026, 9, 6, 4) / 1000;
  const day = 86_400;

  async function claimedWith(snapshotAt: string): Promise<{ db: DatabaseSync; s: Store }> {
    const db = mem();
    const s = store(db);
    const routes = { ...claimRoutes(), [`${BASE}meta.json`]: { ...META, generatedAt: snapshotAt } };
    await claimXcpc(s, mock(routes).client, KEY);
    return { db, s };
  }

  it('未认领 = idle', async () => {
    const db = mem();
    expect(xcpcStatus(store(db), NOW * 1000)).toMatchObject({ claimed: false, status: 'idle', key: null });
    db.close();
  });

  it('快照日期距今 > 10 天才算 stale（看数据版本，不看本地同步时刻）', async () => {
    const fresh = new Date((NOW - (XCPC_STALE_AFTER_DAYS - 1) * day) * 1000).toISOString();
    const { db, s } = await claimedWith(fresh);
    expect(xcpcStatus(s, NOW * 1000).status).toBe('ok');
    db.close();

    const old = new Date((NOW - (XCPC_STALE_AFTER_DAYS + 1) * day) * 1000).toISOString();
    const b2 = await claimedWith(old);
    const st = xcpcStatus(b2.s, NOW * 1000);
    expect(st.status).toBe('stale');
    expect(st.snapshotAt).toBe(old);
    b2.db.close();
  });

  it('生成天数是真实时长（带小数）：过期判定按它比 10 天，界面读数才取整', () => {
    const days = snapshotAgeDays('2026-09-28T19:57:35.521003+00:00', Date.UTC(2026, 9, 6));
    expect(Math.floor(days!)).toBe(7);
    expect(days!).toBeLessThan(8);
    expect(snapshotAgeDays(null)).toBeNull();
  });

  it('officialRating 从库里带出来，tab 条与设置页共用', async () => {
    const { db, s } = await claimedWith(META.generatedAt);
    expect(xcpcStatus(s)).toMatchObject({ claimed: true, key: KEY, officialRating: 1353.13 });
    expect(xcpcProfile(s)!.player.contests).toBe(3);
    db.close();
  });

  it('清掉 last_error 之后不飘红：空串不算 down', async () => {
    const { db, s } = await claimedWith(META.generatedAt);
    getSyncState(db, syncKey('xcpc', 'last_error'));
    expect(xcpcStatus(s).status).toBe('ok');
    db.close();
  });
});

/* ---------- 迁移：v2 → v3 无损 ---------- */

describe('schema v3 迁移', () => {
  const TS = Math.floor(Date.UTC(2026, 9, 2, 4) / 1000);

  /** v2 原样形状（没有 xcpc_players），模拟用户手里的真库 */
  const DDL_V2 = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE submissions (
  source TEXT NOT NULL DEFAULT 'cf', id INTEGER NOT NULL, contest_id INTEGER, problem_key TEXT NOT NULL,
  problem_name TEXT, problem_rating INTEGER, problem_tags_json TEXT, verdict TEXT, language TEXT,
  participant_type TEXT, created_ts INTEGER NOT NULL, relative_ts INTEGER, PRIMARY KEY (source, id));
CREATE TABLE rating_history (
  source TEXT NOT NULL, contest_key TEXT NOT NULL, contest_name TEXT, rank INTEGER, old_rating INTEGER,
  new_rating INTEGER, is_rated INTEGER NOT NULL DEFAULT 1, performance INTEGER, updated_ts INTEGER,
  PRIMARY KEY (source, contest_key));
CREATE TABLE sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta(k, v) VALUES ('schema_version', '2'), ('cf_handle', 'jywlq');
`;

  it('v2 库直接补表，CF / AT 数据一根毛不动', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL_V2);
    db.prepare(
      `INSERT INTO submissions (source, id, problem_key, verdict, created_ts) VALUES
        ('cf', 1, 'cf:2268:A', 'OK', ?), ('at', 1, 'at:abc300_a', 'OK', ?)`,
    ).run(TS, TS);
    upsertRatingHistory(db, 'cf', [
      { contestKey: '2268', contestName: 'Round', rank: 5, oldRating: 1400, newRating: 1438, isRated: true, performance: null, updatedTs: TS },
    ]);

    initSchema(db);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'xcpc_players'").get()).toBeTruthy();
    expect(countSubmissions(db, 'cf')).toBe(1);
    expect(countSubmissions(db, 'at')).toBe(1);
    expect(getSyncState(db, syncKey('cf', 'last_sync_at'))).toBeNull();
    expect(db.prepare("SELECT v FROM meta WHERE k = 'cf_handle'").get()).toEqual({ v: 'jywlq' });
    expect(db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()).toEqual({ v: '3' });

    // 幂等：再跑一遍不炸、数据不多不少
    initSchema(db);
    initSchema(db);
    expect(countSubmissions(db, 'cf')).toBe(1);
    expect(countSubmissions(db, 'at')).toBe(1);
    db.close();
  });
});

/* ---------- 路由 ---------- */

describe('XCPC 路由（docs/14 §4）', () => {
  async function boot(
    routes: Record<string, unknown>,
    opts: { claim?: boolean; fail?: string[] } = {},
  ): Promise<{ app: FastifyInstance; s: Store }> {
    const db = mem();
    const s = store(db);
    const m = mock(routes, { fail: opts.fail });
    const app = Fastify();
    registerApi(app, {
      db,
      sources: {
        cf: { id: 'cf', checkHandle: async () => ({ ok: true }), sync: async () => DONE },
        at: { id: 'at', checkHandle: async () => ({ ok: true }), sync: async () => DONE },
      },
      getHandles: () => ({ cf: '', at: '' }),
      setHandles: () => {},
      xcpc: { db, getKey: s.getKey, setKey: s.setKey, client: m.client },
      arena: new ArenaClient({ fetchImpl: async () => { throw new Error('本文件不测 arena'); }, dir: join(tmpdir(), 'anvil-arena-xcpc-test') }),
    });
    await app.ready();
    // 认领态必须真的落一行：只写 config 标记不建行，状态判定会退回未认领
    if (opts.claim) await app.inject({ method: 'POST', url: '/api/xcpc/claim', payload: { key: KEY } });
    return { app, s };
  }

  const DONE = { phase: 'done' as const, fetched: 0, stored: 0, total: 0, problems: 0, ratingContests: 0 };

  it('未认领：/api/xcpc 给 404 unclaimed，status 里 claimed=false', async () => {
    const { app } = await boot(claimRoutes());
    const res = await app.inject({ method: 'GET', url: '/api/xcpc' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.kind).toBe('unclaimed');
    const status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status.xcpc).toMatchObject({ claimed: false, status: 'idle', officialRating: null });
    // CF / AT 那两路不会因为多了 xcpc 而变形
    expect(Object.keys(status.sources).sort()).toEqual(['at', 'cf']);
  });

  it('认领后 status 顶层带出档案读数', async () => {
    const { app } = await boot(claimRoutes(), { claim: true });
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(body.xcpc).toMatchObject({ claimed: true, key: KEY, officialRating: 1353.13 });
    const profile = await app.inject({ method: 'GET', url: '/api/xcpc' });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().player.contests).toBe(3);
    expect(profile.json().rankTotal).toBe(FIX.rankTotal);
  });

  it('搜索：?q= 返回候选；上游挂了 502', async () => {
    const { app } = await boot(claimRoutes());
    const res = await app.inject({ method: 'GET', url: `/api/xcpc/search?q=${encodeURIComponent('李')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].key).toBe(KEY);

    const down = await boot(claimRoutes(), { fail: ['search/players'] });
    const bad = await down.app.inject({ method: 'GET', url: '/api/xcpc/search?q=%E6%9D%8E' });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.kind).toBe('unavailable');
  });

  it('认领：200 带档案；缺 key → 400；分片查无 → 404', async () => {
    const { app, s } = await boot(claimRoutes());
    const ok = await app.inject({ method: 'POST', url: '/api/xcpc/claim', payload: { key: KEY } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().player.key).toBe(KEY);
    expect(s.key()).toBe(KEY);

    expect((await app.inject({ method: 'POST', url: '/api/xcpc/claim', payload: {} })).statusCode).toBe(400);
    const miss = await app.inject({ method: 'POST', url: '/api/xcpc/claim', payload: { key: '查无此人@某校' } });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.kind).toBe('not-found');
  });

  it('拉快照：没认领 → 400；认领后 200 且版本没变就是 updated:false', async () => {
    const { app } = await boot(claimRoutes());
    expect((await app.inject({ method: 'POST', url: '/api/xcpc/refresh' })).statusCode).toBe(400);

    const claimed = await boot(claimRoutes(), { claim: true });
    const res = await claimed.app.inject({ method: 'POST', url: '/api/xcpc/refresh' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updated: false, status: 'ok' });
  });
});
