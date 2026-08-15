import { Matrix4 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createDepthKeys, floatToOrderedUint } from '../../src/render/sort/depth.js';
import { radixSortIndices } from '../../src/render/sort/radix.js';
import { nextSortCapacity } from '../../src/render/sort/PortableGpuRadixSorter.js';

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

  it('generates back-to-front camera-depth keys', () => {
    const centers = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -2]);
    const keys = createDepthKeys(centers, new Matrix4());
    expect([...radixSortIndices(keys)]).toEqual([1, 2, 0]);
  });

  it.each([
    [0, 1],
    [1, 1],
    [3, 4],
    [256, 256],
    [257, 512],
    [2_000_000, 2_097_152],
  ])('grows reusable GPU sort capacity from %s to %s', (count, expected) => {
    expect(nextSortCapacity(count)).toBe(expected);
  });
});
