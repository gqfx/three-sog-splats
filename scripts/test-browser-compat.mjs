import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const threeVersion = process.argv[2] ?? '0.184.0';
const temporary = await mkdtemp(resolve(tmpdir(), 'three-sog-browser-compat-'));
const checkout = resolve(temporary, 'checkout');
const excluded = new Set([
  '.git',
  '.tmp',
  '.cache',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const reservePort = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('Unable to reserve a browser compatibility test port.'));
      return;
    }
    const { port } = address;
    server.close((error) => (error ? reject(error) : resolvePort(port)));
  });
});

try {
  await cp(root, checkout, {
    recursive: true,
    filter: (source) => {
      const path = relative(root, source);
      if (!path) return true;
      return !excluded.has(path.split(sep)[0]);
    },
  });
  const packagePath = resolve(checkout, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.devDependencies.three = threeVersion;
  packageJson.devDependencies['@types/three'] = threeVersion;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: checkout,
    stdio: 'inherit',
  });
  const port = await reservePort();
  execFileSync('npm', ['run', 'test:browser'], {
    cwd: checkout,
    env: { ...process.env, PLAYWRIGHT_PORT: String(port) },
    stdio: 'inherit',
  });
  console.log(`Browser acceptance passed with Three.js ${threeVersion}.`);
} finally {
  if (process.env.CI) {
    for (const directory of ['playwright-report', 'test-results']) {
      try { await cp(resolve(checkout, directory), resolve(root, directory), { recursive: true }); }
      catch (error) { if (error.code !== 'ENOENT') { console.error(`Unable to copy ${directory}:`, error); process.exitCode = 1; } }
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
