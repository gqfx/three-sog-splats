import { createHash } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const manifest = JSON.parse(await readFile(new URL('../tests/fixtures/manifest.json', import.meta.url), 'utf8'));
const directory = resolve(process.env.SOG_FIXTURE_DIR ?? fileURLToPath(new URL('../tests/fixtures/generated', import.meta.url)));
const verifyOnly = process.argv.includes('--verify');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (bytes, entry) => bytes.length === entry.bytes && hash(bytes) === entry.sha256;
await mkdir(directory, { recursive: true });
for (const entry of manifest.files) {
  const destination = resolve(directory, entry.file);
  let existing;
  try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && check(existing, entry)) { console.log(`Verified ${entry.file}`); continue; }
  if (existing) throw new Error(`Fixture checksum mismatch: ${entry.file}. Move the modified file aside before fetching.`);
  if (verifyOnly || !entry.source) throw new Error(`Missing ${entry.file}; restore tracked fixtures or run npm run fixtures:fetch for Moon.`);
  const files = {};
  for (const part of entry.entries) {
    console.log(`Fetching ${entry.file}/${part.name}`);
    const response = await fetch(new URL(part.name, entry.source), { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > part.bytes) throw new Error(`Failed fixture response: ${part.name}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > part.bytes) throw new Error(`Fixture response exceeds expected size: ${part.name}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!check(bytes, part)) throw new Error(`Upstream checksum mismatch: ${part.name}`);
    files[part.name] = bytes;
  }
  const archive = zipSync(files, { level: 0, mtime: new Date(...entry.zipMtime) });
  if (!check(archive, entry)) throw new Error(`Reconstructed archive checksum mismatch: ${entry.file}`);
  const temporary = `${destination}.${process.pid}.tmp`;
  try { await writeFile(temporary, archive, { flag: 'wx' }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  console.log(`Fetched and verified ${entry.file}`);
}
