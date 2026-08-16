import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTRIBUTION_CULL_THRESHOLD,
  DEFAULT_SPLAT_ALPHA_CUTOFF,
  classifyProjectedSplat,
  projectedSplatContribution,
  stableCompactVisibleIndices,
} from '../../src/render/contribution.js';

const visibleFixture = {
  opacity: 1,
  clipW: 1,
  centerNdcX: 0,
  centerNdcY: 0,
  extentNdcX: 0.1,
  extentNdcY: 0.1,
  covarianceDeterminantPixels: 1,
} as const;

describe('projected splat contribution culling', () => {
  it('uses opacity times 2π times the projected covariance area', () => {
    expect(projectedSplatContribution(0.5, 4)).toBeCloseTo(2 * Math.PI);
    expect(projectedSplatContribution(1, -1)).toBe(0);
  });

  it('keeps the exact contribution threshold and rejects values below it', () => {
    const determinantAtThreshold = (
      DEFAULT_CONTRIBUTION_CULL_THRESHOLD / (2 * Math.PI)
    ) ** 2;
    expect(classifyProjectedSplat({
      ...visibleFixture,
      covarianceDeterminantPixels: determinantAtThreshold,
    })).toBe('visible');
    expect(classifyProjectedSplat({
      ...visibleFixture,
      covarianceDeterminantPixels: determinantAtThreshold * 0.999,
    })).toBe('low-contribution');
  });

  it('classifies center-alpha, camera, and conservative ellipse-frustum rejection', () => {
    expect(classifyProjectedSplat({
      ...visibleFixture,
      opacity: DEFAULT_SPLAT_ALPHA_CUTOFF * 0.99,
    })).toBe('behind-or-alpha');
    expect(classifyProjectedSplat({ ...visibleFixture, clipW: 0 })).toBe('behind-or-alpha');
    expect(classifyProjectedSplat({
      ...visibleFixture,
      centerNdcX: 1.2,
      extentNdcX: 0.19,
    })).toBe('outside-frustum');
    expect(classifyProjectedSplat({
      ...visibleFixture,
      centerNdcX: 1.2,
      extentNdcX: 0.2,
    })).toBe('visible');
  });

  it('disables every rejection for an exact A/B baseline', () => {
    expect(classifyProjectedSplat({
      ...visibleFixture,
      clipW: -1,
      opacity: 0,
      covarianceDeterminantPixels: 0,
    }, DEFAULT_CONTRIBUTION_CULL_THRESHOLD, false)).toBe('visible');
  });

  it('compacts visible indices as a stable subsequence', () => {
    expect(stableCompactVisibleIndices([
      'low-contribution',
      'visible',
      'outside-frustum',
      'visible',
      'behind-or-alpha',
    ])).toEqual([1, 3]);
  });
});
