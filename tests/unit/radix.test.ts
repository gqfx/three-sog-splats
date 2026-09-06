import { Matrix4 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  DEPTH_BUCKET_COUNT,
  createDepthBuckets,
  createDepthKeys,
  floatToDepthBucket,
  floatToOrderedUint,
  isCompleteMonotonicBucketOrder,
  orderedUintToDepthBucket,
} from '../../src/render/sort/depth.js';
import { radixSortIndices } from '../../src/render/sort/radix.js';

describe('portable radix sort oracle', () => {
  it.each([0, 1, 3, 255, 256, 257, 1023])('sorts a %s-element non/power-of-two input stably', (count) => {
    const keys = Uint32Array.from({ length: count }, (_, index) => ((index * 2654435761) % 17) >>> 0);
    const order = radixSortIndices(keys);
    const actual = [...order].map((index) => [keys[index], index]);
    const expected = [...keys].map((key, index) => [key, index]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    expect(actual).toEqual(expected);
  });

  it('maps IEEE floats into monotonically ordered unsigned keys', () => {
    const values = [-Infinity, -100, -0, 0, 1, 100, Infinity];
    expect(values.map(floatToOrderedUint)).toEqual([...values].sort((a, b) => a - b).map(floatToOrderedUint));
  });

  it('maps IEEE float extremes and signed values into monotonic 16-bit buckets', () => {
    const values = [-Infinity, -Number.MAX_VALUE, -100, -0, 0, 1, 100, Number.MAX_VALUE, Infinity];
    const buckets = values.map(floatToDepthBucket);
    expect(buckets).toEqual([...buckets].sort((left, right) => left - right));
    expect(buckets.every((bucket) => bucket >= 0 && bucket < DEPTH_BUCKET_COUNT)).toBe(true);
    expect(orderedUintToDepthBucket(0)).toBe(0);
    expect(orderedUintToDepthBucket(0xffff_ffff)).toBe(DEPTH_BUCKET_COUNT - 1);
  });

  it('generates back-to-front camera-depth keys', () => {
    const centers = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -2]);
    const keys = createDepthKeys(centers, new Matrix4());
    expect([...radixSortIndices(keys)]).toEqual([1, 2, 0]);
  });

  it('generates back-to-front camera-depth buckets', () => {
    const centers = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -2]);
    const buckets = createDepthBuckets(centers, new Matrix4());
    const order = Uint32Array.from([1, 2, 0]);
    expect(isCompleteMonotonicBucketOrder(buckets, order)).toBe(true);
  });

  it('accepts arbitrary order inside equal-depth buckets', () => {
    const bucket = floatToDepthBucket(-2);
    const buckets = Uint32Array.from([bucket, bucket, bucket, bucket]);
    expect(isCompleteMonotonicBucketOrder(buckets, Uint32Array.from([3, 1, 0, 2]))).toBe(true);
  });

  it.each([
    Uint32Array.from([0, 0, 2]),
    Uint32Array.from([0, 1]),
    Uint32Array.from([0, 1, 3]),
  ])('rejects an incomplete or invalid permutation', (order) => {
    const buckets = Uint32Array.from([1, 2, 3]);
    expect(isCompleteMonotonicBucketOrder(buckets, order)).toBe(false);
  });

  it('validates a complete order for a two-million-splat large model', () => {
    const count = 2_000_000;
    const buckets = Uint32Array.from({ length: count }, (_, index) => Math.floor(index / 32));
    const order = Uint32Array.from({ length: count }, (_, index) => index);
    expect(isCompleteMonotonicBucketOrder(buckets, order)).toBe(true);
  });

});

it('reuses scratch storage without corrupting subsequent depth sorts', async () => {
  const { RadixSortWorkspace, radixSortKeyValues } = await import('../../src/render/sort/radix.js');
  const workspace = new RadixSortWorkspace(4);
  for (const values of [[9, 1, 3, 3], [0, 0xffffffff, 4, 2], [3, 3, 3, 3]]) {
    workspace.readKeys.set(values);
    const result = radixSortKeyValues(workspace.readKeys, undefined, 32, 8, workspace);
    expect([...result.values]).toEqual(values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!));
    expect(result.keys.buffer).toBe(workspace.readKeys.buffer);
  }
});
