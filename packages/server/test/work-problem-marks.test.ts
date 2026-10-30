import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { initSchema } from '../src/db.ts';
import { registerWorkRoutes } from '../src/work/routes.ts';
import { WorkService } from '../src/work/store.ts';

const ARENA = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';
const RECORD_ID = `rec_${'a'.repeat(32)}`;
const DURATION = 5 * 3_600_000;

let base: string;
let root: string;
let arenaDir: string;
let db: DatabaseSync;
let service: WorkService;
let app: FastifyInstance;
let now: Date;

const cont = (relPath: string): string => join(root, relPath);

async function boot(): Promise<void> {
  base = mkdtempSync(join(tmpdir(), 'anvil-work-marks-'));
  root = join(base, 'root');
  arenaDir = join(base, 'vault', 'arena');
  mkdirSync(join(base, 'repo'));
  mkdirSync(arenaDir, { recursive: true });
  mkdirSync(join(arenaDir, 'official', 'icpc', 'icpc2025'), { recursive: true });
  writeFileSync(
    join(arenaDir, ARENA),
    JSON.stringify({
      problems: [{ alias: 'A', title: 'A' }, { alias: 'B', title: 'B' }, { alias: 'C', title: 'C' }],
      contest: { duration: [5, 'h'] },
    }),
  );
  now = new Date(2026, 9, 30, 12);
  db = new DatabaseSync(':memory:');
  initSchema(db);
  let configRoot = '';
  service = new WorkService({
    db,
    getRoot: () => configRoot,
    setRoot: (p) => {
      configRoot = p;
    },
    now: () => now,
    repoRoot: join(base, 'repo'),
    vaultDir: join(base, 'vault'),
    arenaDir,
  });
  app = Fastify();
  registerWorkRoutes(app, service);
  await app.ready();
  await service.init({ path: root });
}

beforeEach(boot);

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(base, { recursive: true, force: true });
});

async function contestWithRecord(): Promise<{ contestId: string; relPath: string }> {
  const res = await service.createArenaRecord({
    arenaPath: ARENA,
    contestTitle: 'Shanghai',
    recordId: RECORD_ID,
    name: '初赛',
    result: { origin: 'timed', finish: 'time-limit', durationMs: DURATION, stoppedAtMs: DURATION },
    ghost: {
      show: true,
      subs: [
        { p: 0, t: 10, r: 'AC' },
        { p: 1, t: 20, r: 'WA' },
        { p: 2, t: 30, r: 'AC' },
      ],
    },
  });
  return { contestId: res.object.id, relPath: res.object.relPath };
}

const problems = [
  { alias: 'A', title: 'A. 某某题' },
  { alias: 'B', title: 'B. 另一题' },
  { alias: 'C', title: 'C. 第三题' },
];

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json' } });

describe('题目标记 service（30 §3 / §4 / §5）', () => {
  it('首次 sync 建快照 + AC 预填；幂等；汇总进列表；详情带 revision', async () => {
    const { contestId, relPath } = await contestWithRecord();
    const first = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    expect(first.problems.map((p) => p.alias)).toEqual(['A', 'B', 'C']);
    expect(first.marks.A).toMatchObject({ progress: 'contest-ac', star: false, tags: [] });
    expect(first.marks.B).toBeUndefined();
    expect(first.marks.C).toMatchObject({ progress: 'contest-ac' });
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);

    const second = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    expect(second.revision).toBe(first.revision);

    const tree = await service.tree();
    const contest = tree.objects.find((o) => o.id === contestId);
    expect(contest?.problemMarkSummary).toEqual({ total: 3, marked: 2, todo: 0, starred: 0 });

    const detail = service.object(contestId);
    expect(detail.problemMarks?.marks.A!.progress).toBe('contest-ac');
    expect(detail.problemMarks?.revision).toBe(first.revision);
    expect(existsSync(join(cont(relPath), 'problem-marks.json'))).toBe(true);
  });

  it('alias 集合不同 → problem-set-mismatch；不带 recordId 只建快照不预填', async () => {
    await contestWithRecord();
    await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    await expect(
      service.syncProblemMarks({ arenaPath: ARENA, problems: [{ alias: 'Z', title: '' }] }),
    ).rejects.toMatchObject({ kind: 'problem-set-mismatch' });

    const other = await service.create({
      kind: 'contest',
      title: 'Nanjing',
      arenaPath: 'official/icpc/icpc2025/icpc2025nanjing.srk.json',
    });
    const snapshot = await service.syncProblemMarks({
      arenaPath: 'official/icpc/icpc2025/icpc2025nanjing.srk.json',
      problems,
    });
    expect(snapshot.marks).toEqual({});
    expect(service.object(other.id).problemMarks?.marks).toEqual({});
  });

  it('update：整份替换、全空删除、prefillApplied 保留；旧 revision 409；归档仍可写', async () => {
    const { contestId, relPath } = await contestWithRecord();
    const synced = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    await expect(
      service.updateProblemMarks({ arenaPath: ARENA, expectedRevision: 'stale', marks: {} }),
    ).rejects.toMatchObject({ kind: 'conflict' });

    const updated = await service.updateProblemMarks({
      arenaPath: ARENA,
      expectedRevision: synced.revision,
      marks: { B: { progress: 'todo', star: true, tags: ['dp'] } },
    });
    expect(updated.marks.A).toBeUndefined();
    expect(updated.marks.B).toEqual({ progress: 'todo', star: true, tags: ['dp'], updatedAt: expect.any(String) });

    const file = JSON.parse(readFileSync(join(cont(relPath), 'problem-marks.json'), 'utf8'));
    expect(file.prefillApplied).toEqual(['A', 'C']);

    await service.update({ id: contestId, archived: true });
    const archivedWrite = await service.updateProblemMarks({
      arenaPath: ARENA,
      expectedRevision: updated.revision,
      marks: { B: { progress: 'post-solved', star: true, tags: ['dp'] } },
    });
    expect(archivedWrite.marks.B?.progress).toBe('post-solved');
  });

  it('预填拦手选 / 清空后不填回；重复 sync 不覆盖', async () => {
    const { relPath } = await contestWithRecord();
    const synced = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    const cleared = await service.updateProblemMarks({
      arenaPath: ARENA,
      expectedRevision: synced.revision,
      marks: { B: { progress: 'todo', star: false, tags: [] } },
    });
    const again = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    expect(again.revision).toBe(cleared.revision);
    expect(again.marks.A).toBeUndefined();
    expect(again.marks.B?.progress).toBe('todo');
    const file = JSON.parse(readFileSync(join(cont(relPath), 'problem-marks.json'), 'utf8'));
    expect(file.prefillApplied).toEqual(['A', 'C']);
  });

  it('recordId 不属于 / 不存在 → not-found，不写标记；无宿主 404；回收站 409', async () => {
    await expect(service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID })).rejects.toMatchObject({
      kind: 'not-found',
    });
    const other = await contestWithRecord();
    await expect(
      service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: `rec_${'b'.repeat(32)}` }),
    ).rejects.toMatchObject({ kind: 'not-found' });

    await assertRejected(service.syncProblemMarks({ arenaPath: 'official/icpc/other.srk.json', problems }), 'not-found');

    await service.update({ id: other.contestId, archived: false });
    await service.trash(other.contestId);
    await assertRejected(service.syncProblemMarks({ arenaPath: ARENA, problems }), 'conflict');
  });

  it('坏文件 / schema 过高 / 场次不一致：详情报错、列表无徽章、不覆盖；update 409', async () => {
    const { contestId, relPath } = await contestWithRecord();
    await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    const filePath = join(cont(relPath), 'problem-marks.json');

    writeFileSync(filePath, '{broken');
    const tree = await service.tree({ rescan: true });
    expect(tree.objects.find((o) => o.id === contestId)?.problemMarkSummary).toBeUndefined();
    expect(service.object(contestId).problemMarksError).toContain('JSON');
    expect(readFileSync(filePath, 'utf8')).toBe('{broken');

    writeFileSync(filePath, JSON.stringify({ schema: 2, arenaPath: ARENA, problems, marks: {} }));
    expect(service.object(contestId).problemMarksError).toContain('schema');
    await expect(
      service.updateProblemMarks({ arenaPath: ARENA, expectedRevision: 'x', marks: {} }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.syncProblemMarks({ arenaPath: ARENA, problems })).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('未知 alias 的手写标记在 update 时原样保留；同一场多存档共享一份标记', async () => {
    const { contestId, relPath } = await contestWithRecord();
    const synced = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    const filePath = join(cont(relPath), 'problem-marks.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    raw.marks.Z = { progress: 'todo', star: false, tags: [], updatedAt: '2026-10-30T12:00:00.000Z' };
    writeFileSync(filePath, JSON.stringify(raw));
    await service.rescan();

    const detail = service.object(contestId);
    expect(detail.problemMarks?.unreadableMarks).toBe(1);
    const updated = await service.updateProblemMarks({
      arenaPath: ARENA,
      expectedRevision: detail.problemMarks!.revision,
      marks: { B: { progress: 'todo', star: false, tags: [] } },
    });
    expect(updated.marks.Z).toBeUndefined();
    expect(JSON.parse(readFileSync(filePath, 'utf8')).marks.Z).toBeDefined();
  });

  it('工作区题目标签去重收进 problemTags；一张合法文件都没有时为空', async () => {
    const { contestId } = await contestWithRecord();
    const synced = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    expect((await service.tree()).problemTags).toEqual([]);
    await service.updateProblemMarks({
      arenaPath: ARENA,
      expectedRevision: synced.revision,
      marks: {
        A: { progress: 'contest-ac', star: false, tags: ['dp', '图论'] },
        B: { progress: 'todo', star: true, tags: ['dp'] },
      },
    });
    expect((await service.tree()).problemTags).toEqual(['dp', '图论']);
    expect(service.object(contestId).problemMarkSummary).toEqual({ total: 3, marked: 2, todo: 1, starred: 1 });
  });
});

async function assertRejected(promise: Promise<unknown>, kind: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ kind });
}

describe('题目标记 API（30 §4.2 / §4.3）', () => {
  it('sync 形状：非法 alias 400；缺 recordId 不会被当成空存档；成功返回 problemMarks', async () => {
    await contestWithRecord();
    let res = await post('/api/work/problem-marks/sync', {
      arenaPath: ARENA,
      problems: [{ alias: '题一', title: '' }],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.kind).toBe('invalid');

    res = await post('/api/work/problem-marks/sync', { arenaPath: ARENA, problems, recordId: RECORD_ID });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().problemMarks.marks.A.progress).toBe('contest-ac');
    expect(res.json().problemMarks.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('update 形状：缺快照 404；版本过期 409；未知 alias 400；成功返回新 revision', async () => {
    await contestWithRecord();
    let res = await post('/api/work/problem-marks/update', { arenaPath: ARENA, expectedRevision: 'x', marks: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.kind).toBe('not-found');

    const synced = await service.syncProblemMarks({ arenaPath: ARENA, problems, recordId: RECORD_ID });
    res = await post('/api/work/problem-marks/update', { arenaPath: ARENA, expectedRevision: 'stale', marks: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('conflict');

    res = await post('/api/work/problem-marks/update', {
      arenaPath: ARENA,
      expectedRevision: synced.revision,
      marks: { Z: { progress: 'todo', star: false, tags: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('invalid');

    res = await post('/api/work/problem-marks/update', {
      arenaPath: ARENA,
      expectedRevision: synced.revision,
      marks: { B: { progress: 'todo', star: true, tags: ['dp'] } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().problemMarks.marks.B.progress).toBe('todo');
  });
});
describe('题目标记原型键回归（30 §5）', () => {
  it('alias=toString：sync / update 不再 500', async () => {
    await contestWithRecord();
    const synced = await post('/api/work/problem-marks/sync', {
      arenaPath: ARENA,
      problems: [{ alias: 'toString', title: 'T' }],
    });
    expect(synced.statusCode, synced.body).toBe(200);
    const updated = await post('/api/work/problem-marks/update', {
      arenaPath: ARENA,
      expectedRevision: synced.json().problemMarks.revision,
      marks: { toString: { progress: 'todo', star: false, tags: [] } },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().problemMarks.marks.toString.progress).toBe('todo');
  });

  it('手写外来 __proto__ 标记：update 后原样保留', async () => {
    const { contestId, relPath } = await contestWithRecord();
    await service.syncProblemMarks({ arenaPath: ARENA, problems });
    const filePath = join(cont(relPath), 'problem-marks.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { problems: unknown };
    writeFileSync(
      filePath,
      `{"schema":1,"arenaPath":${JSON.stringify(ARENA)},"problems":${JSON.stringify(raw.problems)},"marks":{"__proto__":{"progress":"todo","star":false,"tags":[],"updatedAt":"2026-10-30T12:00:00.000Z"}},"prefillApplied":[]}`,
    );
    await service.rescan();
    const detail = service.object(contestId);
    expect(detail.problemMarks?.unreadableMarks).toBe(1);
    const updated = await service.updateProblemMarks({
      arenaPath: ARENA,
      expectedRevision: detail.problemMarks!.revision,
      marks: { A: { progress: 'todo', star: false, tags: [] } },
    });
    expect(updated.marks.A?.progress).toBe('todo');
    expect(readFileSync(filePath, 'utf8')).toContain('"__proto__"');
  });
});
