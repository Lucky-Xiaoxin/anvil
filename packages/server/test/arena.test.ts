/**
 * 模拟榜单数据层单测（docs/16 §7）。一律 mock fetch —— 单测禁止打真实网络（技术锁）。
 * 夹具全部自造（§2.4 许可证纪律：不裁真实 srk.json / config.yaml 入库）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { registerApi } from '../src/api.ts';
import { ArenaClient, ArenaError, CATALOG_PATH, contestPathOk, parseCatalogYaml } from '../src/arena.ts';
import { initSchema } from '../src/db.ts';
import { XcpcClient } from '../src/sync/xcpc.ts';

/* ---------- 自造目录夹具：形状照 2026-10-09 实测的真实 config.yaml（每节点一段 path、format 认叶子） ---------- */

const CATALOG = `# 自造夹具（不是真实 config.yaml）
root:
  children:
    - path: icpc
      name: ICPC
      children:
        - path: icpc2025
          name: ICPC 2025 (50th)
          children:
            - path: icpc2025shanghai
              format: srk.json
              name: 2025-11-23 上海站
            - path: icpc2025shenyang
              format: srk.json
              name: 2025-11-16 沈阳站
        - path: icpc2024
          name: ICPC 2024 (49th)
          children:
            - path: icpc2024nanjing
              format: srk.json
              name: 2024-11-30 南京站
    - path: ccpc
      name: CCPC
      children:
        - path: ccpc2025
          name: CCPC 2025
          children:
            - path: ccpc2025final
              format: srk.json
              name: 2025-11-08 总决赛
    - path: provincial
      name: 省赛
      children:
        - path: bj
          name: 北京市赛
          children:
            - path: bjcpc2026
              format: srk.json
              name: 2026-05-10 2026
        - path: gd
          name: 广东省赛
          children: []
other: 这一整段的子树都该被忽略
  nested: 1
  deeper: 2
`;

describe('窄 YAML 解析', () => {
  it('解析出顶层类目，并逐层计数（真实目录 394 场按同一规则）', () => {
    const { tree, total } = parseCatalogYaml(CATALOG);
    expect(total).toBe(5);
    expect(tree.map((n) => n.name)).toEqual(['ICPC', 'CCPC', '省赛']);
    expect(tree.map((n) => n.count)).toEqual([3, 1, 1]);
    // 广东省赛的 `children: []` 是空分组：不算叶子、不编路径，整支从树上掉下去
    expect(tree[2]?.children?.map((p) => p.name)).toEqual(['北京市赛']);
    expect(tree[0]?.children?.map((y) => [y.name, y.count])).toEqual([
      ['ICPC 2025 (50th)', 2],
      ['ICPC 2024 (49th)', 1],
    ]);
  });

  it('叶子 = 沿链 path 段拼出的完整官方路径；分组不带 path', () => {
    const { tree } = parseCatalogYaml(CATALOG);
    const leaf = tree[0]?.children?.[0]?.children?.[0];
    expect(leaf?.path).toBe('official/icpc/icpc2025/icpc2025shanghai.srk.json');
    expect(leaf?.format).toBe('srk.json');
    expect(leaf?.children).toBeUndefined();
    expect(tree[0]?.path).toBeUndefined();
  });

  it('类目下直接挂叶子（UCUP 那种两层形状）也拼得对', () => {
    const { tree, total } = parseCatalogYaml(`root:
  children:
    - path: ucup
      name: Universal Cup
      children:
        - path: ucup3rdfinals
          format: srk.json
          name: 2026-05-10 The 3rd Finals
`);
    expect(total).toBe(1);
    expect(tree[0]?.children?.[0]?.path).toBe('official/ucup/ucup3rdfinals.srk.json');
  });

  it('分组名与段名分离：`root:` 那层容器透明，不占一个类目位', () => {
    const { tree } = parseCatalogYaml(`root:
  name: 不该出现在顶层的一层
  children:
    - path: icpc
      name: ICPC
      children:
        - path: a
          format: srk.json
          name: A
    - path: ccpc
      name: CCPC
      children:
        - path: b
          format: srk.json
          name: B
`);
    expect(tree.map((n) => n.name)).toEqual(['ICPC', 'CCPC']);
  });

  it('形状异常：空文档 / 无键行 / tab 缩进 / 只有 unknown 键 → 空树而不是抛', () => {
    expect(parseCatalogYaml('')).toEqual({ tree: [], total: 0 });
    expect(parseCatalogYaml('----\n\ttab 缩进行\nrandom text\n').total).toBe(0);
    expect(parseCatalogYaml('other:\n  x: 1\n').total).toBe(0);
    // children: 后面直接接同级键 = 空列表，不该把同级键吞进去
    expect(parseCatalogYaml('root:\n  children:\n  name: icpc\n').total).toBe(0);
    // 没有 path 段的空叶子没有可取的路径，只能丢掉而不是造一个 official/.srk.json
    expect(parseCatalogYaml('root:\n  children:\n    - name: 缺段\n      format: srk.json\n').total).toBe(0);
  });

  it('引号里的冒号与井号不破坏解析', () => {
    const { tree } = parseCatalogYaml(`root:
  children:
    - path: icpc
      name: ICPC
      children:
        - path: sh
          format: srk.json
          name: 'The 50th ICPC Asia: Shanghai #1'
`);
    expect(tree[0]?.children?.[0]?.name).toBe('The 50th ICPC Asia: Shanghai #1');
  });

  it('同级兄弟叶子逐个入树，计数不互相吞（394 场规模按同一规则）', () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `        - path: p${i}\n          format: srk.json\n          name: '场 ${i}'`,
    ).join('\n');
    const { tree, total } = parseCatalogYaml(`root:\n  children:\n    - path: icpc\n      name: ICPC\n      children:\n${many}\n`);
    expect(total).toBe(12);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.count).toBe(12);
  });

  it('path 的分段列表写法（防御）：折成 / 后仍当一段处理', () => {
    const { tree, total } = parseCatalogYaml(`root:
  children:
    - path: provincial
      name: 省赛
      children:
        - path:
            - js
            - jsu2026
          format: srk.json
          name: 现场赛
`);
    expect(total).toBe(1);
    expect(tree[0]?.children?.[0]?.path).toBe('official/provincial/js/jsu2026.srk.json');
  });
});

/* ---------- 路径白名单 ---------- */

describe('路径白名单', () => {
  it('接受 official 下的合法官方路径', () => {
    expect(contestPathOk('official/icpc/icpc2025/icpc2025shanghai.srk.json')).toBe(true);
    expect(contestPathOk('official/provincial/jiangsu/jsu2026_final-1.srk.json')).toBe(true);
  });

  it('拒绝穿越、编码绕过、外部域、错后缀与大小写', () => {
    for (const bad of [
      'official/../etc/passwd.srk.json',
      'official/icpc/../../vault/anvil.db',
      'official/icpc/%2e%2e/icpc.srk.json',
      'official\\icpc\\icpc.srk.json',
      'https://evil.example/official/icpc/icpc.srk.json',
      '//evil.example/official/icpc.srk.json',
      'evil/official/icpc.srk.json',
      'official/icpc/icpc.json',
      'official/icpc/ICPC2025.srk.json',
      'official/icpc/icpc.srk.json\n',
      'official/icpc/icpc.srk.json?x=1',
      '',
    ]) {
      expect(contestPathOk(bad), bad).toBe(false);
    }
  });
});

/* ---------- 缓存与降级 ---------- */

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anvil-arena-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okResponse = (body: string, status = 200): Response => new Response(body, { status });

/** 记账用 fetch：记录每个 URL 被请求了几次 */
function countingFetch(routes: Record<string, () => Promise<Response>>): { fetchImpl: typeof fetch; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input).replace(/^https:\/\/cdn\.jsdelivr\.net\/gh\/algoux\/srk-collection@master\//, '');
    hits[url] = (hits[url] ?? 0) + 1;
    const handler = routes[url];
    if (handler === undefined) return okResponse('not found', 404);
    return handler();
  }) as unknown as typeof fetch;
  return { fetchImpl, hits };
}

const failFetch = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

describe('目录缓存', () => {
  it('首次拉取落盘，二次命中缓存不再出网', async () => {
    const { fetchImpl, hits } = countingFetch({ [CATALOG_PATH]: async () => okResponse(CATALOG) });
    const c = new ArenaClient({ fetchImpl, dir });
    const first = await c.catalog();
    expect(first.total).toBe(5);
    expect(existsSync(join(dir, '_catalog.yaml'))).toBe(true);
    const second = await c.catalog();
    expect(second.total).toBe(5);
    expect(hits[CATALOG_PATH]).toBe(1);
  });

  it('fetchedAt = 缓存文件 mtime（epoch 秒）', async () => {
    const c0 = new ArenaClient({ fetchImpl: failFetch, dir });
    writeFileSync(join(dir, '_catalog.yaml'), CATALOG, 'utf8');
    const when = 1_700_000_000;
    utimesSync(join(dir, '_catalog.yaml'), new Date(when * 1000), new Date(when * 1000));
    const dto = await c0.catalog();
    expect(dto.fetchedAt).toBe(when);
  });

  it('refresh=1 强制重拉', async () => {
    const { fetchImpl, hits } = countingFetch({ [CATALOG_PATH]: async () => okResponse(CATALOG) });
    const c = new ArenaClient({ fetchImpl, dir });
    await c.catalog();
    await c.catalog(true);
    expect(hits[CATALOG_PATH]).toBe(2);
  });

  it('无缓存且拉不通 → ArenaError(unavailable)，重试 1 次后放弃', async () => {
    let attempts = 0;
    const c = new ArenaClient({
      fetchImpl: (async () => {
        attempts++;
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      dir,
    });
    await expect(c.catalog()).rejects.toBeInstanceOf(ArenaError);
    expect(attempts).toBe(2);
  });

  it('有缓存时上游失败照常回缓存（降级不崩）', async () => {
    const { fetchImpl, hits } = countingFetch({ [CATALOG_PATH]: async () => okResponse(CATALOG) });
    const c = new ArenaClient({ fetchImpl, dir });
    await c.catalog();
    const offline = new ArenaClient({ fetchImpl: failFetch, dir });
    const back = await offline.catalog(true);
    expect(back.total).toBe(5);
    expect(hits[CATALOG_PATH]).toBe(1);
  });

  it('404 / 空响应算失败，且不把坏内容写进缓存', async () => {
    const c = new ArenaClient({ fetchImpl: async () => okResponse('', 404) as unknown as Response, dir });
    await expect(c.catalog()).rejects.toBeInstanceOf(ArenaError);
    expect(existsSync(join(dir, '_catalog.yaml'))).toBe(false);
  });

  it('5xx 重试 1 次后成功 = 目录照样可用', async () => {
    let n = 0;
    const c = new ArenaClient({
      fetchImpl: (async () => {
        n++;
        return n === 1 ? okResponse('boom', 503) : okResponse(CATALOG);
      }) as unknown as typeof fetch,
      dir,
    });
    const dto = await c.catalog();
    expect(dto.total).toBe(5);
    expect(n).toBe(2);
  });
});

describe('单场缓存', () => {
  const PATH = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';
  const SRK = JSON.stringify({ type: 'general', contest: { title: { 'zh-CN': '上海站' } } });

  it('按路径镜像落盘，已缓存即回 fromCache', async () => {
    const { fetchImpl, hits } = countingFetch({ [PATH]: async () => okResponse(SRK) });
    const c = new ArenaClient({ fetchImpl, dir });
    const first = await c.contest(PATH);
    expect(first).toMatchObject({ fromCache: false });
    expect(first.data).toEqual({ type: 'general', contest: { title: { 'zh-CN': '上海站' } } });
    expect(existsSync(join(dir, PATH))).toBe(true);
    const second = await c.contest(PATH);
    expect(second.fromCache).toBe(true);
    expect(hits[PATH]).toBe(1);
  });

  it('原子写入：落盘后不留 .tmp', async () => {
    const c = new ArenaClient({ fetchImpl: (async () => okResponse(SRK)) as unknown as typeof fetch, dir });
    await c.contest(PATH);
    const leftovers = readFileSync(join(dir, PATH), 'utf8');
    expect(leftovers).toBe(SRK);
    expect(existsSync(join(dir, `${PATH}.${process.pid}.tmp`))).toBe(false);
  });

  it('路径非法 → ArenaError(invalid)，不出网', async () => {
    let called = 0;
    const c = new ArenaClient({
      fetchImpl: (async () => {
        called++;
        return okResponse(SRK);
      }) as unknown as typeof fetch,
      dir,
    });
    await expect(c.contest('official/../x.srk.json')).rejects.toMatchObject({ kind: 'invalid' });
    expect(called).toBe(0);
  });

  it('已缓存的场次断网仍可回放（离线口径）', async () => {
    const c = new ArenaClient({ fetchImpl: (async () => okResponse(SRK)) as unknown as typeof fetch, dir });
    await c.contest(PATH);
    const offline = new ArenaClient({ fetchImpl: failFetch, dir });
    const back = await offline.contest(PATH, true);
    expect(back.fromCache).toBe(true);
    expect(back.data).toEqual({ type: 'general', contest: { title: { 'zh-CN': '上海站' } } });
  });

  it('无缓存且不可达 → unavailable；缓存是半截 JSON 时当作没有，重拉补好', async () => {
    const offline = new ArenaClient({ fetchImpl: failFetch, dir });
    await expect(offline.contest(PATH)).rejects.toMatchObject({ kind: 'unavailable' });

    mkdirSync(dirname(join(dir, PATH)), { recursive: true });
    writeFileSync(join(dir, PATH), '{ 半截的 JSON', 'utf8');
    const c = new ArenaClient({ fetchImpl: async () => okResponse(SRK), dir });
    const back = await c.contest(PATH);
    expect(back.fromCache).toBe(false);
    expect(back.data).toEqual({ type: 'general', contest: { title: { 'zh-CN': '上海站' } } });
    // 重拉后原子写回，坏文件不再留在磁盘上咬下一次请求
    const again = new ArenaClient({ fetchImpl: failFetch, dir });
    expect((await again.contest(PATH)).fromCache).toBe(true);
  });

  it('mtime 可读回（缓存时间戳跟随真实时钟，不钉死日历）', async () => {
    const c = new ArenaClient({ fetchImpl: (async () => okResponse(SRK)) as unknown as typeof fetch, dir });
    const got = await c.contest(PATH);
    expect(got.fetchedAt).toBe(Math.floor(statSync(join(dir, PATH)).mtimeMs / 1000));
  });
});

/* ---------- 路由（docs/16 §2.2）---------- */

async function makeApp(routes: Record<string, () => Promise<Response>>) {
  const { fetchImpl, hits } = countingFetch(routes);
  const app = Fastify();
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const done = { phase: 'done' as const, fetched: 0, stored: 0, total: 0, problems: 0, ratingContests: 0 };
  registerApi(app, {
    db,
    sources: {
      cf: { id: 'cf', checkHandle: async () => ({ ok: true }), sync: async () => done },
      at: { id: 'at', checkHandle: async () => ({ ok: true }), sync: async () => done },
    },
    getHandles: () => ({ cf: '', at: '' }),
    setHandles: () => {},
    xcpc: { db, getKey: () => '', setKey: () => {}, client: new XcpcClient({ fetchImpl }) },
    arena: new ArenaClient({ fetchImpl, dir }),
  });
  await app.ready();
  return { app, hits, close: async () => { await app.close(); db.close(); } };
}

describe('arena 路由', () => {
  it('GET /api/arena/catalog → 200 { fetchedAt, total, tree }', async () => {
    const { app, close } = await makeApp({ [CATALOG_PATH]: async () => okResponse(CATALOG) });
    const res = await app.inject({ method: 'GET', url: '/api/arena/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(5);
    await close();
  });

  it('GET /api/arena/catalog 无缓存且拉不通 → 502', async () => {
    const { app, close } = await makeApp({});
    const res = await app.inject({ method: 'GET', url: '/api/arena/catalog' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe('unavailable');
    await close();
  });

  it('GET /api/arena/contest?path= 合法 → 200，非法 → 400，缺 path → 400', async () => {
    const PATH = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';
    const { app, close } = await makeApp({ [PATH]: async () => okResponse(JSON.stringify({ type: 'general' })) });
    const ok = await app.inject({ method: 'GET', url: `/api/arena/contest?path=${PATH}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ type: 'general' });

    const bad = await app.inject({ method: 'GET', url: '/api/arena/contest?path=official/../x.srk.json' });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({ method: 'GET', url: '/api/arena/contest' });
    expect(missing.statusCode).toBe(400);
    await close();
  });
});
