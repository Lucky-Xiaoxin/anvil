import { z } from 'zod';

/** CF handle：区分大小写，只允许字母数字下划线 */
export const cfHandleSchema = z
  .string()
  .trim()
  .min(1, 'handle 不能为空')
  .max(40, 'handle 太长')
  .regex(/^[A-Za-z0-9_]+$/, 'handle 只能是字母、数字、下划线');

/** AT handle：官方页允许的宽松字符集（docs/09 §3.2），存在性走上游页面状态码 */
export const atHandleSchema = z
  .string()
  .trim()
  .min(1, 'handle 不能为空')
  .max(64, 'handle 太长')
  .regex(/^[A-Za-z0-9_\-.]+$/, 'handle 只能是字母、数字、下划线、点或连字符');

/** 分源保存：只校验带过来的那一侧，没带的保持原样 */
export const configBodySchema = z
  .object({ cfHandle: cfHandleSchema.optional(), atHandle: atHandleSchema.optional() })
  .refine((v) => v.cfHandle !== undefined || v.atHandle !== undefined, { message: '没有要保存的 handle' });

export const syncBodySchema = z.object({ source: z.enum(['cf', 'at']).default('cf') });

export const dashboardQuerySchema = z.object({ source: z.enum(['cf', 'at', 'xcpc']).default('cf') });

export const vaultConfigSchema = z.object({
  cfHandle: z.string().default(''),
  atHandle: z.string().default(''),
  port: z.number().int().positive().default(7788),
});

/** CF 官方接口信封：非 OK 时 comment 里是可读原因 */
export const cfEnvelopeSchema = z.object({
  status: z.string(),
  comment: z.string().default(''),
  result: z.unknown(),
});

export type VaultConfig = z.infer<typeof vaultConfigSchema>;
