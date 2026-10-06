import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import { dbFile, loadConfig, portOf, saveHandles, saveXcpcPlayerKey, webDistDir } from './config.ts';
import { openDatabase } from './db.ts';
import { registerApi } from './api.ts';
import { registerStatic } from './static.ts';
import { AtClient, createAtSource } from './sync/at.ts';
import { CfClient } from './sync/cf.ts';
import { createCfSource } from './sync/job.ts';
import { initSnapshot } from './sync/runner.ts';
import { XcpcClient } from './sync/xcpc.ts';

const config = loadConfig();
const db = openDatabase(dbFile());
const sources = {
  cf: createCfSource(db, new CfClient()),
  at: createAtSource(db, new AtClient()),
};

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
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
});
// `npm run dev` 会把这个置 0：开发时前端走 Vite(5173) + 代理，别再让 7788 顺带发一份
// 可能已经过期的 packages/web/dist —— 否则很容易对着旧 bundle 调 bug
if (process.env.ANVIL_SERVE_WEB !== '0') registerStatic(app, webDistDir);

const port = portOf(config);
try {
  await app.listen({ host: '127.0.0.1', port });
} catch (err) {
  if ((err as { code?: string }).code === 'EADDRINUSE') {
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

async function shutdown(): Promise<void> {
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
