/** 服务生命周期与工坊异常留痕：写 vault/anvil-server.log（gitignore），写不进也不影响服务 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './config.ts';

const lifeFile = join(vaultDir, 'anvil-server.log');

export function life(event: string, detail = ''): void {
  try {
    appendFileSync(
      lifeFile,
      `${new Date().toISOString()} ${event} pid=${process.pid} ppid=${process.ppid}${detail === '' ? '' : ` ${detail}`}\n`,
    );
  } catch {
    /* 日志写不进去不影响服务本身 */
  }
}
