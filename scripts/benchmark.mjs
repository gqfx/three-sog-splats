import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Matrix4 } from 'three/webgpu';
import { createDepthKeys } from '../dist/render/sort/depth.js';
import { radixSortIndices } from '../dist/render/sort/radix.js';

const root = resolve(import.meta.dirname, '..');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : chromium.executablePath());
const server = spawn('npm', ['run', 'example', '--', '--host', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4173/');
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('Benchmark example server did not start.');
}

function syntheticCpuBenchmark(count) {
  const centers = new Float32Array(count * 3);
  let seed = 0x12345678;
  for (let index = 0; index < centers.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    centers[index] = (seed / 0xffffffff) * 20 - 10;
  }
  const matrix = new Matrix4().makeRotationY(0.37);
  const runs = [];
  for (let run = 0; run < 5; run += 1) {
    const startedAt = performance.now();
    radixSortIndices(createDepthKeys(centers, matrix));
    runs.push(performance.now() - startedAt);
  }
  const expanded = new Float32Array(count * 59);
  for (let index = 0; index < expanded.length; index += 1024) expanded[index] = index;
  return {
    count,
    centersAndOrderBytes: count * 16,
    nativeMvpEstimatedBytes: count * 52,
    fullExpandedSh3Bytes: expanded.byteLength,
    sortRunsMs: runs,
    medianSortMs: [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)],
    expandedToNativeRatio: expanded.byteLength / (count * 52),
  };
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer', '--enable-precise-memory-info'],
  });
  const browserResults = [];
  try {
    for (const backend of ['webgpu', 'webgl']) {
      for (const fixture of ['no-sh', 'sh']) {
        const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
        await page.goto(`http://127.0.0.1:4173/?fixture=${fixture}${backend === 'webgl' ? '&backend=webgl' : ''}`);
        await page.waitForFunction(() => window.__SOG_EXAMPLE__?.state === 'ready');
        await page.waitForFunction(() => (window.__SOG_EXAMPLE__?.diagnostics?.firstVisibleFrameDurationMs ?? 0) > 0);
        browserResults.push(await page.evaluate(() => ({
          requestedBackend: new URLSearchParams(location.search).get('backend') ?? 'webgpu',
          fixture: window.__SOG_EXAMPLE__.fixture,
          selectedBackend: window.__SOG_EXAMPLE__.backend,
          load: window.__SOG_EXAMPLE__.loadDiagnostics,
          render: window.__SOG_EXAMPLE__.diagnostics,
          usedJsHeapBytes: 'memory' in performance
            ? performance.memory.usedJSHeapSize
            : null,
          userAgent: navigator.userAgent,
        })));
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      chrome,
    },
    fixtureNote: 'Synthetic four-splat fixtures measure fixed pipeline/load cost; the CPU stress case measures scalable sort and memory cost.',
    browsers: browserResults,
    cpuStress: syntheticCpuBenchmark(250_000),
    mvpLimit: {
      splats: 5_000_000,
      estimatedNativeGpuBytes: 5_000_000 * 52,
      nextPowerOfTwoSortCapacity: 2_097_152,
    },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.kill('SIGTERM');
}
