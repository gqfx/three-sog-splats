export const DEFAULT_CONTRIBUTION_CULL_THRESHOLD = 1;
export const DEFAULT_SPLAT_ALPHA_CUTOFF = 1 / 255;

export type SOGContributionCullReason =
  | 'visible'
  | 'behind-or-alpha'
  | 'outside-frustum'
  | 'low-contribution';

export interface ProjectedSplatContribution {
  readonly opacity: number;
  readonly clipW: number;
  readonly centerNdcX: number;
  readonly centerNdcY: number;
  readonly extentNdcX: number;
  readonly extentNdcY: number;
  readonly covarianceDeterminantPixels: number;
}

/**
 * Matches the opacity-weighted projected covariance-area metric used by the
 * PlayCanvas GPU-sort gsplat projector.
 */
export function projectedSplatContribution(
  opacity: number,
  covarianceDeterminantPixels: number,
): number {
  return opacity * 2 * Math.PI * Math.sqrt(Math.max(0, covarianceDeterminantPixels));
}

export function classifyProjectedSplat(
  splat: ProjectedSplatContribution,
  threshold = DEFAULT_CONTRIBUTION_CULL_THRESHOLD,
  enabled = true,
): SOGContributionCullReason {
  if (!enabled) return 'visible';
  if (splat.clipW <= 0 || splat.opacity < DEFAULT_SPLAT_ALPHA_CUTOFF) {
    return 'behind-or-alpha';
  }
  if (
    splat.centerNdcX + splat.extentNdcX < -1
    || splat.centerNdcX - splat.extentNdcX > 1
    || splat.centerNdcY + splat.extentNdcY < -1
    || splat.centerNdcY - splat.extentNdcY > 1
  ) {
    return 'outside-frustum';
  }
  if (projectedSplatContribution(
    splat.opacity,
    splat.covarianceDeterminantPixels,
  ) < threshold) {
    return 'low-contribution';
  }
  return 'visible';
}

export function stableCompactVisibleIndices(
  reasons: readonly SOGContributionCullReason[],
): number[] {
  const visible: number[] = [];
  for (let index = 0; index < reasons.length; index += 1) {
    if (reasons[index] === 'visible') visible.push(index);
  }
  return visible;
}
