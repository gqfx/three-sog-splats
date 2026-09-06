import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const required = ['dist/index.js', 'dist/index.d.ts', 'dist/workers/archive.worker.js', 'dist/workers/image.worker.js', 'dist/workers/sort.worker.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
for (const file of required) await access(resolve(root, file));
for (const entry of Object.values(manifest.exports)) {
  for (const file of Object.values(entry)) await access(resolve(root, file));
}
const { readdir } = await import('node:fs/promises');
for (const file of await readdir(resolve(root, 'dist'), { recursive: true })) {
  if (!file.endsWith('.map')) continue;
  const mapFile = resolve(root, 'dist', file);
  const map = JSON.parse(await readFile(mapFile, 'utf8'));
  for (let index = 0; index < map.sources.length; index += 1) {
    if (map.sourcesContent?.[index] == null) await access(resolve(dirname(mapFile), map.sources[index]));
  }
}
console.error('Package entry points, workers, licenses and source maps verified.');
