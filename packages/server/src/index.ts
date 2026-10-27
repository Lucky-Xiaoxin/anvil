import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ArenaClient } from './arena.ts';
import { dbFile, loadConfig, portOf, saveHandles, saveWorkspaceRoot, saveXcpcPlayerKey, vaultDir, webDistDir } from './config.ts';
import { getMeta, handleMetaKey, openDatabase } from './db.ts';
import { registerApi } from './api.ts';
import { registerErrorHandler } from './error-handler.ts';
import { registerStatic } from './static.ts';
import { life } from './life.ts';
import { WorkService } from './work/store.ts';
import { AtClient, createAtSource } from './sync/at.ts';
import { CfClient } from './sync/cf.ts';
import { createCfSource } from './sync/job.ts';
import { initSnapshot } from './sync/runner.ts';
import { XcpcClient } from './sync/xcpc.ts';

const pidFile = join(vaultDir, 'server.pid');

function writePid(): void {
  try {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
  } catch {
    // PID 文件只给 stop.bat 认进程用；写不进不影响服务
  }
}

function clearPid(): void {
  try {
    const owner = readFileSync(pidFile, 'utf8').trim();
    if (owner === String(process.pid)) unlinkSync(pidFile);
  } catch {
    // 没有 PID 文件或已被覆盖，无需处理
  }
}

/**
 * 7788 偶发“自己没了”时，界面只看到端口消失：终端关闭（SIGHUP）、未捕获异常、强杀
 * 三种情况在进程外看起来一样。每次启动 / 信号 / 退出留一行到 vault（gitignore），下次先看它。
 */

const config = loadConfig();
const port = portOf(config);
life('boot', `port=${port} argv=${process.argv.slice(1).join(' ')}`);
const db = openDatabase(dbFile());
// 只读对账：config 是「想要谁」，meta 是「库里实际是谁」。两者不一致时下次同步本来就会清库，
// 启动先留一行账，避免只在同步日志里才看得到（不要自动把 meta 改成 config，否则换人会漏清）
for (const source of ['cf', 'at'] as const) {
  const owner = getMeta(db, handleMetaKey(source));
  const wanted = source === 'cf' ? config.cfHandle : config.atHandle;
  if (owner !== null && wanted !== '' && owner !== wanted) {
    life('handle-drift', `${source} data=${owner} config=${wanted}（下次同步会按新 handle 清空重建）`);
  }
}
const sources = {
  cf: createCfSource(db, new CfClient()),
  at: createAtSource(db, new AtClient()),
};

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
registerErrorHandler(app);
const work = new WorkService({
  db,
  getRoot: () => loadConfig().workspaceRoot,
  setRoot: (root) => {
    saveWorkspaceRoot(root);
  },
});
registerApi(app, {
  db,
  sources,
  getHandles: () => {
    const c = loadConfig();
    return { cf: c.cfHandle, at: c.atHandle };
  },
  setHandles: (patch) => saveHandles(patch),
  xcpc: {
    db,
    getKey: () => loadConfig().xcpcPlayerKey,
    setKey: (key) => saveXcpcPlayerKey(key),
    client: new XcpcClient(),
  },
  arena: new ArenaClient(),
  work,
});
// 冷启动静默对账上次中断的导入；根还没配置 / 初始化时 recover 会抛，忽略即可
void work.recoverImports().catch(() => undefined);
// `npm run dev` 会把这个置 0：开发时前端走 Vite(5173) + 代理，别再让 7788 顺带发一份
// 可能已经过期的 packages/web/dist —— 否则很容易对着旧 bundle 调 bug
if (process.env.ANVIL_SERVE_WEB !== '0') registerStatic(app, webDistDir);

try {
  await app.listen({ host: '127.0.0.1', port });
  writePid();
  life('listening', `port=${port}`);
} catch (err) {
  if ((err as { code?: string }).code === 'EADDRINUSE') {
    life('boot-failed', `port=${port} EADDRINUSE`);
    console.error(`[anvil] 端口 ${port} 已被占用：ANVIL 可能已经在跑了。关掉旧窗口再双击 start.bat。`);
    process.exit(1);
  }
  throw err;
}
initSnapshot(db);

const url = `http://localhost:${port}/`;
console.log(`[anvil] ${url} · vault ${dbFile()}`);

if (process.env.ANVIL_OPEN === '1') {
  const opener =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
      : spawn('open', [url], { stdio: 'ignore', detached: true });
  opener.unref();
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  life('shutdown.begin', `signal=${signal}`);
  await app.close();
  db.close();
  clearPid();
  life('shutdown.end');
  process.exit(0);
}

const signals: NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, () => void shutdown(signal));
process.on('exit', (code) => {
  clearPid();
  life('exit', `code=${code}`);
});
process.on('uncaughtException', (err) => {
  life('uncaughtException', err.stack ?? err.message);
  console.error('[anvil] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  life('unhandledRejection', reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  console.error('[anvil] unhandledRejection:', reason);
  process.exit(1);
});
