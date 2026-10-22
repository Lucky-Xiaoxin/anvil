/** 工坊路由（docs/contracts/23 §9.2）：请求体校验 + WorkError → HTTP 状态 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { life } from '../life.ts';
import { WorkError } from './errors.ts';
import type { WorkService } from './store.ts';

const kindSchema = z.enum(['contest', 'problem', 'template', 'note']);

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
  topId: z.string().max(80).optional(),
  templateId: z.union([z.string().max(40), z.null()]).optional(),
});

const adoptBody = z.object({
  relPath: z.string().max(400),
  kind: kindSchema,
  title: z.string().max(200).optional(),
});

const updateBody = z.object({
  id: z.string().max(40),
  title: z.string().max(200).optional(),
  tags: z
    .object({
      primary: z.union([z.string().max(80), z.null()]).optional(),
      related: z.array(z.string().max(80)).max(50).optional(),
    })
    .optional(),
  labels: z.array(z.string()).max(50).optional(),
  archived: z.boolean().optional(),
});

const idBody = z.object({ id: z.string().max(40) });

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

const arenaRecordQuery = z.object({ path: z.string().max(300) });

const arenaRecordBody = z.object({
  arenaPath: z.string().max(300),
  title: z.string().max(200).optional(),
  ghost: z.object({
    show: z.boolean(),
    subs: z
      .array(z.object({ p: z.number().int().nonnegative(), t: z.number().int().nonnegative(), r: z.enum(['AC', 'WA', 'TLE', 'RE', 'CE']) }))
      .max(5000),
  }),
  view: z.object({
    mode: z.enum(['live', 'review']),
    viewMs: z.number().nonnegative(),
    paused: z.boolean(),
    frozenView: z.boolean(),
  }),
});

const invalid = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(400).send({ error: { kind: 'invalid', message } });

function sendWorkError(reply: FastifyReply, err: unknown): FastifyReply {
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

  app.get('/api/work/arena-record', async (request, reply) => {
    const parsed = arenaRecordQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, '缺少 arenaPath');
    try {
      return work.getArenaRecord(parsed.data.path);
    } catch (err) {
      return sendWorkError(reply, err);
    }
  });

  app.post('/api/work/arena-record', async (request, reply) => {
    const parsed = arenaRecordBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? '成绩存档不合法');
    try {
      return await work.saveArenaRecord(parsed.data);
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
