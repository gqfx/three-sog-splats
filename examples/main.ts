import {
  BoxGeometry,
  Color,
  DataTexture,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  NoColorSpace,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BrowserSOGImageDecoder, SOGGaussianSplatMesh, SOGLoader } from '../src/index.js';
import type { SOGLoadDiagnostics, SOGRenderDiagnostics } from '../src/index.js';
import { PortableGpuRadixSorter } from '../src/render/sort/PortableGpuRadixSorter.js';

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
      verifyGpuSort(): Promise<number[]>;
    };
  }
}

const parameters = new URLSearchParams(location.search);
const forceWebGL = parameters.get('backend') === 'webgl';
const fixture = parameters.get('fixture') === 'sh' ? 'minimal-sh1.sog' : 'minimal-no-sh.sog';
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
  verifyGpuSort: async () => [],
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

state.verifyGpuSort = async () => {
  if (state.backend !== 'webgpu') return [];
  const lowBytes = new Uint8Array(4 * 4);
  const highBytes = new Uint8Array(4 * 4);
  const quantizedZ = [20_000, 1_000, 40_000, 20_000];
  for (let index = 0; index < quantizedZ.length; index += 1) {
    const value = quantizedZ[index]!;
    lowBytes[index * 4 + 2] = value & 0xff;
    highBytes[index * 4 + 2] = value >>> 8;
    lowBytes[index * 4 + 3] = 255;
    highBytes[index * 4 + 3] = 255;
  }
  const createTexture = (data: Uint8Array) => {
    const texture = new DataTexture(data, 4, 1, RGBAFormat, UnsignedByteType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = NoColorSpace;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  };
  const meansLow = createTexture(lowBytes);
  const meansHigh = createTexture(highBytes);
  renderer.initTexture(meansLow);
  renderer.initTexture(meansHigh);
  const sorter = new PortableGpuRadixSorter(
    4,
    { meansLow, meansHigh, width: 4 },
    new Vector3(-3, -3, -3),
    new Vector3(3, 3, 3),
  );
  try {
    sorter.updateViewMatrix(new Matrix4());
    await sorter.sortAsync(renderer);
    const buffer = await renderer.getArrayBufferAsync(sorter.orderAttribute);
    return [...new Uint32Array(buffer).slice(0, 4)];
  } finally {
    sorter.dispose();
    meansLow.dispose();
    meansHigh.dispose();
  }
};

const scene = new Scene();
scene.background = new Color(0x0c1220);
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.35, 0.25, 4);
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
  splats.scale.setScalar(0.35);
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
