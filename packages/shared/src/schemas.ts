import { z } from 'zod';

/** CF handle：区分大小写，只允许字母数字下划线 */
export const cfHandleSchema = z
  .string()
  .trim()
  .min(1, 'handle 不能为空')
  .max(40, 'handle 太长')
  .regex(/^[A-Za-z0-9_]+$/, 'handle 只能是字母、数字、下划线');

export const configBodySchema = z.object({ handle: cfHandleSchema });

export const vaultConfigSchema = z.object({
  cfHandle: z.string().default(''),
  port: z.number().int().positive().default(7788),
});

/** CF 官方接口信封：非 OK 时 comment 里是可读原因 */
export const cfEnvelopeSchema = z.object({
  status: z.string(),
  comment: z.string().default(''),
  result: z.unknown(),
});

export type VaultConfig = z.infer<typeof vaultConfigSchema>;
