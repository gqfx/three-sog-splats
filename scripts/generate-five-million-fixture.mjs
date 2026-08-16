import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'tests/fixtures/generated/five-million.sog');
const count = 5_000_000;
const width = 4_096;
const height = Math.ceil(count / width);
const latticeSize = 171;
const logExtent = Math.log(2);
const temporary = await mkdtemp(resolve(tmpdir(), 'three-sog-five-million-'));
const generator = resolve(temporary, 'generate.html');

await writeFile(generator, `<!doctype html><script>
const count = ${count};
const width = ${width};
const height = ${height};
const latticeSize = ${latticeSize};

function solid(context, red, green, blue, alpha = 255) {
  context.fillStyle = 'rgba(' + red + ',' + green + ',' + blue + ',' + (alpha / 255) + ')';
  context.fillRect(0, 0, width, height);
}

globalThis.generateTexture = (kind) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (kind === 'means_l') solid(context, 0, 0, 0);
  else if (kind === 'quats') solid(context, 128, 128, 128, 252);
  else if (kind === 'scales') solid(context, 128, 128, 128);
  else {
    const image = context.createImageData(width, height);
    const data = image.data;
    for (let index = 0; index < count; index += 1) {
      const x = index % latticeSize;
      const y = Math.floor(index / latticeSize) % latticeSize;
      const z = Math.floor(index / (latticeSize * latticeSize));
      const offset = index * 4;
      const red = Math.round((x / (latticeSize - 1)) * 255);
      const green = Math.round((y / (latticeSize - 1)) * 255);
      const blue = Math.round((z / (latticeSize - 1)) * 255);
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = kind === 'sh0' ? 24 : 255;
    }
    context.putImageData(image, 0, 0);
  }
  return canvas.toDataURL('image/webp', 1);
};
</script>`);

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const files = {};
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(generator).href);
  for (const name of ['means_l', 'means_u', 'quats', 'scales', 'sh0']) {
    const url = await page.evaluate((kind) => globalThis.generateTexture(kind), name);
    const filename = `${name}.webp`;
    const path = resolve(temporary, filename);
    await writeFile(path, Buffer.from(url.split(',')[1], 'base64'));
    files[filename] = new Uint8Array(await readFile(path));
  }
} finally {
  await browser.close();
}

const scaleCodebook = Array.from({ length: 256 }, () => Math.log(0.009));
const colorCodebook = Array.from(
  { length: 256 },
  (_, index) => ((index / 255) - 0.5) / 0.28209479177387814,
);
const meta = {
  version: 2,
  asset: { generator: 'three-sog-splats 5M synthetic lattice' },
  count,
  model: 'antialiased',
  means: {
    mins: [-logExtent, -logExtent, -logExtent],
    maxs: [logExtent, logExtent, logExtent],
    files: ['means_l.webp', 'means_u.webp'],
  },
  scales: { codebook: scaleCodebook, files: ['scales.webp'] },
  quats: { files: ['quats.webp'] },
  sh0: { codebook: colorCodebook, files: ['sh0.webp'] },
};
const archive = zipSync({
  'meta.json': new TextEncoder().encode(JSON.stringify(meta)),
  ...files,
}, { level: 0, mtime: new Date('1980-01-01T00:00:00.000Z') });
await writeFile(output, archive);
await rm(temporary, { recursive: true, force: true });
console.log(`Generated ${output}: ${count.toLocaleString()} splats, ${width}x${height} textures, ${(archive.byteLength / 1_048_576).toFixed(1)} MiB.`);
