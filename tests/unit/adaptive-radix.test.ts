import { Box3, Matrix4, Vector3 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  adaptiveDepthToKey,
  cameraRelativeDepthRange,
  createAdaptiveDepthKeyConfig,
  createAdaptiveDepthKeys,
  createDepthBinWeights,
  requestedAdaptiveDepthBits,
  roundRadixBits,
  sanitizeDepthRange,
} from '../../src/render/sort/adaptive.js';
import { radixSortKeyValues } from '../../src/render/sort/radix.js';
import { evaluateRadixAdmission, selectRadixBackend } from '../../src/render/sort/selection.js';

describe('adaptive radix reference behavior', () => {
  it.each([
    [0, 10],
    [4_096, 10],
    [65_536, 14],
    [116_374, 15],
    [195_099, 16],
    [2_000_000, 19],
    [5_000_000, 20],
    [Number.MAX_SAFE_INTEGER, 20],
  ])('requests adaptive precision for %s splats', (count, expected) => {
    expect(requestedAdaptiveDepthBits(count)).toBe(expected);
  });

  it('rounds requested precision to each backend radix width', () => {
    expect(roundRadixBits(10, 4)).toBe(12);
    expect(roundRadixBits(15, 4)).toBe(16);
    expect(roundRadixBits(20, 4)).toBe(20);
    expect(roundRadixBits(10, 8)).toBe(16);
    expect(roundRadixBits(20, 8)).toBe(24);
    expect(() => roundRadixBits(33, 4)).toThrow(RangeError);
  });

  it('uses deterministic fallback ranges for degenerate and non-finite bounds', () => {
    expect(sanitizeDepthRange(2, 2)).toEqual({ min: 1.5, max: 2.5, range: 1 });
    expect(sanitizeDepthRange(Infinity, 3)).toEqual({ min: -0.5, max: 0.5, range: 1 });
    expect(sanitizeDepthRange(4, -2)).toEqual({ min: -2, max: 4, range: 6 });
    const invalidBounds = new Box3(
      new Vector3(Infinity, 0, 0),
      new Vector3(Infinity, 0, 0),
    );
    expect(cameraRelativeDepthRange(invalidBounds, new Matrix4())).toEqual({
      min: -0.5,
      max: 0.5,
      range: 1,
    });
  });

  it('allocates more key intervals near the camera bin', () => {
    const weights = createDepthBinWeights(16, 65_536);
    const divider = (bin: number) => weights[bin * 2 + 1] ?? 0;
    expect(divider(16)).toBeGreaterThan(divider(15));
    expect(divider(15)).toBeGreaterThan(divider(12));
    expect(divider(12)).toBeGreaterThan(divider(8));
    expect(divider(8)).toBeGreaterThan(divider(0));
  });

  it('generates monotonic, camera-relative back-to-front keys', () => {
    const config = createAdaptiveDepthKeyConfig(4, 4, -10, -1);
    const centers = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -2, 0, 0, -2]);
    const keys = createAdaptiveDepthKeys(centers, new Matrix4(), config);
    expect(keys[1]).toBeLessThan(keys[2]!);
    expect(keys[2]).toBeLessThan(keys[0]!);
    expect(keys[2]).toBe(keys[3]);
    expect(adaptiveDepthToKey(NaN, config)).toBe(0);
  });

  it('sorts duplicate keys and caller values stably with either radix width', () => {
    const keys = Uint32Array.from([7, 1, 7, 3, 1, 7]);
    const values = Uint32Array.from([40, 41, 42, 43, 44, 45]);
    for (const radixBits of [4, 8] as const) {
      const sorted = radixSortKeyValues(keys, values, 8, radixBits);
      expect([...sorted.keys]).toEqual([1, 1, 3, 7, 7, 7]);
      expect([...sorted.values]).toEqual([41, 44, 43, 40, 42, 45]);
    }
  });
});

describe('conservative radix backend admission', () => {
  const admitted = {
    hasSubgroups: true,
    customDevice: false,
    adapterInfo: { vendor: 'nvidia', subgroupMinSize: 32 },
    identityCorrelated: true,
  } as const;

  it('admits only a correlated NVIDIA adapter with compatible subgroups', () => {
    expect(evaluateRadixAdmission(admitted)).toMatchObject({
      kind: 'onesweep',
      reason: 'validated-nvidia-subgroups',
    });
  });

  it.each([
    [{ ...admitted, hasSubgroups: false }, 'subgroups-unavailable'],
    [{ ...admitted, customDevice: true }, 'custom-device'],
    [{ ...admitted, adapterInfo: null }, 'adapter-unavailable'],
    [{ ...admitted, identityCorrelated: false }, 'adapter-identity-ambiguous'],
    [{ ...admitted, adapterInfo: { vendor: 'apple', subgroupMinSize: 32 } }, 'unsupported-vendor'],
    [{ ...admitted, adapterInfo: { vendor: 'nvidia' } }, 'subgroup-size-unavailable'],
    [{ ...admitted, adapterInfo: { vendor: 'nvidia', subgroupMinSize: 64 } }, 'subgroup-size-too-large'],
  ] as const)('falls back to Portable for unsafe signal sets', (signals, reason) => {
    expect(evaluateRadixAdmission(signals)).toMatchObject({ kind: 'portable', reason });
  });

  it('supports deterministic dependency injection without an unsafe public switch', async () => {
    const renderer = {} as WebGPURenderer;
    await expect(selectRadixBackend(renderer, {
      hasSubgroups: () => true,
      hasCustomDevice: () => false,
      resolveAdapterInfo: async () => ({
        info: { vendor: 'nvidia', subgroupMinSize: 32 },
        identityCorrelated: true,
      }),
    })).resolves.toMatchObject({ kind: 'onesweep' });
    await expect(selectRadixBackend(renderer, {
      hasSubgroups: () => true,
      hasCustomDevice: () => true,
      resolveAdapterInfo: async () => ({
        info: { vendor: 'nvidia', subgroupMinSize: 32 },
        identityCorrelated: true,
      }),
    })).resolves.toMatchObject({ kind: 'portable', reason: 'custom-device' });
  });
});
