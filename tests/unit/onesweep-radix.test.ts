import { readFile } from 'node:fs/promises';
import { StorageBufferAttribute } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  ONESWEEP_PARTITION_SIZE,
  OneSweepRadixSortBackend,
  oneSweepRadixAllocationBytes,
} from '../../src/render/sort/OneSweepRadixSortBackend.js';

function keys(count: number): StorageBufferAttribute {
  return new StorageBufferAttribute(
    Uint32Array.from({ length: Math.max(1, count) }, (_, index) => (index * 2654435761) >>> 0),
    1,
  );
}

describe('OneSweepRadixSortBackend', () => {
  it.each([
    [0, 16, 4_120],
    [1, 16, 4_120],
    [ONESWEEP_PARTITION_SIZE, 16, 65_544],
    [ONESWEEP_PARTITION_SIZE + 1, 16, 67_608],
    [195_099, 16, 3_228_088],
    [195_099, 24, 3_281_340],
  ])('accounts for owned storage at %s elements and %s bits', (count, bits, expected) => {
    expect(oneSweepRadixAllocationBytes(count, bits)).toBe(expected);
  });

  it('schedules reset, all-pass histogram, scan, and fused ping-pong passes', async () => {
    const input = keys(ONESWEEP_PARTITION_SIZE + 1);
    const sorter = new OneSweepRadixSortBackend(ONESWEEP_PARTITION_SIZE + 1, input, 16, 32);
    expect(sorter.kind).toBe('onesweep');
    expect(sorter.radixBits).toBe(8);
    expect(sorter.computeNodes.map((node) => node.name)).toEqual([
      'SOG OneSweep scratch reset',
      'SOG OneSweep all-pass global histogram',
      'SOG OneSweep exclusive digit-base scan',
      'SOG OneSweep fused binning pass 0',
      'SOG OneSweep fused binning pass 1',
    ]);
    expect(sorter.orderAttribute.count).toBe(ONESWEEP_PARTITION_SIZE + 1);
    const compute = vi.fn();
    const computeAsync = vi.fn().mockResolvedValue(undefined);
    const renderer = { compute, computeAsync } as unknown as WebGPURenderer;
    sorter.sort(renderer);
    await sorter.sortAsync(renderer);
    expect(compute).toHaveBeenCalledWith(sorter.computeNodes);
    expect(computeAsync).toHaveBeenCalledWith(sorter.computeNodes);
    sorter.dispose();
    sorter.dispose();
    input.dispose();
  });

  it('retains subgroup ranking, chained lookback, and coalesced staging in source', async () => {
    const source = await readFile(
      new URL('../../src/render/sort/OneSweepRadixSortBackend.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/subgroupBallot/);
    expect(source).toMatch(/subgroupShuffle/);
    expect(source).toMatch(/subgroupExclusiveAdd/);
    expect(source).toMatch(/atomicLoad\(passHistogram/);
    expect(source).toMatch(/Loop as any\)\(done\.not\(\)/);
    expect(source).toMatch(/scratch\.element\(offsets\.element/);
    expect(source).toMatch(/digitBase\.element\(digit\)\.add\(linearIndex\)/);
  });

  it('does not dispatch empty input and rejects unsafe subgroup or bit configurations', () => {
    const input = keys(0);
    const sorter = new OneSweepRadixSortBackend(0, input, 16, 32);
    const renderer = { compute: vi.fn(), computeAsync: vi.fn() } as unknown as WebGPURenderer;
    sorter.sort(renderer);
    expect(renderer.compute).not.toHaveBeenCalled();
    expect(() => new OneSweepRadixSortBackend(0, input, 12, 32)).toThrow(RangeError);
    expect(() => new OneSweepRadixSortBackend(0, input, 16, 64)).toThrow(RangeError);
    expect(() => new OneSweepRadixSortBackend(2, input, 16, 32)).toThrow(RangeError);
    sorter.dispose();
    input.dispose();
  });
});
