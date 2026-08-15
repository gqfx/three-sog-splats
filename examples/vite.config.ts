import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: resolve(import.meta.dirname, '../tests/fixtures/generated'),
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
