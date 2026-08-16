/*
 * Camera-relative bin weighting is adapted from PlayCanvas Engine commit
 * 8f41866882d36f0f0e8f22b77ebf7f9fa7b102f6 (MIT), specifically
 * gsplat-sort-bin-weights.js. See THIRD_PARTY_NOTICES.md.
 */
import type { Box3, Matrix4 } from 'three/webgpu';

export const ADAPTIVE_DEPTH_BIN_COUNT = 32;
export const MIN_ADAPTIVE_DEPTH_BITS = 10;
export const MAX_ADAPTIVE_DEPTH_BITS = 20;

const BIN_EPSILON = 0.001;

export interface AdaptiveDepthRange {
  readonly min: number;
  readonly max: number;
  readonly range: number;
}

export interface AdaptiveDepthKeyConfig extends AdaptiveDepthRange {
  readonly requestedBits: number;
  readonly bits: number;
  readonly bucketCount: number;
  readonly cameraBin: number;
  readonly binWeights: Float32Array;
}

export function requestedAdaptiveDepthBits(count: number): number {
  const estimate = Math.round(Math.log2(Math.max(1, count) / 4));
  return Math.max(MIN_ADAPTIVE_DEPTH_BITS, Math.min(MAX_ADAPTIVE_DEPTH_BITS, estimate));
}

export function roundRadixBits(bits: number, radixBits: 4 | 8): number {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new RangeError('Radix bit count must be an integer in the range 0..32.');
  }
  return Math.min(32, Math.ceil(bits / radixBits) * radixBits);
}

export function sanitizeDepthRange(min: number, max: number): AdaptiveDepthRange {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: -0.5, max: 0.5, range: 1 };
  }
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  const range = upper - lower;
  if (!Number.isFinite(range) || range <= Number.EPSILON) {
    const center = Number.isFinite(lower) ? lower : 0;
    return { min: center - 0.5, max: center + 0.5, range: 1 };
  }
  return { min: lower, max: upper, range };
}

export function cameraRelativeDepthRange(bounds: Box3, viewMatrix: Matrix4): AdaptiveDepthRange {
  const elements = viewMatrix.elements;
  let min = Infinity;
  let max = -Infinity;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = (corner & 1) === 0 ? bounds.min.x : bounds.max.x;
    const y = (corner & 2) === 0 ? bounds.min.y : bounds.max.y;
    const z = (corner & 4) === 0 ? bounds.min.z : bounds.max.z;
    const viewZ = (elements[2] ?? 0) * x
      + (elements[6] ?? 0) * y
      + (elements[10] ?? 0) * z
      + (elements[14] ?? 0);
    min = Math.min(min, viewZ);
    max = Math.max(max, viewZ);
  }
  return sanitizeDepthRange(min, max);
}

function depthBinWeight(distance: number): number {
  if (distance === 0) return 40;
  if (distance <= 2) return 20;
  if (distance <= 5) return 8;
  if (distance <= 10) return 3;
  return 1;
}

export function createDepthBinWeights(cameraBin: number, bucketCount: number): Float32Array {
  if (!Number.isInteger(bucketCount) || bucketCount < ADAPTIVE_DEPTH_BIN_COUNT) {
    throw new RangeError(`Adaptive depth sorting requires at least ${ADAPTIVE_DEPTH_BIN_COUNT} buckets.`);
  }
  const clampedCameraBin = Math.max(0, Math.min(ADAPTIVE_DEPTH_BIN_COUNT - 1, Math.floor(cameraBin)));
  const weights = new Float32Array(ADAPTIVE_DEPTH_BIN_COUNT);
  let totalWeight = 0;
  for (let bin = 0; bin < ADAPTIVE_DEPTH_BIN_COUNT; bin += 1) {
    const weight = depthBinWeight(Math.abs(bin - clampedCameraBin));
    weights[bin] = weight;
    totalWeight += weight;
  }
  const result = new Float32Array(ADAPTIVE_DEPTH_BIN_COUNT * 2);
  let accumulated = 0;
  for (let bin = 0; bin < ADAPTIVE_DEPTH_BIN_COUNT; bin += 1) {
    const divider = Math.max(1, Math.floor(((weights[bin] ?? 1) / totalWeight) * bucketCount));
    result[bin * 2] = accumulated;
    result[bin * 2 + 1] = divider;
    accumulated += divider;
  }
  if (accumulated > bucketCount) {
    const lastDivider = result.length - 1;
    result[lastDivider] = Math.max(1, (result[lastDivider] ?? 1) - (accumulated - bucketCount));
  }
  return result;
}

export function createAdaptiveDepthKeyConfig(
  count: number,
  radixBits: 4 | 8,
  minimumDepth: number,
  maximumDepth: number,
): AdaptiveDepthKeyConfig {
  const requestedBits = requestedAdaptiveDepthBits(count);
  const bits = roundRadixBits(requestedBits, radixBits);
  const bucketCount = 2 ** bits;
  const depthRange = sanitizeDepthRange(minimumDepth, maximumDepth);
  const cameraBin = Math.max(0, Math.min(
    ADAPTIVE_DEPTH_BIN_COUNT - 1,
    Math.floor((-depthRange.min / depthRange.range) * ADAPTIVE_DEPTH_BIN_COUNT),
  ));
  return {
    ...depthRange,
    requestedBits,
    bits,
    bucketCount,
    cameraBin,
    binWeights: createDepthBinWeights(cameraBin, bucketCount),
  };
}

export function adaptiveDepthToKey(depth: number, config: AdaptiveDepthKeyConfig): number {
  const finiteDepth = Number.isFinite(depth) ? depth : config.min;
  const normalizedBin = Math.max(0, Math.min(
    ADAPTIVE_DEPTH_BIN_COUNT - BIN_EPSILON,
    ((finiteDepth - config.min) / config.range) * ADAPTIVE_DEPTH_BIN_COUNT,
  ));
  const bin = Math.floor(normalizedBin);
  const base = config.binWeights[bin * 2] ?? 0;
  const divider = config.binWeights[bin * 2 + 1] ?? 1;
  return Math.min(config.bucketCount - 1, Math.floor(base + divider * (normalizedBin - bin))) >>> 0;
}

export function createAdaptiveDepthKeys(
  centers: Float32Array,
  viewMatrix: Matrix4,
  config: AdaptiveDepthKeyConfig,
): Uint32Array {
  const count = Math.floor(centers.length / 3);
  const result = new Uint32Array(count);
  const elements = viewMatrix.elements;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const viewZ = (elements[2] ?? 0) * (centers[offset] ?? 0)
      + (elements[6] ?? 0) * (centers[offset + 1] ?? 0)
      + (elements[10] ?? 0) * (centers[offset + 2] ?? 0)
      + (elements[14] ?? 0);
    result[index] = adaptiveDepthToKey(viewZ, config);
  }
  return result;
}
