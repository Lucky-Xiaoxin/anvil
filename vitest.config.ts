import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@anvil/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
  },
});
