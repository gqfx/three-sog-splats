import {
  Color,
  Euler,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SOGGaussianSplatMesh, SOGLoader } from '../src/index.js';
import type { SOGResource } from '../src/index.js';

type SourceKey = 'millipede' | 'no-sh' | 'sh';

interface FramePerformanceMetrics {
  readonly backend: string | null;
  readonly activeSplatCount: number;
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
      totalSortCount: number;
      performance: FramePerformanceMetrics | null;
      motion: 'idle' | 'orbit';
      error: string | null;
      startCameraMotion(): void;
      stopCameraMotion(): void;
      resetPerformance(): void;
    };
  }
}

const sources: Record<SourceKey, SourceDefinition> = {
  millipede: {
    name: 'Millipede · full 116K',
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
  'no-sh': {
    name: 'Synthetic · no SH',
    url: '/minimal-no-sh.sog',
    cameraDirection: new Vector3(0.35, 0.25, 4),
    scale: 0.35,
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
};

const parameters = new URLSearchParams(location.search);
const requestedSource = parameters.get('source');
const initialSource: SourceKey = requestedSource && requestedSource in sources
  ? requestedSource as SourceKey
  : 'millipede';
const forceWebGL = parameters.get('backend') === 'webgl';
const status = document.querySelector<HTMLElement>('#status')!;
const performanceSummary = document.querySelector<HTMLElement>('#performance-summary')!;
const license = document.querySelector<HTMLElement>('#license')!;
const diagnostics = document.querySelector<HTMLElement>('#diagnostics')!;
const sourceSelect = document.querySelector<HTMLSelectElement>('#source')!;
const backendSelect = document.querySelector<HTMLSelectElement>('#backend')!;
const motionButton = document.querySelector<HTMLButtonElement>('#motion')!;

const exampleState: Window['__THREE_SOG_EXAMPLE__'] = window.__THREE_SOG_EXAMPLE__ = {
  state: 'initializing',
  backend: null,
  source: initialSource,
  splatCount: 0,
  totalSortCount: 0,
  performance: null,
  motion: 'idle',
  error: null,
  startCameraMotion: () => {},
  stopCameraMotion: () => {},
  resetPerformance: () => {},
};

sourceSelect.value = initialSource;
backendSelect.value = forceWebGL ? 'webgl' : 'webgpu';
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
const renderer = new WebGPURenderer({ antialias: true, forceWebGL });
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

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.target.set(0, 0, 0);
controls.update();

const loader = new SOGLoader();
let currentMesh: SOGGaussianSplatMesh | null = null;
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
    activeSplatCount: renderDiagnostics?.activeSplatCount ?? 0,
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

  const nextDiagnostics = JSON.stringify({
    performance: snapshot,
    load: currentResource?.diagnostics ?? null,
    render: renderDiagnostics ?? null,
  }, null, 2);
  if (nextDiagnostics !== lastDiagnostics) {
    diagnostics.textContent = nextDiagnostics;
    lastDiagnostics = nextDiagnostics;
  }
  if (timestamp - metricsLogAt >= 5_000 && currentMesh) {
    console.info('[three-sog-splats][performance]', {
      source: exampleState.source,
      ...snapshot,
    });
    metricsLogAt = timestamp;
  }
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
  license.append('Model by ', author, ' · ', original, ' · ', licenseLink, ' · converted to SOG without decimation.');
}

function fitCamera(mesh: SOGGaussianSplatMesh, source: SourceDefinition): void {
  mesh.updateWorldMatrix(true, false);
  const sphere = mesh.geometry.boundingSphere?.clone().applyMatrix4(mesh.matrixWorld);
  if (!sphere) return;
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

function disposeSelection(): void {
  if (currentMesh) scene.remove(currentMesh);
  currentMesh?.dispose();
  currentResource?.dispose();
  currentMesh = null;
  currentResource = null;
}

async function loadSource(key: SourceKey): Promise<void> {
  const generation = ++loadGeneration;
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  const source = sources[key];
  exampleState.state = 'loading';
  exampleState.source = key;
  exampleState.error = null;
  status.textContent = `Loading ${source.name}…`;
  setLicense(source);
  history.replaceState(null, '', `?source=${key}${forceWebGL ? '&backend=webgl' : ''}`);

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
    if (source.rotation) mesh.rotation.copy(source.rotation);
    if (source.scale) mesh.scale.setScalar(source.scale);
    exampleState.state = 'preparing';
    status.textContent = `Preparing ${source.name}…`;
    await mesh.prepare(renderer, { signal: controller.signal });
    if (generation !== loadGeneration || disposed) {
      mesh.dispose();
      resource.dispose();
      return;
    }

    disposeSelection();
    currentMesh = mesh;
    currentResource = resource;
    scene.add(mesh);
    fitCamera(mesh, source);
    exampleState.state = 'ready';
    exampleState.backend = mesh.diagnostics.backend;
    exampleState.splatCount = resource.count;
    status.textContent = `${source.name} · ${resource.count.toLocaleString()} splats · ${mesh.diagnostics.backend}`;
    resetFrameMetrics();
  } catch (error) {
    mesh?.dispose();
    resource?.dispose();
    if (generation !== loadGeneration || controller.signal.aborted || disposed) return;
    exampleState.state = 'failed';
    exampleState.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    status.textContent = `Failed · ${exampleState.error}`;
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

renderer.setAnimationLoop((timestamp) => {
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
});

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
