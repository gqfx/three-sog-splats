import {
  Box3,
  Matrix4,
  Texture,
  Vector3,
} from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { GpuRadixSorter } from '../../src/render/sort/GpuRadixSorter.js';

const textures = {
  meansLow: new Texture(),
  meansHigh: new Texture(),
  width: 4,
};
const mins = new Vector3(-1, -1, -1);
const maxs = new Vector3(1, 1, 1);
const bounds = new Box3(mins, maxs);

function renderer() {
  const compute = vi.fn();
  const computeAsync = vi.fn().mockResolvedValue(undefined);
  return {
    compute,
    computeAsync,
  } as unknown as WebGPURenderer;
}

describe('GpuRadixSorter', () => {
  it('generates adaptive keys before every Portable radix pass sequence', async () => {
    const target = renderer();
    const sorter = await GpuRadixSorter.create(
      target,
      4,
      textures,
      mins,
      maxs,
      bounds,
      {
        hasSubgroups: () => false,
        hasCustomDevice: () => false,
        resolveAdapterInfo: async () => ({ info: null, identityCorrelated: false }),
      },
    );
    expect(sorter.kind).toBe('portable');
    expect(sorter.radixBits).toBe(4);
    expect(sorter.requestedBits).toBe(10);
    expect(sorter.bits).toBe(12);
    expect(sorter.selectionReason).toBe('subgroups-unavailable');
    expect(sorter.computeNodes[0]?.name).toBe('SOG adaptive depth-key generation');
    expect(sorter.computeNodes).toHaveLength(10);
    expect(sorter.orderAttribute.count).toBe(4);
    expect(sorter.allocatedBytes).toBeGreaterThan(4 * Uint32Array.BYTES_PER_ELEMENT);

    sorter.updateViewMatrix(new Matrix4().makeTranslation(0, 0, -0.01));
    sorter.sort(target);
    await sorter.sortAsync(target);
    expect(target.compute).toHaveBeenCalledWith(sorter.computeNodes);
    expect(target.computeAsync).toHaveBeenCalledWith(sorter.computeNodes);
    expect(() => {
      sorter.dispose();
      sorter.dispose();
    }).not.toThrow();
  });

  it('rounds adaptive precision to 8 bits and creates OneSweep only through admission', async () => {
    const sorter = await GpuRadixSorter.create(
      renderer(),
      4_000,
      { ...textures, width: 64 },
      mins,
      maxs,
      bounds,
      {
        hasSubgroups: () => true,
        hasCustomDevice: () => false,
        resolveAdapterInfo: async () => ({
          info: { vendor: 'nvidia', subgroupMinSize: 32, subgroupMaxSize: 32 },
          identityCorrelated: true,
        }),
      },
    );
    expect(sorter.kind).toBe('onesweep');
    expect(sorter.requestedBits).toBe(10);
    expect(sorter.bits).toBe(16);
    expect(sorter.computeNodes[0]?.name).toBe('SOG adaptive depth-key generation');
    expect(sorter.computeNodes).toHaveLength(6);
    sorter.dispose();
  });

  it('keeps empty inputs allocation-safe and dispatch-free', async () => {
    const target = renderer();
    const sorter = await GpuRadixSorter.create(
      target,
      0,
      textures,
      mins,
      maxs,
      bounds,
      {
        hasSubgroups: () => false,
        hasCustomDevice: () => false,
        resolveAdapterInfo: async () => ({ info: null, identityCorrelated: false }),
      },
    );
    expect(sorter.computeNodes).toEqual([]);
    sorter.sort(target);
    await sorter.sortAsync(target);
    expect(target.compute).not.toHaveBeenCalled();
    expect(target.computeAsync).not.toHaveBeenCalled();
    sorter.dispose();
  });
});
