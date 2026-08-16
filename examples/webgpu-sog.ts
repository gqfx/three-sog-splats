import {
  Box3,
  Color,
  DoubleSide,
  Euler,
  Group,
  MathUtils,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Sphere,
  TimestampQuery,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { Mesh } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SOGGaussianSplatMesh, SOGLoader } from '../src/index.js';
import type { SOGContributionCullingStats, SOGResource } from '../src/index.js';
import {
  deriveBottleneckFindings,
  type BottleneckAnalysis,
  type BottleneckCameraUpdateMeasurement,
  type BottleneckScenario,
} from './bottleneck-analysis.js';

type SourceKey = 'no-sh' | 'sh' | 'stress-5m' | 'lion-grid-5m';
type SOGDrawMesh = Mesh<SOGGaussianSplatMesh['geometry'], SOGGaussianSplatMesh['material']>;

interface FramePerformanceMetrics {
  readonly backend: string | null;
  readonly radixBackend: string | null;
  readonly radixBits: number;
  readonly radixSelectionReason: string | null;
  readonly activeSplatCount: number;
  readonly sourceSplatCount: number;
  readonly runtimeCopyCount: number;
  readonly fps: number;
  readonly averageFrameMs: number;
  readonly p95FrameMs: number;
  readonly maxFrameMs: number;
  readonly averageCpuSubmitMs: number;
  readonly p95CpuSubmitMs: number;
  readonly longFrameCount: number;
  readonly sampleFrames: number;
  readonly totalSortCount: number;
  readonly sortsPerSecond: number;
  readonly sortDurationMs: number;
  readonly sortDurationKind: 'cpu-command-submission' | 'worker-execution' | null;
  readonly staticDecodeDurationMs: number;
  readonly projectionWarmupDurationMs: number;
  readonly projectionRefreshDurationMs: number;
  readonly projectionRefreshCount: number;
  readonly projectedCacheEnabled: boolean;
  readonly contributionCullingEnabled: boolean;
  readonly contributionCullThreshold: number;
  readonly cullingStats: SOGContributionCullingStats | null;
  readonly gpuTimestampSupported: boolean;
  readonly latestGpuRenderMs: number | null;
  readonly latestGpuComputeMs: number | null;
  readonly gpuTimestampSampleAgeMs: number | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly computePasses: number;
  readonly rendererMemoryBytes: number;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
  };
}

interface SourceDefinition {
  readonly name: string;
  readonly url: string;
  readonly cameraDirection: Vector3;
  readonly rotation?: Euler;
  readonly scale?: number;
  readonly runtimeGrid?: {
    readonly columns: number;
    readonly rows: number;
  };
  readonly credit?: {
    readonly author: string;
    readonly authorUrl: string;
    readonly source: string;
    readonly license: string;
    readonly licenseUrl: string;
  };
}

declare global {
  interface Window {
    __THREE_SOG_EXAMPLE__: {
      state: 'initializing' | 'loading' | 'preparing' | 'ready' | 'failed' | 'disposed';
      backend: string | null;
      source: SourceKey;
      splatCount: number;
      sourceSplatCount: number;
      runtimeCopyCount: number;
      totalSortCount: number;
      performance: FramePerformanceMetrics | null;
      analysisState: 'idle' | 'running' | 'complete' | 'failed';
      analysisProgress: {
        readonly completed: number;
        readonly total: number;
        readonly stage: string;
      } | null;
      analysis: BottleneckAnalysis | null;
      cullingEnabled: boolean;
      cullingThreshold: number;
      cullingStats: SOGContributionCullingStats | null;
      motion: 'idle' | 'orbit';
      error: string | null;
      startCameraMotion(): void;
      stopCameraMotion(): void;
      resetPerformance(): void;
      setContributionCullingEnabled(enabled: boolean): void;
      setContributionCullThreshold(threshold: number): void;
      readContributionCullingStats(): Promise<SOGContributionCullingStats | null>;
      runBottleneckAnalysis(): Promise<BottleneckAnalysis>;
    };
  }
}

const sources: Record<SourceKey, SourceDefinition> = {
  'no-sh': {
    name: 'Millipede · full 116K · no SH',
    url: '/millipede.sog',
    cameraDirection: new Vector3(0, 0.4, 1),
    rotation: new Euler(Math.PI * 1.1, -Math.PI * 0.1, Math.PI * 0.15),
    credit: {
      author: 'Fabian Plum',
      authorUrl: 'https://superspl.at/user?id=scant3d',
      source: 'https://superspl.at/scene/3d5482d4',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    },
  },
  sh: {
    name: 'Lion · full 195K · SH2',
    url: '/lion.sog',
    cameraDirection: new Vector3(0, 0.2, 1),
    rotation: new Euler(Math.PI, 0, 0),
    credit: {
      author: 'Renaud',
      authorUrl: 'https://superspl.at/user?id=rohls',
      source: 'https://superspl.at/scene/56155c3f',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    },
  },
  'stress-5m': {
    name: 'Synthetic lattice · 5,000,000 · no SH',
    url: '/five-million.sog',
    cameraDirection: new Vector3(1, 0.7, 1),
  },
  'lion-grid-5m': {
    name: 'Lion grid · 25 runtime copies · 4,877,475 · SH2',
    url: '/lion.sog',
    cameraDirection: new Vector3(0, 0.2, 1),
    rotation: new Euler(Math.PI, 0, 0),
    runtimeGrid: { columns: 5, rows: 5 },
    credit: {
      author: 'Renaud',
      authorUrl: 'https://superspl.at/user?id=rohls',
      source: 'https://superspl.at/scene/56155c3f',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    },
  },
};

const parameters = new URLSearchParams(location.search);
const requestedSource = parameters.get('source');
const initialSource: SourceKey = requestedSource === 'sh'
  || requestedSource === 'stress-5m'
  || requestedSource === 'lion-grid-5m'
  ? requestedSource
  : 'no-sh';
const forceWebGL = parameters.get('backend') === 'webgl';
const initialCullingEnabled = parameters.get('culling') !== 'off';
const parsedContributionThreshold = Number(parameters.get('contribution'));
const initialContributionThreshold = parameters.has('contribution')
  && Number.isFinite(parsedContributionThreshold)
  && parsedContributionThreshold >= 0
  ? parsedContributionThreshold
  : 1;
const status = document.querySelector<HTMLElement>('#status')!;
const performanceSummary = document.querySelector<HTMLElement>('#performance-summary')!;
const cullingSummary = document.querySelector<HTMLElement>('#culling-summary')!;
const analysisSummary = document.querySelector<HTMLElement>('#analysis-summary')!;
const license = document.querySelector<HTMLElement>('#license')!;
const diagnostics = document.querySelector<HTMLElement>('#diagnostics')!;
const sourceSelect = document.querySelector<HTMLSelectElement>('#source')!;
const backendSelect = document.querySelector<HTMLSelectElement>('#backend')!;
const cullingCheckbox = document.querySelector<HTMLInputElement>('#contribution-culling')!;
const contributionThresholdInput = document.querySelector<HTMLInputElement>('#contribution-threshold')!;
const readCullingButton = document.querySelector<HTMLButtonElement>('#read-culling')!;
const motionButton = document.querySelector<HTMLButtonElement>('#motion')!;
const analysisButton = document.querySelector<HTMLButtonElement>('#analyze')!;

const exampleState: Window['__THREE_SOG_EXAMPLE__'] = window.__THREE_SOG_EXAMPLE__ = {
  state: 'initializing',
  backend: null,
  source: initialSource,
  splatCount: 0,
  sourceSplatCount: 0,
  runtimeCopyCount: 0,
  totalSortCount: 0,
  performance: null,
  analysisState: 'idle',
  analysisProgress: null,
  analysis: null,
  cullingEnabled: initialCullingEnabled,
  cullingThreshold: initialContributionThreshold,
  cullingStats: null,
  motion: 'idle',
  error: null,
  startCameraMotion: () => {},
  stopCameraMotion: () => {},
  resetPerformance: () => {},
  setContributionCullingEnabled: () => {},
  setContributionCullThreshold: () => {},
  readContributionCullingStats: async () => null,
  runBottleneckAnalysis: async () => {
    throw new Error('Bottleneck analysis is not initialized yet.');
  },
};

sourceSelect.value = initialSource;
backendSelect.value = forceWebGL ? 'webgl' : 'webgpu';
cullingCheckbox.checked = initialCullingEnabled;
contributionThresholdInput.value = String(initialContributionThreshold);
backendSelect.addEventListener('change', () => {
  const next = new URL(location.href);
  if (backendSelect.value === 'webgl') next.searchParams.set('backend', 'webgl');
  else next.searchParams.delete('backend');
  next.searchParams.set('source', sourceSelect.value);
  location.assign(next);
});

const scene = new Scene();
scene.background = new Color(0x07080f);
const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 0.001, 100);
const renderer = new WebGPURenderer({ antialias: true, forceWebGL, trackTimestamp: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
try {
  await renderer.init();
} catch (error) {
  exampleState.state = 'failed';
  exampleState.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  status.textContent = `Failed · ${exampleState.error}`;
  throw error;
}
const gpuTimestampSupported = renderer.hasFeature('timestamp-query');

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.target.set(0, 0, 0);
controls.update();

const loader = new SOGLoader();
let currentMesh: SOGGaussianSplatMesh | null = null;
let currentRoot: Group | null = null;
let currentRenderMeshes: SOGDrawMesh[] = [];
let currentResource: SOGResource | null = null;
let currentController: AbortController | null = null;
let loadGeneration = 0;
let disposed = false;
let lastDiagnostics = '';
let previousFrameAt: number | null = null;
let metricsWindowStartedAt = performance.now();
let metricsLogAt = metricsWindowStartedAt;
let metricsSortCount = 0;
const frameIntervals: number[] = [];
const cpuSubmitDurations: number[] = [];
const sampleLimit = 180;
const motionAxis = new Vector3(0, 1, 0);
const motionOffset = new Vector3();
let previousAnimationAt: number | null = null;
let latestTimestampSample: {
  readonly renderMs: number | null;
  readonly computeMs: number | null;
  readonly sampledAt: number;
} | null = null;
let lastTimestampResolveAt = 0;
let timestampResolvePromise: Promise<void> | null = null;
let analysisPromise: Promise<BottleneckAnalysis> | null = null;

function updateCullingSummary(): void {
  const meshDiagnostics = currentMesh?.diagnostics;
  if (!meshDiagnostics?.projectedCacheEnabled) {
    cullingSummary.textContent = 'Contribution culling unavailable on this render path.';
    return;
  }
  const stats = exampleState.cullingStats;
  if (!stats) {
    cullingSummary.textContent = `Contribution culling ${exampleState.cullingEnabled ? 'on' : 'off'} · threshold ${exampleState.cullingThreshold} · read telemetry for exact counts.`;
    return;
  }
  const culled = stats.submitted - stats.visible;
  const percentage = stats.submitted > 0 ? (culled / stats.submitted) * 100 : 0;
  cullingSummary.textContent = `${stats.visible.toLocaleString()} visible / ${stats.submitted.toLocaleString()} submitted · ${percentage.toFixed(1)}% culled · camera/alpha ${stats.behindOrAlpha.toLocaleString()} · offscreen ${stats.outsideFrustum.toLocaleString()} · low contribution ${stats.lowContribution.toLocaleString()}`;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function updateDiagnosticsView(): void {
  const nextDiagnostics = JSON.stringify({
    performance: exampleState.performance,
    analysisState: exampleState.analysisState,
    analysisProgress: exampleState.analysisProgress,
    analysis: exampleState.analysis,
    load: currentResource?.diagnostics ?? null,
    render: currentMesh?.diagnostics ?? null,
  }, null, 2);
  if (nextDiagnostics !== lastDiagnostics) {
    diagnostics.textContent = nextDiagnostics;
    lastDiagnostics = nextDiagnostics;
  }
}

function resetFrameMetrics(): void {
  const timestamp = performance.now();
  previousFrameAt = null;
  metricsWindowStartedAt = timestamp;
  metricsLogAt = timestamp;
  metricsSortCount = currentMesh?.diagnostics.sortCount ?? 0;
  frameIntervals.length = 0;
  cpuSubmitDurations.length = 0;
  exampleState.performance = null;
  performanceSummary.textContent = 'Measuring frame rate…';
  updateDiagnosticsView();
}

function setCameraMotion(active: boolean): void {
  exampleState.motion = active ? 'orbit' : 'idle';
  motionButton.textContent = active ? 'Stop motion test' : 'Start motion test';
  resetFrameMetrics();
}

exampleState.startCameraMotion = () => setCameraMotion(true);
exampleState.stopCameraMotion = () => setCameraMotion(false);
exampleState.resetPerformance = resetFrameMetrics;
motionButton.addEventListener('click', () => setCameraMotion(exampleState.motion !== 'orbit'));

function pushSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > sampleLimit) samples.shift();
}

function updateFrameMetrics(timestamp: number, cpuSubmitDurationMs: number): void {
  if (previousFrameAt !== null) {
    const interval = timestamp - previousFrameAt;
    if (interval > 0 && interval < 1_000) pushSample(frameIntervals, interval);
  }
  previousFrameAt = timestamp;
  pushSample(cpuSubmitDurations, cpuSubmitDurationMs);
  const windowDurationMs = timestamp - metricsWindowStartedAt;
  if (windowDurationMs < 1_000 || frameIntervals.length === 0) return;

  const renderDiagnostics = currentMesh?.diagnostics;
  const sortCount = renderDiagnostics?.sortCount ?? metricsSortCount;
  const averageFrameMs = average(frameIntervals);
  const snapshot: FramePerformanceMetrics = {
    backend: renderDiagnostics?.backend ?? null,
    radixBackend: renderDiagnostics?.radixBackend ?? null,
    radixBits: renderDiagnostics?.radixBits ?? 0,
    radixSelectionReason: renderDiagnostics?.radixSelectionReason ?? null,
    activeSplatCount: exampleState.splatCount,
    sourceSplatCount: exampleState.sourceSplatCount,
    runtimeCopyCount: exampleState.runtimeCopyCount,
    fps: rounded(1_000 / averageFrameMs),
    averageFrameMs: rounded(averageFrameMs),
    p95FrameMs: rounded(percentile(frameIntervals, 0.95)),
    maxFrameMs: rounded(Math.max(...frameIntervals)),
    averageCpuSubmitMs: rounded(average(cpuSubmitDurations)),
    p95CpuSubmitMs: rounded(percentile(cpuSubmitDurations, 0.95)),
    longFrameCount: frameIntervals.filter((duration) => duration > 1000 / 30).length,
    sampleFrames: frameIntervals.length,
    totalSortCount: sortCount,
    sortsPerSecond: rounded(((sortCount - metricsSortCount) * 1_000) / windowDurationMs),
    sortDurationMs: rounded(renderDiagnostics?.sortDurationMs ?? 0),
    sortDurationKind: renderDiagnostics?.backend === 'webgpu'
      ? 'cpu-command-submission'
      : renderDiagnostics?.backend === 'webgl'
        ? 'worker-execution'
        : null,
    staticDecodeDurationMs: rounded(renderDiagnostics?.staticDecodeDurationMs ?? 0),
    projectionWarmupDurationMs: rounded(renderDiagnostics?.projectionWarmupDurationMs ?? 0),
    projectionRefreshDurationMs: rounded(renderDiagnostics?.projectionRefreshDurationMs ?? 0),
    projectionRefreshCount: renderDiagnostics?.projectionRefreshCount ?? 0,
    projectedCacheEnabled: renderDiagnostics?.projectedCacheEnabled ?? false,
    contributionCullingEnabled: renderDiagnostics?.contributionCullingEnabled ?? false,
    contributionCullThreshold: renderDiagnostics?.contributionCullThreshold ?? 0,
    cullingStats: renderDiagnostics?.cullingStats ?? null,
    gpuTimestampSupported,
    latestGpuRenderMs: latestTimestampSample?.renderMs ?? null,
    latestGpuComputeMs: latestTimestampSample?.computeMs ?? null,
    gpuTimestampSampleAgeMs: latestTimestampSample
      ? rounded(performance.now() - latestTimestampSample.sampledAt)
      : null,
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderDiagnostics?.cullingStats
      ? renderDiagnostics.cullingStats.visible * 2
      : renderer.info.render.triangles,
    computePasses: renderer.info.compute.frameCalls,
    rendererMemoryBytes: renderer.info.memory.total,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      dpr: renderer.getPixelRatio(),
    },
  };
  exampleState.performance = snapshot;
  performanceSummary.textContent = `${snapshot.fps.toFixed(1)} FPS · ${snapshot.averageFrameMs.toFixed(1)} ms avg · ${snapshot.p95FrameMs.toFixed(1)} ms p95 · ${snapshot.sortsPerSecond.toFixed(1)} sorts/s`;
  metricsWindowStartedAt = timestamp;
  metricsSortCount = sortCount;
  updateDiagnosticsView();
  if (timestamp - metricsLogAt >= 5_000 && currentMesh) {
    console.info('[three-sog-splats][performance]', {
      source: exampleState.source,
      ...snapshot,
    });
    metricsLogAt = timestamp;
  }
}

function invalidateCullingTelemetry(): void {
  exampleState.cullingStats = null;
  updateCullingSummary();
  resetFrameMetrics();
}

exampleState.setContributionCullingEnabled = (enabled: boolean): void => {
  exampleState.cullingEnabled = enabled;
  cullingCheckbox.checked = enabled;
  currentMesh?.setContributionCullingEnabled(enabled);
  const next = new URL(location.href);
  if (enabled) next.searchParams.delete('culling');
  else next.searchParams.set('culling', 'off');
  history.replaceState(null, '', next);
  invalidateCullingTelemetry();
};

exampleState.setContributionCullThreshold = (threshold: number): void => {
  if (!Number.isFinite(threshold) || threshold < 0) return;
  exampleState.cullingThreshold = threshold;
  contributionThresholdInput.value = String(threshold);
  currentMesh?.setContributionCullThreshold(threshold);
  const next = new URL(location.href);
  if (threshold === 1) next.searchParams.delete('contribution');
  else next.searchParams.set('contribution', String(threshold));
  history.replaceState(null, '', next);
  invalidateCullingTelemetry();
};

exampleState.readContributionCullingStats = async (): Promise<SOGContributionCullingStats | null> => {
  const stats = await currentMesh?.readContributionCullingStatsAsync() ?? null;
  exampleState.cullingStats = stats;
  updateCullingSummary();
  updateDiagnosticsView();
  return stats;
};

cullingCheckbox.addEventListener('change', () => {
  exampleState.setContributionCullingEnabled(cullingCheckbox.checked);
});
contributionThresholdInput.addEventListener('input', () => {
  exampleState.setContributionCullThreshold(Number(contributionThresholdInput.value));
});
readCullingButton.addEventListener('click', () => {
  readCullingButton.disabled = true;
  void exampleState.readContributionCullingStats().finally(() => {
    readCullingButton.disabled = !currentMesh?.diagnostics.projectedCacheEnabled;
  });
});

function scheduleTimestampSample(timestamp: number): void {
  if (
    !gpuTimestampSupported
    || exampleState.analysisState === 'running'
    || timestampResolvePromise
    || timestamp - lastTimestampResolveAt < 2_000
  ) return;
  lastTimestampResolveAt = timestamp;
  const includeCompute = renderer.info.compute.frameCalls > 0;
  timestampResolvePromise = Promise.all([
    renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
    includeCompute
      ? renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE)
      : Promise.resolve(undefined),
  ]).then(([renderMs, computeMs]) => {
    latestTimestampSample = {
      renderMs: typeof renderMs === 'number' && Number.isFinite(renderMs) && renderMs >= 0
        ? rounded(renderMs)
        : null,
      computeMs: typeof computeMs === 'number' && Number.isFinite(computeMs) && computeMs >= 0
        ? rounded(computeMs)
        : null,
      sampledAt: performance.now(),
    };
  }).catch((error) => {
    console.warn('[three-sog-splats][timestamp-sample]', error);
  }).finally(() => {
    timestampResolvePromise = null;
  });
}

function setLicense(source: SourceDefinition): void {
  license.replaceChildren();
  if (!source.credit) return;
  const author = document.createElement('a');
  author.href = source.credit.authorUrl;
  author.target = '_blank';
  author.rel = 'noopener';
  author.textContent = source.credit.author;
  const original = document.createElement('a');
  original.href = source.credit.source;
  original.target = '_blank';
  original.rel = 'noopener';
  original.textContent = 'original scene';
  const licenseLink = document.createElement('a');
  licenseLink.href = source.credit.licenseUrl;
  licenseLink.target = '_blank';
  licenseLink.rel = 'noopener';
  licenseLink.textContent = source.credit.license;
  license.append(
    'Model by ',
    author,
    ' · ',
    original,
    ' · ',
    licenseLink,
    source.runtimeGrid
      ? ` · one full SOG download, instanced ${source.runtimeGrid.columns * source.runtimeGrid.rows} times at runtime.`
      : ' · converted to SOG without decimation.',
  );
}

function fitCamera(
  root: Group,
  source: SourceDefinition,
  renderMeshes: readonly SOGDrawMesh[],
): void {
  root.updateWorldMatrix(true, true);
  const onlyMesh = renderMeshes.length === 1 ? renderMeshes[0] : undefined;
  const sphere = onlyMesh?.geometry.boundingSphere
    ? onlyMesh.geometry.boundingSphere.clone().applyMatrix4(onlyMesh.matrixWorld)
    : new Box3().setFromObject(root).getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 0.01);
  const distance = radius / Math.sin(MathUtils.degToRad(camera.fov) * 0.5);
  controls.minDistance = radius * 0.25;
  controls.maxDistance = radius * 10;
  controls.target.copy(sphere.center);
  camera.position.copy(source.cameraDirection).normalize().multiplyScalar(distance * 1.15).add(sphere.center);
  camera.near = Math.max(distance / 1_000, 0.001);
  camera.far = Math.max(distance * 10, 10);
  camera.updateProjectionMatrix();
  controls.update();
}

function createRuntimeComposition(
  mesh: SOGGaussianSplatMesh,
  source: SourceDefinition,
): {
  root: Group;
  renderMeshes: SOGDrawMesh[];
  totalSplatCount: number;
  runtimeCopyCount: number;
} {
  const root = new Group();
  root.name = `${source.name} root`;
  if (source.rotation) root.rotation.copy(source.rotation);
  if (source.scale) root.scale.setScalar(source.scale);
  const grid = source.runtimeGrid;
  if (!grid) {
    root.add(mesh);
    return {
      root,
      renderMeshes: [mesh],
      totalSplatCount: mesh.resource.count,
      runtimeCopyCount: 1,
    };
  }
  root.add(mesh);
  const runtimeCopyCount = grid.columns * grid.rows;
  return {
    root,
    renderMeshes: [mesh],
    totalSplatCount: mesh.resource.count * runtimeCopyCount,
    runtimeCopyCount,
  };
}

function createRuntimeInstanceTransforms(
  resource: SOGResource,
  source: SourceDefinition,
): Matrix4[] {
  const grid = source.runtimeGrid;
  if (!grid) return [new Matrix4()];
  const maxScale = Math.exp(Math.max(...resource.meta.scales.codebook.filter(Number.isFinite)));
  const coverageRadius = maxScale * 2;
  const size = new Box3(
    new Vector3(...resource.bounds.min).addScalar(-coverageRadius),
    new Vector3(...resource.bounds.max).addScalar(coverageRadius),
  ).getSize(new Vector3());
  const spacingX = Math.max(size.x * 1.18, 0.01);
  const spacingY = Math.max(size.y * 1.14, 0.01);
  const transforms: Matrix4[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      transforms.push(new Matrix4().makeTranslation(
        (column - (grid.columns - 1) * 0.5) * spacingX,
        (row - (grid.rows - 1) * 0.5) * spacingY,
        0,
      ));
    }
  }
  return transforms;
}

interface AnalysisScenarioDefinition {
  readonly id: string;
  readonly label: string;
  readonly instanceCount: number;
  readonly pixelRatio: number;
  readonly modelScale: number;
  readonly visible: boolean;
  readonly cullingEnabled?: boolean;
  readonly contributionThreshold?: number;
}

interface AnalysisFrameProbe {
  readonly cpuSubmitMs: number;
  readonly gpuRenderMs: number | null;
  readonly gpuComputeMs: number | null;
  readonly gpuCompletionMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly computePasses: number;
}

function setAnalysisControlsDisabled(disabled: boolean): void {
  sourceSelect.disabled = disabled;
  backendSelect.disabled = disabled;
  motionButton.disabled = disabled;
  analysisButton.disabled = disabled || exampleState.state !== 'ready';
  cullingCheckbox.disabled = disabled || !currentMesh?.diagnostics.projectedCacheEnabled;
  contributionThresholdInput.disabled = disabled || !currentMesh?.diagnostics.projectedCacheEnabled;
  readCullingButton.disabled = disabled || !currentMesh?.diagnostics.projectedCacheEnabled;
}

function setAnalysisProgress(completed: number, total: number, stage: string): void {
  exampleState.analysisProgress = { completed, total, stage };
  analysisSummary.textContent = `Profiling ${completed}/${total} · ${stage}`;
  updateDiagnosticsView();
}

async function resolvePendingTimestamps(): Promise<void> {
  if (!gpuTimestampSupported) return;
  if (timestampResolvePromise) await timestampResolvePromise;
  await Promise.all([
    renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
    renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE),
  ]);
}

async function measureAnalysisFrame(): Promise<AnalysisFrameProbe> {
  if (disposed) throw new Error('The example was disposed while analysis was running.');
  renderer.info.reset();
  const startedAt = performance.now();
  renderer.render(scene, camera);
  const cpuSubmitMs = performance.now() - startedAt;
  const drawCalls = renderer.info.render.drawCalls;
  const triangles = renderer.info.render.triangles;
  const computePasses = renderer.info.compute.frameCalls;
  const completionStartedAt = performance.now();
  const [gpuRenderMs, gpuComputeMs] = gpuTimestampSupported
    ? await Promise.all([
        renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
        computePasses > 0
          ? renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE)
          : Promise.resolve(undefined),
      ])
    : [undefined, undefined];
  return {
    cpuSubmitMs,
    gpuRenderMs: typeof gpuRenderMs === 'number' && Number.isFinite(gpuRenderMs) && gpuRenderMs >= 0
      ? gpuRenderMs
      : null,
    gpuComputeMs: typeof gpuComputeMs === 'number' && Number.isFinite(gpuComputeMs) && gpuComputeMs >= 0
      ? gpuComputeMs
      : null,
    gpuCompletionMs: performance.now() - completionStartedAt,
    drawCalls,
    triangles,
    computePasses,
  };
}

function configureAnalysisScenario(
  renderMeshes: readonly SOGDrawMesh[],
  root: Group,
  logicalSplatCount: number,
  definition: AnalysisScenarioDefinition,
  originalScale: Vector3,
): void {
  renderer.setPixelRatio(definition.pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  let remaining = definition.instanceCount;
  for (const renderMesh of renderMeshes) {
    const instanceCount = Math.min(logicalSplatCount, Math.max(0, remaining));
    renderMesh.geometry.instanceCount = instanceCount;
    renderMesh.visible = definition.visible && instanceCount > 0;
    remaining -= instanceCount;
  }
  root.scale.copy(originalScale).multiplyScalar(definition.modelScale);
  root.updateWorldMatrix(true, true);
  currentMesh?.setContributionCullingEnabled(definition.cullingEnabled ?? true);
  if (definition.contributionThreshold !== undefined) {
    currentMesh?.setContributionCullThreshold(definition.contributionThreshold);
  }
}

async function measureAnalysisScenario(
  renderMeshes: readonly SOGDrawMesh[],
  root: Group,
  logicalSplatCount: number,
  definition: AnalysisScenarioDefinition,
  originalScale: Vector3,
  sampleCount: number,
): Promise<BottleneckScenario> {
  configureAnalysisScenario(renderMeshes, root, logicalSplatCount, definition, originalScale);
  await measureAnalysisFrame();
  const cullingStats = definition.visible
    ? await currentMesh?.readContributionCullingStatsAsync() ?? null
    : {
        submitted: 0,
        visible: 0,
        behindOrAlpha: 0,
        outsideFrustum: 0,
        lowContribution: 0,
      };
  const probes: AnalysisFrameProbe[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    probes.push(await measureAnalysisFrame());
  }
  const gpuRenderSamples = probes.flatMap((probe) => (
    probe.gpuRenderMs === null ? [] : [probe.gpuRenderMs]
  ));
  return {
    id: definition.id,
    label: definition.label,
    instanceCount: definition.instanceCount,
    pixelRatio: definition.pixelRatio,
    modelScale: definition.modelScale,
    sampleCount: probes.length,
    gpuRenderMedianMs: gpuRenderSamples.length > 0
      ? rounded(percentile(gpuRenderSamples, 0.5))
      : null,
    gpuRenderP95Ms: gpuRenderSamples.length > 0
      ? rounded(percentile(gpuRenderSamples, 0.95))
      : null,
    cpuSubmitMedianMs: rounded(percentile(probes.map((probe) => probe.cpuSubmitMs), 0.5)),
    cpuSubmitP95Ms: rounded(percentile(probes.map((probe) => probe.cpuSubmitMs), 0.95)),
    gpuCompletionMedianMs: rounded(percentile(
      probes.map((probe) => probe.gpuCompletionMs),
      0.5,
    )),
    drawCalls: Math.max(...probes.map((probe) => probe.drawCalls)),
    triangles: cullingStats
      ? cullingStats.visible * 2
      : Math.max(...probes.map((probe) => probe.triangles)),
    vertexInvocations: definition.visible
      ? (cullingStats?.visible ?? definition.instanceCount)
        * (renderMeshes[0]?.geometry.getAttribute('position').count ?? 6)
      : 0,
    cullingEnabled: definition.cullingEnabled ?? true,
    cullingSubmitted: cullingStats?.submitted ?? null,
    cullingVisible: cullingStats?.visible ?? null,
  };
}

async function measureCameraUpdate(
  renderMeshes: readonly SOGDrawMesh[],
  root: Group,
  logicalSplatCount: number,
  originalScale: Vector3,
  originalPixelRatio: number,
  sampleCount: number,
  includesProjectionRefresh: boolean,
  contributionThreshold: number,
): Promise<BottleneckCameraUpdateMeasurement | null> {
  configureAnalysisScenario(renderMeshes, root, logicalSplatCount, {
    id: 'camera-update',
    label: 'Camera-change sort + projection/SH refresh',
    instanceCount: 1,
    pixelRatio: originalPixelRatio,
    modelScale: 1,
    visible: true,
    contributionThreshold,
  }, originalScale);
  const moveCamera = (): void => {
    motionOffset.copy(camera.position).sub(controls.target);
    motionOffset.applyAxisAngle(motionAxis, 0.0025);
    camera.position.copy(controls.target).add(motionOffset);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld(true);
  };
  moveCamera();
  await measureAnalysisFrame();
  const probes: AnalysisFrameProbe[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    moveCamera();
    probes.push(await measureAnalysisFrame());
  }
  const gpuComputeSamples = probes.flatMap((probe) => (
    probe.gpuComputeMs === null ? [] : [probe.gpuComputeMs]
  ));
  if (probes.every((probe) => probe.computePasses === 0)) return null;
  return {
    sampleCount: probes.length,
    gpuComputeMedianMs: gpuComputeSamples.length > 0
      ? rounded(percentile(gpuComputeSamples, 0.5))
      : null,
    gpuComputeP95Ms: gpuComputeSamples.length > 0
      ? rounded(percentile(gpuComputeSamples, 0.95))
      : null,
    cpuSubmitMedianMs: rounded(percentile(probes.map((probe) => probe.cpuSubmitMs), 0.5)),
    computePasses: Math.round(percentile(probes.map((probe) => probe.computePasses), 0.5)),
    includesProjectionRefresh,
  };
}

function buildAnalysisScenarios(
  splatCount: number,
  pixelRatio: number,
  contributionThreshold: number,
): AnalysisScenarioDefinition[] {
  const scenarios: AnalysisScenarioDefinition[] = [{
    id: 'empty',
    label: 'Empty render pass',
    instanceCount: 0,
    pixelRatio,
    modelScale: 1,
    visible: false,
  }];
  for (const count of [100_000, 500_000, 1_000_000, 2_000_000]) {
    if (count >= splatCount) continue;
    scenarios.push({
      id: `instances-${count}`,
      label: `${count.toLocaleString()} splats`,
      instanceCount: count,
      pixelRatio,
      modelScale: 1,
      visible: true,
      contributionThreshold,
    });
  }
  scenarios.push(
    {
      id: 'full',
      label: `${splatCount.toLocaleString()} splats · full resolution`,
      instanceCount: splatCount,
      pixelRatio,
      modelScale: 1,
      visible: true,
      contributionThreshold,
    },
    {
      id: 'half-resolution',
      label: `${splatCount.toLocaleString()} splats · half DPR`,
      instanceCount: splatCount,
      pixelRatio: Math.max(0.5, pixelRatio * 0.5),
      modelScale: 1,
      visible: true,
      contributionThreshold: contributionThreshold * 0.25,
    },
    {
      id: 'full-no-contribution-culling',
      label: `${splatCount.toLocaleString()} splats · culling disabled`,
      instanceCount: splatCount,
      pixelRatio,
      modelScale: 1,
      visible: true,
      cullingEnabled: false,
      contributionThreshold,
    },
    {
      id: 'quarter-resolution',
      label: `${splatCount.toLocaleString()} splats · quarter DPR`,
      instanceCount: splatCount,
      pixelRatio: Math.max(0.25, pixelRatio * 0.25),
      modelScale: 1,
      visible: true,
      contributionThreshold: contributionThreshold * 0.0625,
    },
    {
      id: 'quarter-scale',
      label: `${splatCount.toLocaleString()} splats · quarter model scale`,
      instanceCount: splatCount,
      pixelRatio,
      modelScale: 0.25,
      visible: true,
      contributionThreshold: contributionThreshold * 0.0625,
    },
  );
  return scenarios;
}

async function executeBottleneckAnalysis(): Promise<BottleneckAnalysis> {
  const mesh = currentMesh;
  const root = currentRoot;
  const renderMeshes = [...currentRenderMeshes];
  if (!mesh || !root || renderMeshes.length === 0 || exampleState.state !== 'ready') {
    throw new Error('Wait for a SOG scene to finish loading before running the analysis.');
  }
  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();
  const originalPixelRatio = renderer.getPixelRatio();
  const originalScale = root.scale.clone();
  const originalMeshStates = renderMeshes.map((renderMesh) => ({
    instanceCount: renderMesh.geometry.instanceCount,
    visible: renderMesh.visible,
  }));
  const originalCameraPosition = camera.position.clone();
  const originalCameraQuaternion = camera.quaternion.clone();
  const originalCameraScale = camera.scale.clone();
  const originalTarget = controls.target.clone();
  const originalMotion = exampleState.motion;
  const originalCullingEnabled = exampleState.cullingEnabled;
  const originalContributionThreshold = exampleState.cullingThreshold;
  const definitions = buildAnalysisScenarios(
    exampleState.splatCount,
    originalPixelRatio,
    originalContributionThreshold,
  );
  const totalStages = definitions.length + 1;
  exampleState.analysisState = 'running';
  exampleState.analysisProgress = null;
  exampleState.analysis = null;
  exampleState.cullingStats = null;
  exampleState.error = null;
  exampleState.motion = 'idle';
  motionButton.textContent = 'Start motion test';
  setAnalysisControlsDisabled(true);
  renderer.setAnimationLoop(null);

  try {
    await resolvePendingTimestamps();
    const scenarios: BottleneckScenario[] = [];
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index]!;
      setAnalysisProgress(index, totalStages, definition.label);
      scenarios.push(await measureAnalysisScenario(
        renderMeshes,
        root,
        exampleState.splatCount,
        definition,
        originalScale,
        5,
      ));
    }
    setAnalysisProgress(definitions.length, totalStages, 'Camera-change sort + projection/SH refresh');
    const cameraUpdate = await measureCameraUpdate(
      renderMeshes,
      root,
      exampleState.splatCount,
      originalScale,
      originalPixelRatio,
      3,
      mesh.diagnostics.projectedCacheEnabled,
      originalContributionThreshold,
    );
    const derived = deriveBottleneckFindings(scenarios, cameraUpdate);
    const fullScenario = scenarios.find((scenario) => scenario.id === 'full');
    const completedAt = new Date().toISOString();
    const report: BottleneckAnalysis = {
      source: exampleState.source,
      backend: mesh.diagnostics.backend,
      splatCount: exampleState.splatCount,
      sourceSplatCount: mesh.resource.count,
      runtimeCopyCount: exampleState.runtimeCopyCount,
      timestampSupported: gpuTimestampSupported,
      startedAt,
      completedAt,
      durationMs: rounded(performance.now() - startedAtMs),
      viewport: {
        width: innerWidth,
        height: innerHeight,
        pixelRatio: originalPixelRatio,
      },
      scenarios,
      cameraUpdate,
      findings: derived.findings,
      summary: derived.summary,
      notes: [
        'GPU timestamps measure render and compute passes; timestamp readback latency is excluded from CPU command-submission time.',
        'Half and quarter DPR scale the contribution threshold by pixel area so the compacted survivor set remains comparable while drawing-buffer pixels fall to one quarter and one sixteenth.',
        'Quarter model scale scales the contribution threshold by projected area to retain a comparable survivor set while reducing projected footprint.',
        `The camera-change probe renders one instance while sorting the shared ${mesh.resource.count.toLocaleString()}-splat source and refreshing ${exampleState.splatCount.toLocaleString()} cached projections; stationary frames run neither compute stage.`,
        ...(fullScenario && mesh.material.transparent && mesh.material.side === DoubleSide && !mesh.material.forceSinglePass
          ? [`Transparent DoubleSide rendering produced ${fullScenario.drawCalls.toLocaleString()} draw calls and ${fullScenario.triangles.toLocaleString()} triangles in the full probe, approximately twice the splat geometry's single-sided triangle count.`]
          : ['Transparent Gaussian sprites use forceSinglePass, avoiding Three.js\'s second DoubleSide geometry pass.']),
        'Invalid negative driver timestamp samples are discarded; the empty-pass GPU-completion latency is used as the fixed-cost proxy when needed.',
      ],
    };
    exampleState.analysis = report;
    exampleState.analysisState = 'complete';
    exampleState.analysisProgress = null;
    analysisSummary.textContent = report.summary;
    console.info('[three-sog-splats][bottleneck-analysis]', report);
    console.table(report.scenarios);
    updateDiagnosticsView();
    return report;
  } catch (error) {
    exampleState.analysisState = 'failed';
    exampleState.analysisProgress = null;
    exampleState.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    analysisSummary.textContent = `Analysis failed · ${exampleState.error}`;
    updateDiagnosticsView();
    throw error;
  } finally {
    if (
      !disposed
      && currentMesh === mesh
      && currentRoot === root
      && mesh.state === 'ready'
    ) {
      renderer.setPixelRatio(originalPixelRatio);
      renderer.setSize(innerWidth, innerHeight);
      for (let index = 0; index < renderMeshes.length; index += 1) {
        const state = originalMeshStates[index]!;
        renderMeshes[index]!.geometry.instanceCount = state.instanceCount;
        renderMeshes[index]!.visible = state.visible;
      }
      root.scale.copy(originalScale);
      root.updateWorldMatrix(true, true);
      camera.position.copy(originalCameraPosition);
      camera.quaternion.copy(originalCameraQuaternion);
      camera.scale.copy(originalCameraScale);
      camera.updateMatrixWorld(true);
      controls.target.copy(originalTarget);
      controls.update();
      exampleState.motion = originalMotion;
      mesh.setContributionCullingEnabled(originalCullingEnabled);
      mesh.setContributionCullThreshold(originalContributionThreshold);
      exampleState.cullingStats = null;
      updateCullingSummary();
      motionButton.textContent = originalMotion === 'orbit' ? 'Stop motion test' : 'Start motion test';
      previousAnimationAt = null;
      lastTimestampResolveAt = performance.now();
      resetFrameMetrics();
      renderer.setAnimationLoop(renderFrame);
      setAnalysisControlsDisabled(false);
    }
  }
}

exampleState.runBottleneckAnalysis = (): Promise<BottleneckAnalysis> => {
  if (analysisPromise) return analysisPromise;
  analysisPromise = executeBottleneckAnalysis().finally(() => {
    analysisPromise = null;
  });
  return analysisPromise;
};

analysisButton.addEventListener('click', () => {
  void exampleState.runBottleneckAnalysis().catch(() => {});
});

function disposeSelection(): void {
  if (currentRoot) scene.remove(currentRoot);
  currentRoot?.clear();
  currentMesh?.dispose();
  currentResource?.dispose();
  currentMesh = null;
  currentRoot = null;
  currentRenderMeshes = [];
  currentResource = null;
}

async function loadSource(key: SourceKey): Promise<void> {
  if ((key === 'stress-5m' || key === 'lion-grid-5m') && forceWebGL) {
    status.textContent = 'The 5M stress scene requires WebGPU; switching backend…';
    const next = new URL(location.href);
    next.searchParams.set('source', key);
    next.searchParams.delete('backend');
    location.assign(next);
    return;
  }
  const generation = ++loadGeneration;
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  const source = sources[key];
  exampleState.state = 'loading';
  exampleState.source = key;
  exampleState.sourceSplatCount = 0;
  exampleState.runtimeCopyCount = 0;
  exampleState.error = null;
  exampleState.analysisState = 'idle';
  exampleState.analysisProgress = null;
  exampleState.analysis = null;
  analysisSummary.textContent = 'Run the controlled profiler to identify the slow stage.';
  analysisButton.disabled = true;
  status.textContent = `Loading ${source.name}…`;
  setLicense(source);
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set('source', key);
  if (forceWebGL) nextUrl.searchParams.set('backend', 'webgl');
  else nextUrl.searchParams.delete('backend');
  if (exampleState.cullingEnabled) nextUrl.searchParams.delete('culling');
  else nextUrl.searchParams.set('culling', 'off');
  if (exampleState.cullingThreshold === 1) nextUrl.searchParams.delete('contribution');
  else nextUrl.searchParams.set('contribution', String(exampleState.cullingThreshold));
  history.replaceState(null, '', nextUrl);

  let resource: SOGResource | null = null;
  let mesh: SOGGaussianSplatMesh | null = null;
  try {
    resource = await loader.loadAsync(source.url, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        if (generation !== loadGeneration) return;
        const progress = total ? ` ${Math.round((loaded / total) * 100)}%` : '';
        status.textContent = `Loading ${source.name}${progress}…`;
      },
    });
    mesh = new SOGGaussianSplatMesh(resource);
    mesh.setInstanceTransforms(createRuntimeInstanceTransforms(resource, source));
    mesh.setContributionCullingEnabled(exampleState.cullingEnabled);
    mesh.setContributionCullThreshold(exampleState.cullingThreshold);
    exampleState.state = 'preparing';
    status.textContent = `Preparing ${source.name}…`;
    await mesh.prepare(renderer, { signal: controller.signal });
    if (generation !== loadGeneration || disposed) {
      mesh.dispose();
      resource.dispose();
      return;
    }

    const composition = createRuntimeComposition(mesh, source);
    disposeSelection();
    currentMesh = mesh;
    currentRoot = composition.root;
    currentRenderMeshes = composition.renderMeshes;
    currentResource = resource;
    scene.add(composition.root);
    fitCamera(composition.root, source, composition.renderMeshes);
    exampleState.state = 'ready';
    exampleState.backend = mesh.diagnostics.backend;
    exampleState.splatCount = composition.totalSplatCount;
    exampleState.sourceSplatCount = resource.count;
    exampleState.runtimeCopyCount = composition.runtimeCopyCount;
    status.textContent = `${source.name} · ${composition.totalSplatCount.toLocaleString()} splats · ${mesh.diagnostics.backend}`;
    analysisButton.disabled = false;
    cullingCheckbox.disabled = !mesh.diagnostics.projectedCacheEnabled;
    contributionThresholdInput.disabled = !mesh.diagnostics.projectedCacheEnabled;
    readCullingButton.disabled = !mesh.diagnostics.projectedCacheEnabled;
    updateCullingSummary();
    resetFrameMetrics();
  } catch (error) {
    mesh?.dispose();
    resource?.dispose();
    if (generation !== loadGeneration || controller.signal.aborted || disposed) return;
    exampleState.state = 'failed';
    exampleState.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    analysisButton.disabled = true;
    status.textContent = `Failed · ${exampleState.error}`;
    updateDiagnosticsView();
  }
}

sourceSelect.addEventListener('change', () => {
  void loadSource(sourceSelect.value as SourceKey);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function renderFrame(timestamp: number): void {
  const cpuStartedAt = performance.now();
  const deltaSeconds = previousAnimationAt === null
    ? 0
    : Math.min((timestamp - previousAnimationAt) / 1_000, 0.1);
  previousAnimationAt = timestamp;
  if (exampleState.motion === 'orbit') {
    motionOffset.copy(camera.position).sub(controls.target);
    motionOffset.applyAxisAngle(motionAxis, Math.PI * 0.2 * deltaSeconds);
    camera.position.copy(controls.target).add(motionOffset);
    camera.lookAt(controls.target);
  }
  controls.update();
  renderer.render(scene, camera);
  exampleState.totalSortCount = currentMesh?.diagnostics.sortCount ?? 0;
  updateFrameMetrics(timestamp, performance.now() - cpuStartedAt);
  scheduleTimestampSample(timestamp);
}

renderer.setAnimationLoop(renderFrame);

addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resetFrameMetrics();
});

addEventListener('pagehide', () => {
  if (disposed) return;
  disposed = true;
  exampleState.state = 'disposed';
  currentController?.abort();
  renderer.setAnimationLoop(null);
  disposeSelection();
  controls.dispose();
  renderer.dispose();
}, { once: true });

await loadSource(initialSource);
