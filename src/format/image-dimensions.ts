import { SOGError } from '../core/errors.js';
import type { SOGImageDimensions } from '../core/types.js';

function invalid(filename: string): never {
  throw new SOGError('IMAGE_DECODE_FAILED', `Invalid or unsupported image header in "${filename}". Animated images are not supported.`, { stage: 'decode' });
}

/** Inspect encoded dimensions without asking the browser to allocate pixels. */
export function readImageDimensions(bytes: Uint8Array, filename: string): SOGImageDimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (/\.png$/i.test(filename)) {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
      || view.getUint32(8) !== 13 || tag(12) !== 'IHDR') invalid(filename);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (offset + 12 + length > bytes.length || tag(offset + 4) === 'acTL') invalid(filename);
      offset += length + 12;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (!/\.webp$/i.test(filename) || bytes.length < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP'
    || view.getUint32(4, true) + 8 !== bytes.length) invalid(filename);
  const uint24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  let canvas: SOGImageDimensions | undefined;
  let image: SOGImageDimensions | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunk = tag(offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.length || chunk === 'ANIM' || chunk === 'ANMF') invalid(filename);
    if (chunk === 'VP8X') {
      if (canvas || length !== 10 || (bytes[start]! & 2) !== 0) invalid(filename);
      canvas = { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
    } else if (chunk === 'VP8L') {
      if (image || length < 5 || bytes[start] !== 0x2f) invalid(filename);
      const dimensions = view.getUint32(start + 1, true);
      image = { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
    } else if (chunk === 'VP8 ') {
      if (image || length < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) invalid(filename);
      image = { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
    }
    offset = start + length + (length & 1);
  }
  if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) invalid(filename);
  return image;
}
