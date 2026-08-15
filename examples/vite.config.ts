import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const threeCompatibilityRoot = process.env.THREE_COMPAT_ROOT;

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: resolve(import.meta.dirname, '../tests/fixtures/generated'),
  build: {
    chunkSizeWarningLimit: 1_000,
    rollupOptions: {
      input: {
        harness: resolve(import.meta.dirname, 'index.html'),
        example: resolve(import.meta.dirname, 'webgpu_sog.html'),
      },
    },
  },
  ...(threeCompatibilityRoot ? {
    resolve: {
      alias: [
        { find: /^three$/, replacement: resolve(threeCompatibilityRoot, 'build/three.module.js') },
        { find: /^three\/webgpu$/, replacement: resolve(threeCompatibilityRoot, 'build/three.webgpu.js') },
        { find: /^three\/tsl$/, replacement: resolve(threeCompatibilityRoot, 'build/three.tsl.js') },
        { find: /^three\/addons\/(.*)$/, replacement: resolve(threeCompatibilityRoot, 'examples/jsm/$1') },
      ],
    },
  } : {}),
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
