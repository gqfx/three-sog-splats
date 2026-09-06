import { SOGError } from '../core/errors.js';
import type { SOGImageDimensions, SOGLoadOptions } from '../core/types.js';

export const DEFAULT_MAX_IMAGE_DIMENSION = 8192;
export const DEFAULT_MAX_IMAGE_PIXELS = 8_388_608;
export const DEFAULT_MAX_DECODED_BYTES = 256 * 1024 * 1024;
export const DEFAULT_DECODE_CONCURRENCY = 2;

export function imageBudget(options: SOGLoadOptions) {
  const positive = (value: number | undefined, fallback: number, name: string) => {
    const limit = value ?? fallback;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
    return limit;
  };
  const concurrency = positive(options.decodeConcurrency, DEFAULT_DECODE_CONCURRENCY, 'decodeConcurrency');
  if (concurrency > 7) throw new RangeError('decodeConcurrency must be no greater than 7.');
  return {
    maxDimension: positive(options.maxImageDimension, DEFAULT_MAX_IMAGE_DIMENSION, 'maxImageDimension'),
    maxPixels: positive(options.maxImagePixels, DEFAULT_MAX_IMAGE_PIXELS, 'maxImagePixels'),
    maxBytes: positive(options.maxDecodedBytes, DEFAULT_MAX_DECODED_BYTES, 'maxDecodedBytes'),
    concurrency,
  };
}

export function addImageBytes(dimensions: SOGImageDimensions, total: number, budget: ReturnType<typeof imageBudget>, filename: string): number {
  const { width, height } = dimensions;
  const pixels = width * height;
  const nextTotal = total + pixels * 4;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > budget.maxDimension || height > budget.maxDimension
    || !Number.isSafeInteger(pixels) || pixels > budget.maxPixels
    || !Number.isSafeInteger(nextTotal) || nextTotal > budget.maxBytes) {
    throw new SOGError('IMAGE_DECODE_FAILED', `SOG image "${filename}" exceeds the decoded image dimension, pixel, or byte budget.`, { stage: 'decode' });
  }
  return nextTotal;
}
