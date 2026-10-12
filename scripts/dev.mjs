import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const children = [];

function shutdown() {
  for (const c of children) c.kill();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', '--watch', 'packages/server/src/index.ts'],
  { stdio: 'inherit', env: { ...process.env, ANVIL_SERVE_WEB: '0' } },
);
// 登记进 children：非常规收掉父进程（taskkill 等）时，退出清理不能漏掉 API 子进程
children.push(server);
server.on('exit', (code) => {
  process.exitCode = code ?? 0;
  shutdown();
});

const vite = await createServer({
  configFile: 'packages/web/vite.config.ts',
  root: 'packages/web',
});
await vite.listen();
children.push({ kill: () => vite.close() });
console.log(`[anvil] web dev http://localhost:5173 · api http://localhost:${process.env.ANVIL_PORT ?? '7788'}`);
