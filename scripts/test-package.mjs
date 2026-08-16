import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const threeVersion = process.env.THREE_COMPAT_VERSION ?? '0.184.0';
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
  run('npm', ['run', 'build']);
  const packResult = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDirectory]));
  const tarballName = packResult[0]?.filename;
  if (!tarballName) throw new Error('npm pack did not report a tarball.');
  const packedFiles = new Set((packResult[0]?.files ?? []).map((file) => file.path));
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
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
  await writeFile(resolve(consumer, 'src/main.ts'), `
import { SOGGaussianSplatMesh, SOGLoader, SOGError } from 'three-sog-splats';
import type { SOGErrorCode, SOGLoadOptions, SOGRenderDiagnostics } from 'three-sog-splats';
import { WebGPURenderer } from 'three/webgpu';

const renderer = new WebGPURenderer({ forceWebGL: true });
const loader: SOGLoader = new SOGLoader();
const options: SOGLoadOptions = {};
const exportedTypes: SOGRenderDiagnostics | undefined = undefined;
const errorCode: SOGErrorCode = 'ABORTED';
document.querySelector('#app')!.textContent = [
  SOGGaussianSplatMesh.name,
  SOGError.name,
  renderer.isWebGPURenderer,
  loader instanceof SOGLoader,
  options,
  exportedTypes,
  errorCode,
].join(':');
`);

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

  const server = spawn(resolve(consumer, 'node_modules/.bin/vite'), [
    '--host', '127.0.0.1', '--port', '4174', '--strictPort',
  ], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      try {
        response = await fetch('http://127.0.0.1:4174/');
        if (response.ok) break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    if (!response?.ok) throw new Error('The external consumer example server did not start.');
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`External package consumer on Three.js ${threeVersion}: types, peer resolution, Vite build, exports, and startup verified.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
