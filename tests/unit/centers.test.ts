import { describe, expect, it } from 'vitest';
import { unpackWebGLCenterReadback } from '../../src/render/centers.js';

describe('WebGL center readback', () => {
  it('restores top-to-bottom SOG indices from bottom-to-top framebuffer rows', () => {
    const bottomToTopRgba = new Float32Array([
      20, 21, 22, 1,
      30, 31, 32, 1,
      0, 1, 2, 1,
      10, 11, 12, 1,
    ]);
    expect([...unpackWebGLCenterReadback(bottomToTopRgba, 2, 2, 4)]).toEqual([
      0, 1, 2,
      10, 11, 12,
      20, 21, 22,
      30, 31, 32,
    ]);
  });

  it('does not expose padded texels from the final source row', () => {
    const bottomToTopRgba = new Float32Array([
      20, 21, 22, 1,
      999, 999, 999, 1,
      0, 1, 2, 1,
      10, 11, 12, 1,
    ]);
    expect([...unpackWebGLCenterReadback(bottomToTopRgba, 2, 2, 3)]).toEqual([
      0, 1, 2,
      10, 11, 12,
      20, 21, 22,
    ]);
  });
});

it('restores the current render target before awaiting center readback', async () => {
  const { getCachedCenters } = await import('../../src/render/centers.js');
  const { Texture, RenderTarget } = await import('three/webgpu');
  const { validMeta } = await import('../helpers/fixture-builder.js');
  let target: any = null;
  let finishCompile!: () => void;
  let finishReadback!: (pixels: Float32Array) => void;
  const renderer: any = {
    getRenderTarget: () => target, setRenderTarget: (value: unknown) => { target = value; },
    initRenderTarget() {}, render() {},
    compileAsync: () => new Promise<void>((resolve) => { finishCompile = resolve; }),
    readRenderTargetPixelsAsync: () => new Promise<Float32Array>((resolve) => { finishReadback = resolve; }),
  };
  const low = new Texture(); const high = new Texture();
  const pending = getCachedCenters({}, renderer, { meansLow: low, meansHigh: high, width: 2, height: 2 }, validMeta);
  const applicationTarget = new RenderTarget(2, 2);
  target = applicationTarget;
  finishCompile(); await Promise.resolve();
  expect(target).toBe(applicationTarget);
  // The app can render or change targets while GPU readback is pending.
  target = null;
  finishReadback(new Float32Array(16)); await pending;
  expect(target).toBeNull();
  low.dispose(); high.dispose(); applicationTarget.dispose();
});
