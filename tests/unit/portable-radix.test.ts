import { StorageBufferAttribute } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  PORTABLE_KEYS_PER_WORKGROUP,
  PortableRadixSortBackend,
  portableRadixAllocationBytes,
} from '../../src/render/sort/PortableRadixSortBackend.js';

function keys(count: number): StorageBufferAttribute {
  return new StorageBufferAttribute(
    Uint32Array.from({ length: Math.max(1, count) }, (_, index) => (index * 2654435761) >>> 0),
    1,
  );
}

describe('PortableRadixSortBackend', () => {
  it.each([
    [0, 80],
    [1, 80],
    [PORTABLE_KEYS_PER_WORKGROUP, 32_832],
    [PORTABLE_KEYS_PER_WORKGROUP + 1, 32_912],
    [PORTABLE_KEYS_PER_WORKGROUP * 256, 8_405_056],
    [PORTABLE_KEYS_PER_WORKGROUP * 256 + 1, 8_405_140],
    [2_000_000, 32_062_776],
  ])('accounts for owned storage at %s elements', (count, expected) => {
    expect(portableRadixAllocationBytes(count)).toBe(expected);
  });

  it('schedules histogram, scan, and scatter passes with ping-pong output ownership', async () => {
    const input = keys(PORTABLE_KEYS_PER_WORKGROUP + 1);
    const sorter = new PortableRadixSortBackend(PORTABLE_KEYS_PER_WORKGROUP + 1, input, 12);
    expect(sorter.kind).toBe('portable');
    expect(sorter.radixBits).toBe(4);
    expect(sorter.computeNodes).toHaveLength(9);
    expect(sorter.orderAttribute.count).toBe(PORTABLE_KEYS_PER_WORKGROUP + 1);
    expect(sorter.allocatedBytes).toBe(portableRadixAllocationBytes(PORTABLE_KEYS_PER_WORKGROUP + 1));
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

  it('builds another hierarchical scan level beyond 256 radix workgroups', () => {
    const count = PORTABLE_KEYS_PER_WORKGROUP * 256 + 1;
    const input = keys(count);
    const sorter = new PortableRadixSortBackend(count, input, 4);
    expect(sorter.computeNodes.map((node) => node.name)).toEqual([
      'SOG Portable histogram bits 0-3',
      'SOG Portable Blelloch scan level 0',
      'SOG Portable Blelloch scan level 1',
      'SOG Portable scan prefix add level 0',
      'SOG Portable stable scatter bits 0-3',
    ]);
    sorter.dispose();
    input.dispose();
  });

  it('does not dispatch for empty input and validates capacities and bit widths', () => {
    const input = keys(0);
    const sorter = new PortableRadixSortBackend(0, input, 12);
    expect(sorter.computeNodes).toHaveLength(0);
    const renderer = { compute: vi.fn(), computeAsync: vi.fn() } as unknown as WebGPURenderer;
    sorter.sort(renderer);
    expect(renderer.compute).not.toHaveBeenCalled();
    expect(() => new PortableRadixSortBackend(2, input, 12)).toThrow(RangeError);
    expect(() => new PortableRadixSortBackend(0, input, 10)).toThrow(RangeError);
    sorter.dispose();
    input.dispose();
  });
});
