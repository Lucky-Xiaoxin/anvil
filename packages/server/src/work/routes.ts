/** 工坊路由（docs/contracts/23 §9.2）：请求体校验 + WorkError → HTTP 状态 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { life } from '../life.ts';
import { ConfigWriteBlocked } from '../config.ts';
import { WorkError } from './errors.ts';
import type { WorkService } from './store.ts';

const kindSchema = z.enum(['contest', 'problemset', 'problem', 'template', 'note']);

const initBody = z.object({
  path: z.string().max(500),
  confirmExisting: z.boolean().optional(),
});

const createBody = z.object({
  kind: kindSchema,
  title: z.string().max(200).optional(),
  parentId: z.string().max(40).optional(),
  problemKey: z.string().max(80).optional(),
  arenaPath: z.string().max(300).optional(),
  templateId: z.union([z.string().max(40), z.null()]).optional(),
});

const adoptBody = z.object({
  relPath: z.string().max(400),
  kind: kindSchema,
  title: z.string().max(200).optional(),
  parentId: z.union([z.string().max(40), z.null()]).optional(),
});

const updateBody = z.object({
  id: z.string().max(40),
  title: z.string().max(200).optional(),
  labels: z.array(z.string()).max(50).optional(),
  archived: z.boolean().optional(),
  parentId: z.union([z.string().max(40), z.null()]).optional(),
});

/* 赛后题目标记（docs/contracts/30）：形状由 shared 解析器收口，这里只挡体量与寻址 */
const problemMarksSyncBody = z.object({
  arenaPath: z.string().min(1).max(300),
  problems: z.array(z.unknown()).min(1).max(40),
  recordId: z.string().regex(/^(rec_[0-9a-f]{32}|legacy)$/, 'recordId 形状不合法').optional(),
});

const problemMarksUpdateBody = z.object({
  arenaPath: z.string().min(1).max(300),
  expectedRevision: z.string().min(1).max(128),
  marks: z.record(z.unknown()),
});

const idBody = z.object({ id: z.string().max(40) });

const purgeBody = z.object({ confirm: z.literal(true) });

const openBody = z.object({
  id: z.string().max(40),
  relPath: z.string().max(400).optional(),
  app: z.enum(['auto', 'vscode', 'explorer']).optional(),
});

const importScanBody = z.object({ sourceRoot: z.string().max(500) });

const importCommitBody = z.object({
  planId: z.string().max(64),
  items: z
    .array(
      z.object({
        itemId: z.string().max(80),
        selected: z.boolean(),
        title: z.string().max(200).optional(),
        parentItemId: z.union([z.string().max(80), z.null()]).optional(),
        confirmUndecidedAsProblem: z.boolean().optional(),
        keepDuplicate: z.boolean().optional(),
      }),
    )
    .max(4000),
});

const treeQuery = z.object({
  archived: z.enum(['0', '1']).default('0'),
  rescan: z.enum(['0', '1']).default('0'),
});

const objectQuery = z.object({ id: z.string().max(40) });

const templateQuery = z.object({ id: z.string().max(40) });

const templateSaveBody = z.object({
  id: z.string().max(40),
  content: z.string(),
  baseRevision: z.union([z.string().max(64), z.null()]),
});

/* 榜单多存档（docs/contracts/29）；形状只做第一道挡板，语义由 shared 的解析器收口 */
const arenaRecordsQuery = z.object({ path: z.string().min(1).max(300) });

const arenaRecordAddress = z.string().regex(/^(rec_[0-9a-f]{32}|legacy)$/, 'recordId 形状不合法');
const newArenaRecordId = z.string().regex(/^rec_[0-9a-f]{32}$/, 'recordId 必须是 rec_ 加 32 位小写十六进制');
const arenaTrashId = z.string().regex(/^tr_[0-9a-f]{32}$/, 'trashId 形状不合法');
const recordRevision = z.string().min(1).max(128);

const arenaRecordItemQuery = z.object({
  path: z.string().min(1).max(300),
  recordId: arenaRecordAddress,
});

const arenaRecordResultBody = z.object({
  origin: z.enum(['timed', 'manual', 'legacy-review']),
  finish: z.enum(['time-limit', 'stopped', 'declared', 'unknown']),
  durationMs: z.union([z.number().int().positive(), z.null()]),
  stoppedAtMs: z.union([z.number().int().nonnegative(), z.null()]),
});

const arenaGhostBody = z.object({
  show: z.boolean(),
  subs: z
    .array(z.object({ p: z.number().int().nonnegative(), t: z.number().int().nonnegative(), r: z.enum(['AC', 'WA', 'TLE', 'RE', 'CE']) }))
    .max(5000),
});

const arenaRecordCreateBody = z.object({
  arenaPath: z.string().min(1).max(300),
  contestTitle: z.string().max(200).optional(),
  recordId: newArenaRecordId,
  name: z.string().max(400),
  result: arenaRecordResultBody,
  ghost: arenaGhostBody,
});

const arenaRecordUpdateBody = z.object({
  arenaPath: z.string().min(1).max(300),
  recordId: arenaRecordAddress,
  expectedRevision: recordRevision,
  result: arenaRecordResultBody,
  ghost: arenaGhostBody,
});

const arenaRecordRenameBody = z.object({
  arenaPath: z.string().min(1).max(300),
  recordId: arenaRecordAddress,
  expectedRevision: recordRevision,
  name: z.string().max(400),
});

const arenaRecordTrashBody = z.object({
  arenaPath: z.string().min(1).max(300),
  recordId: arenaRecordAddress,
  expectedRevision: recordRevision,
  confirm: z.literal(true),
});

const arenaRecordRestoreBody = z.object({ trashId: arenaTrashId });

const invalid = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(400).send({ error: { kind: 'invalid', message } });

function sendWorkError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ConfigWriteBlocked) {
    return reply.code(409).send({ error: { kind: 'config-invalid', message: err.message } });
  }
  if (err instanceof WorkError) {
    if (err.kind === 'internal') life('work-error', err.message);
    return reply.code(err.status).send({
      error: {
        kind: err.kind,
        message: err.message,
        ...(err.entries === undefined ? {} : { entries: err.entries }),
      },
    });
  }
  life('work-error', err instanceof Error ? (err.stack ?? err.message) : String(err));
  console.error('[anvil] work:', err);
  return reply.code(500).send({ error: { kind: 'internal', message: '工坊内部错误，详情见 vault/anvil-server.log' } });
}

export function registerWorkRoutes(app: FastifyInstance, work: WorkService): void {
  app.post('/api/work/init', async (request, reply) => {
    const parsed = initBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '初始化参数不合法');
    try {
      return await work.init(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.get('/api/work/tree', async (request, reply) => {
    const parsed = treeQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, '查询参数只能是 0 或 1');
    try {
      return await work.tree({ archived: parsed.data.archived === '1', rescan: parsed.data.rescan === '1' });
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.get('/api/work/object', async (request, reply) => {
    const parsed = objectQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, '缺少对象 id');
    try {
      return work.object(parsed.data.id);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.get('/api/work/template', async (request, reply) => {
    const parsed = templateQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, '缺少对象 id');
    try {
      return work.getTemplate(parsed.data.id);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  // 模板正文单独放宽请求体上限；全局 64KB 留给其余接口（共享常量仍限制正文 64KB）
  app.post('/api/work/template', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const parsed = templateSaveBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '模板保存参数不合法');
    try {
      return await work.saveTemplate(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.get('/api/work/arena-records', async (request, reply) => {
    const parsed = arenaRecordsQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, '缺少 arenaPath');
    try {
      return work.listArenaRecords(parsed.data.path);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.get('/api/work/arena-records/item', async (request, reply) => {
    const parsed = arenaRecordItemQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '缺少 arenaPath / recordId');
    try {
      return work.getArenaRecordItem(parsed.data.path, parsed.data.recordId);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.get('/api/work/arena-records/legacy', async (request, reply) => {
    const parsed = arenaRecordsQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, '缺少 arenaPath');
    try {
      return work.getArenaLegacy(parsed.data.path);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  // 成绩写接口单独放宽到 1 MiB（最多 5000 发）；其余接口仍按全局 64 KiB
  app.post('/api/work/arena-records/create', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = arenaRecordCreateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '存档参数不合法');
    try {
      const result = await work.createArenaRecord(parsed.data);
      const { created, ...body } = result;
      return reply.code(created ? 201 : 200).send(body);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/arena-records/update', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = arenaRecordUpdateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '存档参数不合法');
    try {
      return await work.updateArenaRecord(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/arena-records/rename', async (request, reply) => {
    const parsed = arenaRecordRenameBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '改名参数不合法');
    try {
      return await work.renameArenaRecord(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/arena-records/trash', async (request, reply) => {
    const parsed = arenaRecordTrashBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '删除存档需要显式确认');
    try {
      return await work.trashArenaRecord(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/arena-records/restore', async (request, reply) => {
    const parsed = arenaRecordRestoreBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, 'trashId 不合法');
    try {
      return await work.restoreArenaRecord(parsed.data.trashId);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/problem-marks/sync', async (request, reply) => {
    const parsed = problemMarksSyncBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '题目同步参数不合法');
    try {
      return { problemMarks: await work.syncProblemMarks(parsed.data) };
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/problem-marks/update', async (request, reply) => {
    const parsed = problemMarksUpdateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '标记参数不合法');
    try {
      return { problemMarks: await work.updateProblemMarks(parsed.data) };
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/create', async (request, reply) => {    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '创建参数不合法');
    try {
      return await work.create(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/adopt', async (request, reply) => {
    const parsed = adoptBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '登记参数不合法');
    try {
      return await work.adopt(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/update', async (request, reply) => {
    // 旧客户端仍传对象级主题标签：按 400 明确拒绝，不静默忽略（30 §3.6）
    if (typeof request.body === 'object' && request.body !== null && 'tags' in request.body) {
      return invalid(reply, '对象级主题标签已退役；题目请用题目标记');
    }
    const parsed = updateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '更新参数不合法');
    try {
      return await work.update(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/trash', async (request, reply) => {
    const parsed = idBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '缺少对象 id');
    try {
      return await work.trash(parsed.data.id);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/trash/purge', async (request, reply) => {
    const parsed = purgeBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '清空回收站需要显式确认');
    try {
      return await work.purgeTrash();
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/restore', async (request, reply) => {
    const parsed = idBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '缺少对象 id');
    try {
      return await work.restore(parsed.data.id);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/open', async (request, reply) => {
    const parsed = openBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '打开参数不合法');
    try {
      await work.open(parsed.data.id, parsed.data.relPath, parsed.data.app);
      return reply.code(204).send();
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/import/scan', async (request, reply) => {
    const parsed = importScanBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, '源目录参数不合法');
    try {
      return await work.importScan(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  // 候选项可能上千条；单独放宽请求体，正文仍受 plan 校验约束
  app.post('/api/work/import/commit', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = importCommitBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '导入提交参数不合法');
    try {
      return await work.importCommit(parsed.data);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/rescan', async (_request, reply) => {
    try {
      return await work.rescan();
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });
}
