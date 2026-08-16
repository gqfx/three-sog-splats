import { zipSync } from 'fflate';
import type {
  SOGAttributeName,
  SOGImageDecoder,
  SOGNativeImage,
} from '../../src/core/types.js';

export const codebook = Array.from({ length: 256 }, (_, index) => index / 255);

export const validMeta = {
  version: 2,
  count: 4,
  means: { mins: [-1, -1, -1], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] },
  scales: { codebook, files: ['scales.webp'] },
  quats: { files: ['quats.webp'] },
  sh0: { codebook, files: ['sh0.webp'] },
} as const;

export function createBundle(
  meta: unknown = validMeta,
  options: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; omit?: string } = {},
): ArrayBuffer {
  const entries: Record<string, Uint8Array> = {
    'meta.json': new TextEncoder().encode(JSON.stringify(meta)),
    'means_l.webp': new Uint8Array([1]),
    'means_u.webp': new Uint8Array([2]),
    'scales.webp': new Uint8Array([3]),
    'quats.webp': new Uint8Array([4]),
    'sh0.webp': new Uint8Array([5]),
    'shN_centroids.webp': new Uint8Array([6]),
    'shN_labels.webp': new Uint8Array([7]),
  };
  if (options.omit) delete entries[options.omit];
  const zip = zipSync(entries, { level: options.level ?? 0 });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
}

export function bundleResponse(buffer: ArrayBuffer): Response {
  return new Response(buffer.slice(0), {
    status: 200,
    headers: { 'content-length': String(buffer.byteLength) },
  });
}

export class FakeImageDecoder implements SOGImageDecoder {
  decoded = 0;
  closed = 0;
  readonly width: number;
  readonly height: number;
  readonly dimensions: Readonly<Record<string, readonly [number, number]>>;

  constructor(width = 2, height = 2, dimensions: Readonly<Record<string, readonly [number, number]>> = {}) {
    this.width = width;
    this.height = height;
    this.dimensions = dimensions;
  }

  async decode(_bytes: Uint8Array, filename: string, signal: AbortSignal): Promise<SOGNativeImage> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    this.decoded += 1;
    const [width, height] = this.dimensions[filename] ?? [this.width, this.height];
    const source = { width, height } as unknown as TexImageSource;
    return {
      attribute: filename.replace('.webp', '') as SOGAttributeName,
      filename,
      width,
      height,
      source,
      close: () => {
        this.closed += 1;
      },
    };
  }
}

export function mutateCompressionMethod(buffer: ArrayBuffer, method: number): ArrayBuffer {
  const result = buffer.slice(0);
  const view = new DataView(result);
  for (let offset = 0; offset <= result.byteLength - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50) view.setUint16(offset + 10, method, true);
    if (signature === 0x04034b50) view.setUint16(offset + 8, method, true);
  }
  return result;
}

export function mutateEncryptionFlag(buffer: ArrayBuffer): ArrayBuffer {
  const result = buffer.slice(0);
  const view = new DataView(result);
  for (let offset = 0; offset <= result.byteLength - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50) view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
    if (signature === 0x04034b50) view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
  }
  return result;
}

export function mutateZip64Marker(buffer: ArrayBuffer): ArrayBuffer {
  const result = buffer.slice(0);
  const view = new DataView(result);
  for (let offset = result.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      view.setUint16(offset + 8, 0xffff, true);
      view.setUint16(offset + 10, 0xffff, true);
      return result;
    }
  }
  return result;
}

export function corruptFirstStoredEntry(buffer: ArrayBuffer): ArrayBuffer {
  const result = buffer.slice(0);
  const view = new DataView(result);
  for (let offset = 0; offset <= result.byteLength - 30; offset += 1) {
    if (view.getUint32(offset, true) === 0x04034b50 && view.getUint16(offset + 8, true) === 0) {
      const dataOffset = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      view.setUint8(dataOffset, view.getUint8(dataOffset) ^ 0xff);
      return result;
    }
  }
  return result;
}
