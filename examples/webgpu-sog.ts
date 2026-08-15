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
      error: string | null;
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
    name: 'Synthetic · SH1',
    url: '/minimal-sh1.sog',
    cameraDirection: new Vector3(0.35, 0.25, 4),
    scale: 0.35,
  },
};

const parameters = new URLSearchParams(location.search);
const requestedSource = parameters.get('source');
const initialSource: SourceKey = requestedSource && requestedSource in sources
  ? requestedSource as SourceKey
  : 'millipede';
const forceWebGL = parameters.get('backend') === 'webgl';
const status = document.querySelector<HTMLElement>('#status')!;
const license = document.querySelector<HTMLElement>('#license')!;
const diagnostics = document.querySelector<HTMLElement>('#diagnostics')!;
const sourceSelect = document.querySelector<HTMLSelectElement>('#source')!;
const backendSelect = document.querySelector<HTMLSelectElement>('#backend')!;

const exampleState: Window['__THREE_SOG_EXAMPLE__'] = window.__THREE_SOG_EXAMPLE__ = {
  state: 'initializing',
  backend: null,
  source: initialSource,
  splatCount: 0,
  error: null,
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
controls.enableDamping = true;
controls.target.set(0, 0, 0);
controls.update();

const loader = new SOGLoader();
let currentMesh: SOGGaussianSplatMesh | null = null;
let currentResource: SOGResource | null = null;
let currentController: AbortController | null = null;
let loadGeneration = 0;
let disposed = false;
let lastDiagnostics = '';

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

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  if (currentMesh) {
    const nextDiagnostics = JSON.stringify(currentMesh.diagnostics, null, 2);
    if (nextDiagnostics !== lastDiagnostics) {
      diagnostics.textContent = nextDiagnostics;
      lastDiagnostics = nextDiagnostics;
    }
  }
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
