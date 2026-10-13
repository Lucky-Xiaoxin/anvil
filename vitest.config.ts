import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@anvil/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    // 禁真实网络：fetch 在 setup 里被 stub 成抛错替身（技术锁），要出网的测试自己注入 fetchImpl
    setupFiles: ['./vitest.setup.ts'],
  },
});
