import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'node:net';

const root = resolve(import.meta.dirname, '..');
const threeVersion = process.argv[2] ?? process.env.THREE_COMPAT_VERSION ?? '0.184.0';
const temporary = await mkdtemp(resolve(tmpdir(), 'three-sog-consumer-'));
const packDirectory = resolve(temporary, 'pack');
const consumer = resolve(temporary, 'consumer');
await mkdir(packDirectory);
await mkdir(resolve(consumer, 'src'), { recursive: true });

const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  // A clean dist proves npm pack invokes its own build gate.
  run('npm', ['run', 'clean']);
  const packResult = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDirectory]));
  const tarballName = packResult[0]?.filename;
  if (!tarballName) throw new Error('npm pack did not report a tarball.');
  const packedFiles = new Set((packResult[0]?.files ?? []).map((file) => file.path));
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'src/index.ts',
    'dist/workers/archive.worker.js',
    'dist/workers/image.worker.js',
    'dist/workers/sort.worker.js',
    'docs/performance-limits.md',
  ]) {
    if (!packedFiles.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }
  const tarball = resolve(packDirectory, basename(tarballName));

  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({
    name: 'three-sog-external-consumer',
    private: true,
    type: 'module',
    dependencies: {
      three: threeVersion,
      'three-sog-splats': `file:${tarball}`,
    },
    devDependencies: {
      '@types/three': threeVersion,
      typescript: '^5.9.2',
      vite: '^7.1.2',
    },
  }, null, 2));
  await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src'],
  }, null, 2));
  await writeFile(resolve(consumer, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.ts"></script>');
  await writeFile(resolve(consumer, 'src/main.ts'), await readFile(resolve(root, 'scripts/consumer-entry.txt'), 'utf8'));
  await mkdir(resolve(consumer, 'public'));
  await cp(resolve(root, 'tests/fixtures/generated/minimal-sh1.sog'), resolve(consumer, 'public/fixture.sog'));
  await writeFile(resolve(consumer, 'vite.config.js'), 'export default { build: { target: "es2022" } };');

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  run('npm', ['exec', 'tsc', '--', '--noEmit'], consumer);
  run('npm', ['exec', 'vite', '--', 'build'], consumer);
  const dependencyTree = run('npm', ['ls', 'three', '--all'], consumer);
  const threeLines = dependencyTree.split('\n').filter((line) => /three@/.test(line));
  if (threeLines.some((line) => !line.includes(`three@${threeVersion}`))) {
    throw new Error(`Unexpected Three.js resolution:\n${dependencyTree}`);
  }

  const distRoot = resolve(root, 'dist');
  const files = await readdir(distRoot, { recursive: true });
  const javascript = await Promise.all(files
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFile(resolve(distRoot, file), 'utf8')));
  const output = javascript.join('\n');
  const executableOutput = output.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  for (const forbidden of ['playcanvas', 'potree-engine', 'three/src/', 'three/build/']) {
    if (executableOutput.toLowerCase().includes(forbidden)) {
      throw new Error(`Distribution contains forbidden runtime/reference code: ${forbidden}`);
    }
  }
  if (!output.includes("from 'three/webgpu'") || !output.includes("from 'three/tsl'")) {
    throw new Error('Three.js entry points were not preserved as external ESM imports.');
  }

  const port = await new Promise((resolvePort, reject) => {
    const socket = createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address(); socket.close(() => resolvePort(port));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(resolve(consumer, 'node_modules/.bin/vite'), [
    'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      try { response = await fetch(baseUrl); if (response.ok) break; } catch { /* starting */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    if (!response?.ok) throw new Error('The production consumer preview did not start.');
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'] });
    for (const backend of ['webgl', 'webgpu']) {
      const page = await browser.newPage();
      const errors = []; const workers = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('worker', (worker) => workers.push(worker.url()));
      page.on('console', (message) => {
        if (/GPUValidationError|validation error|GL_INVALID_OPERATION/.test(message.text())) errors.push(message.text());
      });
      await page.goto(`${baseUrl}/?backend=${backend}`);
      if (backend === 'webgpu') {
        const available = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
        if (!available) {
          if (process.env.SOG_REQUIRE_WEBGPU === '1') throw new Error('Required WebGPU unavailable in package consumer.');
          console.log('Package consumer WebGPU skipped: adapter unavailable.'); await page.close(); continue;
        }
      }
      await page.waitForFunction(() => window.__CONSUMER__?.state === 'ready' && window.__CONSUMER__.sorts >= 2);
      const state = await page.evaluate(() => window.__CONSUMER__);
      if (state.backend !== backend || errors.length) throw new Error(JSON.stringify({ state, errors }));
      if (!workers.some((url) => url.includes('archive.worker')) || !workers.some((url) => url.includes('image.worker'))
        || (backend === 'webgl' && !workers.some((url) => url.includes('sort.worker')))) {
        throw new Error(`Published workers were not exercised: ${workers.join(', ')}`);
      }
      await page.evaluate(() => window.disposeConsumer()); await page.close();
    }
  } finally {
    await browser?.close(); server.kill('SIGTERM');
  }
  console.log(`External package consumer on Three.js ${threeVersion}: clean pack, types, production build, real workers and render verified.`);

} finally {
  await rm(temporary, { recursive: true, force: true });
}
