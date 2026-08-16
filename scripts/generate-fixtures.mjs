import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const fixtureRoot = resolve(root, 'tests/fixtures/generated');
const codebook = Array.from({ length: 256 }, (_, index) => (index - 128) / 32);

await mkdir(fixtureRoot, { recursive: true });

const definitions = {
  means_l: [4, 2, '#102030'],
  means_u: [4, 2, '#708090'],
  scales: [4, 2, '#607080'],
  quats: [4, 2, '#a4b6c8fc'],
  sh0: [4, 2, '#8090a0'],
  shN_centroids: [192, 4, '#a08080'],
  shN_labels: [4, 2, '#000000'],
};

const temporary = await mkdtemp(resolve(tmpdir(), 'three-sog-fixtures-'));
const generator = resolve(temporary, 'generate.html');
await writeFile(generator, `<!doctype html><body><script>
const definitions = ${JSON.stringify(definitions)};
const result = {};
for (const [name, [width, height, color]] of Object.entries(definitions)) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { colorSpace: 'srgb' });
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  result[name] = canvas.toDataURL('image/webp', 1);
}
document.body.textContent = JSON.stringify(result);
</script>`);

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
let body;
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(generator).href);
  body = await page.locator('body').textContent();
} finally {
  await browser.close();
}
if (!body) throw new Error('Chrome did not return generated fixture data.');
const urls = JSON.parse(body);
await rm(temporary, { recursive: true, force: true });
for (const [name, url] of Object.entries(urls)) {
  await writeFile(resolve(fixtureRoot, `${name}.webp`), Buffer.from(url.split(',')[1], 'base64'));
}

const bytes = async (name) => new Uint8Array(await readFile(resolve(fixtureRoot, name)));

const commonMeta = {
  version: 2,
  count: 4,
  model: 'antialiased',
  means: { mins: [-1, -1, -1], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] },
  scales: { codebook, files: ['scales.webp'] },
  quats: { files: ['quats.webp'] },
  sh0: { codebook, files: ['sh0.webp'] },
};

const shared = {
  'means_l.webp': await bytes('means_l.webp'),
  'means_u.webp': await bytes('means_u.webp'),
  'scales.webp': await bytes('scales.webp'),
  'quats.webp': await bytes('quats.webp'),
  'sh0.webp': await bytes('sh0.webp'),
};

const encode = (meta, extra = {}) => zipSync({
  'meta.json': new TextEncoder().encode(JSON.stringify(meta)),
  ...shared,
  ...extra,
}, { level: 0 });

await writeFile(resolve(fixtureRoot, 'minimal-no-sh.sog'), encode(commonMeta));
await writeFile(resolve(fixtureRoot, 'minimal-sh1.sog'), encode({
  ...commonMeta,
  shN: {
    count: 256,
    bands: 1,
    codebook,
    files: ['shN_centroids.webp', 'shN_labels.webp'],
  },
}, {
  'shN_centroids.webp': await bytes('shN_centroids.webp'),
  'shN_labels.webp': await bytes('shN_labels.webp'),
}));
