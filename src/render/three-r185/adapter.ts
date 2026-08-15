import {
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  IntType,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  StorageBufferAttribute,
  Texture,
} from 'three/webgpu';
import type {
  Camera,
  ComputeNode,
  Object3D,
  RenderTarget,
  WebGPURenderer,
} from 'three/webgpu';
import { SOGError, throwIfAborted } from '../../core/errors.js';
import type {
  SOGBackendKind,
  SOGNativeImage,
} from '../../core/types.js';

interface PublicBackendFlags {
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
}

export function assertWebGPURenderer(renderer: unknown): asserts renderer is WebGPURenderer {
  if (
    typeof renderer !== 'object' ||
    renderer === null ||
    !('isWebGPURenderer' in renderer) ||
    (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer !== true
  ) {
    throw new SOGError(
      'UNSUPPORTED_RENDERER',
      'SOGGaussianSplatMesh requires Three.js r185 WebGPURenderer; classic WebGLRenderer is not supported.',
    );
  }
}

export async function initializeRenderer(renderer: WebGPURenderer): Promise<SOGBackendKind> {
  await renderer.init();
  const backend = renderer.backend as PublicBackendFlags;
  if (backend.isWebGPUBackend === true) return 'webgpu';
  if (backend.isWebGLBackend === true) return 'webgl';
  throw new SOGError('UNSUPPORTED_RENDERER', 'The initialized renderer backend is not supported by the SOG MVP.');
}

export function createNativeTexture(image: SOGNativeImage, name: string): Texture {
  const texture = new Texture(image.source);
  texture.name = name;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

export function createCodebookTexture(
  scales: readonly number[],
  sh0: readonly number[],
  shN?: readonly number[],
): DataTexture {
  const data = new Float32Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    data[index * 4] = scales[index] ?? 0;
    data[index * 4 + 1] = sh0[index] ?? 0;
    data[index * 4 + 2] = shN?.[index] ?? 0;
  }
  const texture = new DataTexture(data, 256, 1, RGBAFormat, FloatType);
  texture.name = 'sog-codebooks';
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

export function createUintStorage(values: Uint32Array): StorageBufferAttribute {
  return new StorageBufferAttribute(values, 1);
}

export function createUintInstanced(values: Uint32Array): InstancedBufferAttribute {
  const attribute = new InstancedBufferAttribute(values, 1, false);
  attribute.gpuType = IntType;
  return attribute;
}

export async function preuploadTextures(
  renderer: WebGPURenderer,
  textures: Iterable<Texture>,
  signal?: AbortSignal,
): Promise<void> {
  for (const texture of textures) {
    throwIfAborted(signal);
    renderer.initTexture(texture);
  }
  await Promise.resolve();
  throwIfAborted(signal);
}

export async function compileScene(
  renderer: WebGPURenderer,
  object: Object3D,
  camera: Camera,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await renderer.compileAsync(object, camera);
  throwIfAborted(signal);
}

export async function dispatchCompute(
  renderer: WebGPURenderer,
  nodes: ComputeNode | ComputeNode[],
  count?: number | number[],
): Promise<void> {
  await renderer.computeAsync(nodes, count);
}

export async function readRenderTarget(
  renderer: WebGPURenderer,
  target: RenderTarget,
  width: number,
  height: number,
): Promise<ArrayBufferView> {
  return renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
}
