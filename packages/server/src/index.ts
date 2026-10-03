import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import { dbFile, loadConfig, portOf, saveHandle, webDistDir } from './config.ts';
import { openDatabase } from './db.ts';
import { registerApi } from './api.ts';
import { registerStatic } from './static.ts';
import { CfClient } from './sync/cf.ts';
import { initSnapshot } from './sync/runner.ts';

const config = loadConfig();
const db = openDatabase(dbFile());
const client = new CfClient();

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
registerApi(app, {
  db,
  client,
  getHandle: () => loadConfig().cfHandle,
  setHandle: (handle) => saveHandle(handle),
});
registerStatic(app, webDistDir);

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
