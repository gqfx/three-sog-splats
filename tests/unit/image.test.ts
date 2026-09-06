import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSOGImageDecoder } from '../../src/format/image.js';
import { readImageDimensions } from '../../src/format/image-dimensions.js';

function png(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

afterEach(() => vi.unstubAllGlobals());

it('reads PNG and real WebP headers without decoding pixels', () => {
  expect(readImageDimensions(png(4096, 1221), 'image.png')).toEqual({ width: 4096, height: 1221 });
  const webp = readFileSync(new URL('../fixtures/generated/means_l.webp', import.meta.url));
  expect(readImageDimensions(webp, 'image.webp')).toEqual({ width: 4, height: 2 });
  expect(() => readImageDimensions(Uint8Array.of(1), 'image.webp')).toThrow(/header/);
  expect(() => readImageDimensions(webp.subarray(0, 19), 'image.webp')).toThrow(/header/);
});

it('rejects animated or contradictory WebP headers before decoding', () => {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const tag = (value: string, offset: number) => bytes.set(new TextEncoder().encode(value), offset);
  tag('RIFF', 0); view.setUint32(4, 36, true); tag('WEBP', 8);
  tag('VP8X', 12); view.setUint32(16, 10, true);
  bytes[20] = 2;
  expect(() => readImageDimensions(bytes, 'image.webp')).toThrow(/Animated/);
  bytes[20] = 0;
  tag('VP8L', 30); view.setUint32(34, 5, true); bytes[38] = 0x2f;
  view.setUint32(39, 1, true); // 2x1 image in a 1x1 canvas.
  expect(() => readImageDimensions(bytes, 'image.webp')).toThrow(/header/);
});

it('closes a bitmap that finishes decoding after cancellation', async () => {
  vi.stubGlobal('Worker', undefined);
  const controller = new AbortController();
  const close = vi.fn();
  let complete!: (bitmap: unknown) => void;
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((resolve) => { complete = resolve; })));
  const result = new BrowserSOGImageDecoder().decode(png(2, 2), 'image.png', controller.signal);
  controller.abort();
  complete({ width: 2, height: 2, close });
  await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
  expect(close).toHaveBeenCalledOnce();
});

it('reuses loader-scoped image workers and closes the pool', async () => {
  const instances: any[] = [];
  class Worker {
    onmessage: any;
    onerror: any;
    terminate = vi.fn();
    constructor() { instances.push(this); }
    postMessage() { queueMicrotask(() => this.onmessage({ data: { bitmap: { width: 2, height: 2, close: vi.fn() } } })); }
  }
  vi.stubGlobal('Worker', Worker);
  const decoder = new BrowserSOGImageDecoder(true);
  const signal = new AbortController().signal;
  for (let i = 0; i < 7; i += 1) (await decoder.decode(png(2, 2), 'image.png', signal)).close();
  expect(instances).toHaveLength(1);
  decoder.dispose();
  expect(instances[0].terminate).toHaveBeenCalledOnce();
});
