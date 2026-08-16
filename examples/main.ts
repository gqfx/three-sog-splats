import {
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  StorageBufferAttribute,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BrowserSOGImageDecoder, SOGGaussianSplatMesh, SOGLoader } from '../src/index.js';
import type { SOGLoadDiagnostics, SOGRenderDiagnostics } from '../src/index.js';
import { PortableRadixSortBackend } from '../src/render/sort/PortableRadixSortBackend.js';

interface GpuSortVerification {
  readonly order: number[];
  readonly buckets: number[];
  readonly complete: boolean;
  readonly monotonic: boolean;
  readonly stable: boolean;
}

declare global {
  interface Window {
    __SOG_EXAMPLE__: {
      state: 'loading' | 'preparing' | 'ready' | 'disposed' | 'failed';
      backend: string | null;
      fixture: string;
      progress: number;
      diagnostics: Readonly<SOGRenderDiagnostics> | null;
      loadDiagnostics: SOGLoadDiagnostics | null;
      error: string | null;
      moveCamera(): void;
      dispose(): void;
      decodeFixtureTexel(filename: string): Promise<number[]>;
      verifyGpuSort(): Promise<GpuSortVerification>;
      verifyPortableRadixFixtures(): Promise<Record<string, GpuSortVerification>>;
    };
  }
}

const parameters = new URLSearchParams(location.search);
const forceWebGL = parameters.get('backend') === 'webgl';
const fixture = parameters.get('fixture') === 'real'
  ? 'millipede.sog'
  : parameters.get('fixture') === 'sh'
    ? 'minimal-sh1.sog'
    : 'minimal-no-sh.sog';
const isRealFixture = fixture === 'millipede.sog';
const status = document.querySelector<HTMLElement>('#status')!;
const diagnosticOutput = document.querySelector<HTMLElement>('#diagnostics')!;
const viewport = document.querySelector<HTMLElement>('#viewport')!;

const state: Window['__SOG_EXAMPLE__'] = window.__SOG_EXAMPLE__ = {
  state: 'loading',
  backend: null,
  fixture,
  progress: 0,
  diagnostics: null,
  loadDiagnostics: null,
  error: null,
  moveCamera: () => {},
  dispose: () => {},
  decodeFixtureTexel: async () => [],
  verifyGpuSort: async () => ({
    order: [], buckets: [], complete: false, monotonic: false, stable: false,
  }),
  verifyPortableRadixFixtures: async () => ({}),
};

state.decodeFixtureTexel = async (filename) => {
  const response = await fetch(`/${filename}`);
  const image = await new BrowserSOGImageDecoder().decode(
    new Uint8Array(await response.arrayBuffer()),
    filename,
    new AbortController().signal,
  );
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image.source as CanvasImageSource, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  } finally {
    image.close();
  }
};

async function verifyPortableKeys(keys: Uint32Array, bits: number): Promise<GpuSortVerification> {
  if (state.backend !== 'webgpu') {
    return { order: [], buckets: [...keys], complete: false, monotonic: false, stable: false };
  }
  const input = new StorageBufferAttribute(keys.length === 0 ? new Uint32Array(1) : keys, 1);
  const sorter = new PortableRadixSortBackend(keys.length, input, bits);
  try {
    if (keys.length === 0) {
      return { order: [], buckets: [], complete: true, monotonic: true, stable: true };
    }
    await sorter.sortAsync(renderer);
    const order = new Uint32Array(
      await renderer.getArrayBufferAsync(sorter.orderAttribute),
    ).slice(0, keys.length);
    const complete = new Set(order).size === keys.length
      && order.every((index) => index < keys.length);
    const monotonic = order.every((index, position) => (
      position === 0 || keys[order[position - 1]!]! <= keys[index]!
    ));
    const expected = [...keys.keys()].sort((left, right) => keys[left]! - keys[right]! || left - right);
    const stable = [...order].every((value, index) => value === expected[index]);
    return { order: [...order], buckets: [...keys], complete, monotonic, stable };
  } finally {
    sorter.dispose();
    input.dispose();
  }
}

state.verifyGpuSort = async () => verifyPortableKeys(
  Uint32Array.from([20_000, 1_000, 40_000, 20_000]),
  16,
);

state.verifyPortableRadixFixtures = async () => {
  const fixtures: Record<string, Uint32Array> = {
    empty: new Uint32Array(),
    singleton: Uint32Array.of(7),
    'duplicate-heavy': Uint32Array.from({ length: 513 }, (_, index) => index % 7),
    'partial-workgroup': Uint32Array.from(
      { length: 2_051 },
      (_, index) => ((index * 2654435761) >>> 0) & 0xfff,
    ),
    'multi-workgroup': Uint32Array.from(
      { length: 4_097 },
      (_, index) => ((index * 2246822519) >>> 0) & 0xfff,
    ),
    'full-capacity': Uint32Array.from(
      { length: 8_192 },
      (_, index) => ((index * 3266489917) >>> 0) & 0xfff,
    ),
  };
  const results: Record<string, GpuSortVerification> = {};
  for (const [name, keys] of Object.entries(fixtures)) {
    results[name] = await verifyPortableKeys(keys, 12);
  }
  return results;
};

const scene = new Scene();
scene.background = new Color(0x0c1220);
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 100);
if (isRealFixture) camera.position.set(0, 0.4, 1);
else camera.position.set(0.35, 0.25, 4);
camera.lookAt(0, 0, 0);

const renderer = new WebGPURenderer({ antialias: true, forceWebGL });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
viewport.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = false;
controls.update();

const occluder = new Mesh(
  new BoxGeometry(0.2, 0.2, 0.2),
  new MeshBasicMaterial({ color: 0xf2b84b }),
);
occluder.position.set(0.06, 0, 0.8);
occluder.visible = !isRealFixture;
scene.add(occluder);

let resource: Awaited<ReturnType<SOGLoader['loadAsync']>> | null = null;
let splats: SOGGaussianSplatMesh | null = null;
let disposed = false;

function updatePanel(): void {
  status.textContent = state.state === 'ready'
    ? `Ready · ${state.backend} · ${fixture}`
    : state.state === 'failed'
      ? `Failed · ${state.error}`
      : `${state.state} · ${Math.round(state.progress * 100)}%`;
  diagnosticOutput.textContent = state.diagnostics
    ? JSON.stringify(state.diagnostics, null, 2)
    : '';
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  splats?.dispose();
  resource?.dispose();
  controls.dispose();
  occluder.geometry.dispose();
  occluder.material.dispose();
  renderer.dispose();
  state.state = 'disposed';
  updatePanel();
}

state.dispose = dispose;
state.moveCamera = () => {
  camera.position.x += 0.25;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
};
document.querySelector('#move')?.addEventListener('click', state.moveCamera);
document.querySelector('#dispose')?.addEventListener('click', dispose);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

try {
  resource = await new SOGLoader().loadAsync(`/${fixture}`, {
    onProgress: (loaded, total) => {
      state.progress = total ? loaded / total : 0;
      updatePanel();
    },
  });
  state.loadDiagnostics = resource.diagnostics;
  state.state = 'preparing';
  updatePanel();
  splats = new SOGGaussianSplatMesh(resource);
  if (isRealFixture) {
    splats.rotation.set(Math.PI * 1.1, -Math.PI * 0.1, Math.PI * 0.15);
  } else {
    splats.scale.setScalar(0.35);
  }
  await splats.prepare(renderer);
  scene.add(splats);
  state.backend = splats.diagnostics.backend;
  state.diagnostics = splats.diagnostics;
  state.state = 'ready';
  updatePanel();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
    if (splats) state.diagnostics = splats.diagnostics;
    updatePanel();
  });
} catch (error) {
  state.state = 'failed';
  state.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  updatePanel();
  throw error;
}

addEventListener('pagehide', dispose, { once: true });
