import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sharedSrc = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@anvil/shared': sharedSrc },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:7788' },
  },
  build: { outDir: 'dist', target: 'es2022' },
});
