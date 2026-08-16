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
