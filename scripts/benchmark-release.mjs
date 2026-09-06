import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const port = await new Promise((resolvePort, reject) => {
  const socket = createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => resolvePort(port)); });
});
const url = `http://127.0.0.1:${port}`;
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['preview', '--config', 'examples/vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const rounds = Number(process.env.SOG_BENCH_ROUNDS ?? 1);
const samples = []; let browser;
try {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('SOG_BENCH_ROUNDS must be 1..10.');
  const deadline = Date.now() + 10000;
  while (true) {
    try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Production preview did not start.');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'] });
  for (let round = 0; round < rounds; round += 1) {
    for (const [source, backend] of [['no-sh', 'webgpu'], ['sh', 'webgpu'], ['tomatoes', 'webgpu'], ['moon-5m', 'webgpu'], ['sh', 'webgl'], ['tomatoes', 'webgl']]) {
      const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        const start = performance.now();
        await page.goto(`${url}/webgpu_sog.html?source=${source}&backend=${backend}`);
        await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state), null, { timeout: 60000 });
        const readyMs = performance.now() - start;
        const state = await page.evaluate(() => ({ backend: window.__THREE_SOG_EXAMPLE__.backend, error: window.__THREE_SOG_EXAMPLE__.error }));
        if (state.error || state.backend !== backend) throw new Error(JSON.stringify(state));
        await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.resetPerformance());
        await page.waitForTimeout(3000);
        const idle = await page.evaluate(() => JSON.parse(document.querySelector('#diagnostics').textContent));
        await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.startCameraMotion());
        await page.waitForTimeout(3000);
        const orbit = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.performance);
        const row = { round, source, backend, cache: 'fresh-context', readyMs, idle, orbit };
        samples.push(row);
        console.log(JSON.stringify({ round, source, backend, readyMs, archiveMs: idle.load?.stages.archive?.durationMs, idleFps: idle.performance?.fps, orbitFps: orbit?.fps, sortsPerSecond: orbit?.sortsPerSecond }));
      } finally { await context.close(); }
    }
  }
  if (process.env.SOG_BENCH_NETWORK === '1') {
    const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 50_000_000 / 8, uploadThroughput: 10_000_000 / 8 });
      for (const cache of ['cold', 'warm']) {
        const start = performance.now();
        await page.goto(`${url}/webgpu_sog.html?source=moon-5m`);
        await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state), null, { timeout: 120000 });
        const readyMs = performance.now() - start;
        await page.waitForFunction(() => window.__THREE_SOG_EXAMPLE__?.performance?.sampleFrames > 0);
        const diagnostics = await page.evaluate(() => JSON.parse(document.querySelector('#diagnostics').textContent));
        const row = { source: 'moon-5m', backend: 'webgpu', network: '50 Mbps down / 10 Mbps up / 40 ms latency', cache, readyMs, diagnostics };
        samples.push(row); console.log(JSON.stringify({ network: row.network, cache, readyMs }));
      }
    } finally { await context.close(); }
  }
  const output = resolve(process.env.SOG_BENCH_OUTPUT ?? 'benchmark-results/release.json');
  await mkdir(resolve(output, '..'), { recursive: true });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), source: { commit, dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0 }, environment: { node: process.version, platform: process.platform, arch: process.arch, browser: browser.version(), viewport: [960, 640], dpr: 1, build: 'production', sampleSecondsPerState: 3, rounds }, samples }, null, 2) + '\n');
  console.log(`Saved ${output}`);
} finally { await browser?.close(); server.kill('SIGTERM'); }
