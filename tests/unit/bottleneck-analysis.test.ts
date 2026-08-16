import { describe, expect, it } from 'vitest';
import {
  deriveBottleneckFindings,
  type BottleneckScenario,
  type BottleneckCameraUpdateMeasurement,
} from '../../examples/bottleneck-analysis.js';

function probe(
  id: string,
  gpuRenderMedianMs: number,
  overrides: Partial<BottleneckScenario> = {},
): BottleneckScenario {
  return {
    id,
    label: id,
    instanceCount: id === 'empty' ? 0 : 5_000_000,
    pixelRatio: id === 'half-resolution' ? 1 : 2,
    modelScale: id === 'quarter-scale' ? 0.25 : 1,
    sampleCount: 5,
    gpuRenderMedianMs,
    gpuRenderP95Ms: gpuRenderMedianMs,
    cpuSubmitMedianMs: 0.5,
    cpuSubmitP95Ms: 0.6,
    gpuCompletionMedianMs: gpuRenderMedianMs + 0.3,
    drawCalls: id === 'empty' ? 0 : 1,
    triangles: id === 'empty' ? 0 : 10_000_000,
    vertexInvocations: id === 'empty' ? 0 : 30_000_000,
    ...overrides,
  };
}

describe('deriveBottleneckFindings', () => {
  it('attributes pixel-insensitive GPU time to per-instance work', () => {
    const scenarios = [
      probe('empty', 0.4),
      probe('full', 180),
      probe('half-resolution', 168),
      probe('quarter-scale', 160),
    ];
    const result = deriveBottleneckFindings(scenarios, null);

    expect(result.findings[0]?.stage).toBe('cached-screen-space-fetch');
    expect(result.findings[0]?.impactMs).toBe(163.6);
    expect(result.summary).toContain('Primary stationary bottleneck');
  });

  it('surfaces fragment work when pixel reductions materially lower GPU time', () => {
    const scenarios = [
      probe('empty', 0.4),
      probe('full', 180),
      probe('half-resolution', 65),
      probe('quarter-scale', 42),
    ];
    const result = deriveBottleneckFindings(scenarios, null);

    expect(result.findings[0]?.stage).toBe('fragment-blending-and-overdraw');
    expect(result.findings[0]?.impactMs).toBe(153.3);
  });

  it('keeps radix sorting conditional on camera movement', () => {
    const cameraUpdate: BottleneckCameraUpdateMeasurement = {
      sampleCount: 3,
      gpuComputeMedianMs: 90,
      gpuComputeP95Ms: 100,
      cpuSubmitMedianMs: 0.2,
      computePasses: 32,
      includesProjectionRefresh: true,
    };
    const result = deriveBottleneckFindings([
      probe('empty', 0.4),
      probe('full', 20),
      probe('half-resolution', 18),
      probe('quarter-scale', 17),
    ], cameraUpdate);

    expect(result.findings[0]).toMatchObject({
      stage: 'camera-change-sort-and-projection',
      conditional: true,
      impactMs: 90,
    });
    expect(result.summary).toContain('Camera motion additionally refreshes sort/projection caches');
  });

  it('reports the measured contribution-culling A/B saving', () => {
    const result = deriveBottleneckFindings([
      probe('empty', 0.4),
      probe('full', 8, { cullingSubmitted: 5_000_000, cullingVisible: 400_000 }),
      probe('full-no-contribution-culling', 110),
    ], null);

    expect(result.findings).toContainEqual(expect.objectContaining({
      stage: 'contribution-culling',
      impactMs: 102,
    }));
    expect(result.summary).toContain('Contribution culling saves ~102 ms');
  });

  it('falls back to completion latency when the empty-pass timestamp is invalid', () => {
    const result = deriveBottleneckFindings([
      probe('empty', 0.4, { gpuRenderMedianMs: null, gpuCompletionMedianMs: 2.5 }),
      probe('full', 180),
      probe('half-resolution', 100),
      probe('quarter-scale', 120),
    ], null);

    expect(result.findings.some((finding) => (
      finding.stage === 'fixed-render-overhead' && finding.impactMs === 2.5
    ))).toBe(true);
  });
});
