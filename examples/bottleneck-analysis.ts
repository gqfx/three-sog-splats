export interface BottleneckScenario {
  readonly id: string;
  readonly label: string;
  readonly instanceCount: number;
  readonly pixelRatio: number;
  readonly modelScale: number;
  readonly sampleCount: number;
  readonly gpuRenderMedianMs: number | null;
  readonly gpuRenderP95Ms: number | null;
  readonly cpuSubmitMedianMs: number;
  readonly cpuSubmitP95Ms: number;
  readonly gpuCompletionMedianMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly vertexInvocations: number;
}

export interface BottleneckSortMeasurement {
  readonly sampleCount: number;
  readonly gpuComputeMedianMs: number | null;
  readonly gpuComputeP95Ms: number | null;
  readonly cpuSubmitMedianMs: number;
  readonly computePasses: number;
}

export interface BottleneckFinding {
  readonly stage:
    | 'per-instance-vertex-and-attribute-decode'
    | 'fragment-blending-and-overdraw'
    | 'radix-sort-while-moving'
    | 'fixed-render-overhead'
    | 'cpu-command-submission';
  readonly impactMs: number;
  readonly conditional: boolean;
  readonly evidence: string;
}

export interface BottleneckAnalysis {
  readonly source: string;
  readonly backend: string | null;
  readonly splatCount: number;
  readonly sourceSplatCount: number;
  readonly runtimeCopyCount: number;
  readonly timestampSupported: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
  };
  readonly scenarios: readonly BottleneckScenario[];
  readonly sort: BottleneckSortMeasurement | null;
  readonly findings: readonly BottleneckFinding[];
  readonly summary: string;
  readonly notes: readonly string[];
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function scenario(
  scenarios: readonly BottleneckScenario[],
  id: string,
): BottleneckScenario | undefined {
  return scenarios.find((candidate) => candidate.id === id);
}

export function deriveBottleneckFindings(
  scenarios: readonly BottleneckScenario[],
  sort: BottleneckSortMeasurement | null,
): { findings: BottleneckFinding[]; summary: string } {
  const empty = scenario(scenarios, 'empty');
  const full = scenario(scenarios, 'full');
  const halfResolution = scenario(scenarios, 'half-resolution');
  const quarterResolution = scenario(scenarios, 'quarter-resolution');
  const quarterScale = scenario(scenarios, 'quarter-scale');
  if (!empty || !full) {
    return {
      findings: [],
      summary: 'The controlled analysis did not produce the required empty and full-scene probes.',
    };
  }

  const findings: BottleneckFinding[] = [];
  const fullGpu = full.gpuRenderMedianMs ?? full.gpuCompletionMedianMs;
  const emptyGpu = empty.gpuRenderMedianMs ?? empty.gpuCompletionMedianMs;
  if (fullGpu >= 0 && emptyGpu >= 0) {
    const halfGpu = halfResolution?.gpuRenderMedianMs
      ?? halfResolution?.gpuCompletionMedianMs
      ?? fullGpu;
    const quarterGpu = quarterResolution?.gpuRenderMedianMs
      ?? quarterResolution?.gpuCompletionMedianMs
      ?? halfGpu;
    const smallGpu = quarterScale?.gpuRenderMedianMs
      ?? quarterScale?.gpuCompletionMedianMs
      ?? fullGpu;
    const fixedGpu = Math.max(0, emptyGpu);
    const resolutionSamples = [
      { pixelArea: 1, gpuMs: fullGpu },
      ...(halfResolution ? [{
        pixelArea: (halfResolution.pixelRatio / full.pixelRatio) ** 2,
        gpuMs: halfGpu,
      }] : []),
      ...(quarterResolution ? [{
        pixelArea: (quarterResolution.pixelRatio / full.pixelRatio) ** 2,
        gpuMs: quarterGpu,
      }] : []),
    ];
    const meanPixelArea = resolutionSamples.reduce(
      (sum, sample) => sum + sample.pixelArea,
      0,
    ) / resolutionSamples.length;
    const meanGpuMs = resolutionSamples.reduce(
      (sum, sample) => sum + sample.gpuMs,
      0,
    ) / resolutionSamples.length;
    const covariance = resolutionSamples.reduce(
      (sum, sample) => sum + (sample.pixelArea - meanPixelArea) * (sample.gpuMs - meanGpuMs),
      0,
    );
    const variance = resolutionSamples.reduce(
      (sum, sample) => sum + (sample.pixelArea - meanPixelArea) ** 2,
      0,
    );
    const fragmentImpact = Math.max(0, variance > 0 ? covariance / variance : 0);
    const resolutionIndependentGpu = meanGpuMs - fragmentImpact * meanPixelArea;
    const perInstanceImpact = Math.max(0, resolutionIndependentGpu - fixedGpu);
    const halfRatio = fullGpu > 0 ? halfGpu / fullGpu : 1;
    const scaleRatio = fullGpu > 0 ? smallGpu / fullGpu : 1;
    const singleSidedTriangles = full.instanceCount * 2;
    const passMultiplier = singleSidedTriangles > 0
      ? full.triangles / singleSidedTriangles
      : 0;

    findings.push({
      stage: 'per-instance-vertex-and-attribute-decode',
      impactMs: rounded(perInstanceImpact),
      conditional: false,
      evidence: `${full.instanceCount.toLocaleString()} splats produced ${full.triangles.toLocaleString()} triangles (~${rounded(passMultiplier)}x the single-sided count) and about ${full.vertexInvocations.toLocaleString()} vertex shader invocations. The resolution model estimates ${rounded(perInstanceImpact)} ms of pixel-count-independent work; GPU render remained ${rounded(scaleRatio * 100)}% at quarter model scale.`,
    });
    findings.push({
      stage: 'fragment-blending-and-overdraw',
      impactMs: rounded(fragmentImpact),
      conditional: false,
      evidence: `GPU render changed from ${rounded(fullGpu)} ms at full DPR to ${rounded(halfGpu)} ms at half DPR${quarterResolution ? ` and ${rounded(quarterGpu)} ms at quarter DPR` : ''}. A linear pixel-area model attributes about ${rounded(fragmentImpact)} ms of the full-resolution frame to pixel-scaled fragment/blending work (half-DPR ratio ${rounded(halfRatio * 100)}%).`,
    });
    findings.push({
      stage: 'fixed-render-overhead',
      impactMs: rounded(fixedGpu),
      conditional: false,
      evidence: `The empty scene render pass took ${rounded(emptyGpu)} ms (${empty.gpuRenderMedianMs === null ? 'GPU-completion proxy' : 'GPU timestamp'}).`,
    });
  }

  findings.push({
    stage: 'cpu-command-submission',
    impactMs: rounded(full.cpuSubmitMedianMs),
    conditional: false,
    evidence: `Submitting the full-scene frame took ${rounded(full.cpuSubmitMedianMs)} ms on the CPU, excluding GPU execution.`,
  });

  if (sort?.gpuComputeMedianMs !== null && sort?.gpuComputeMedianMs !== undefined) {
    findings.push({
      stage: 'radix-sort-while-moving',
      impactMs: rounded(sort.gpuComputeMedianMs),
      conditional: true,
      evidence: `A camera change added ${rounded(sort.gpuComputeMedianMs)} ms median GPU compute across ${sort.computePasses} compute passes; stationary frames do not run the sort.`,
    });
  }

  findings.sort((left, right) => right.impactMs - left.impactMs);
  const primary = findings.find((finding) => !finding.conditional && finding.impactMs > 0)
    ?? findings[0];
  const movingSort = findings.find((finding) => finding.stage === 'radix-sort-while-moving');
  const summary = primary
    ? `Primary stationary bottleneck: ${primary.stage} (~${primary.impactMs} ms proxy impact).${movingSort ? ` Camera motion additionally runs radix sort (~${movingSort.impactMs} ms GPU compute).` : ''}`
    : 'No dominant stage could be derived from the available timing samples.';

  return { findings, summary };
}
