import type {
  InstancedBufferGeometry,
  Matrix4,
  NodeMaterial,
  Texture,
} from 'three/webgpu';
import type {
  SOGActiveRange,
  SOGAttributeName,
  SOGBackendKind,
} from '../core/types.js';
import type { GpuRadixSorter } from './sort/GpuRadixSorter.js';
import type { WebGLSortBackend } from './sort/WebGLSortBackend.js';
import type { SOGWebGPUCache } from './SOGWebGPUCache.js';

export class SOGRenderStore {
  readonly backend: SOGBackendKind;
  readonly textures: ReadonlyMap<SOGAttributeName, Texture>;
  readonly codebook: Texture;
  readonly geometry: InstancedBufferGeometry;
  readonly material: NodeMaterial;
  readonly gpuSorter?: GpuRadixSorter;
  readonly webgpuCache?: SOGWebGPUCache;
  readonly webglSorter?: WebGLSortBackend;
  readonly activeRange: SOGActiveRange;
  #disposed = false;

  constructor(options: {
    backend: SOGBackendKind;
    textures: ReadonlyMap<SOGAttributeName, Texture>;
    codebook: Texture;
    geometry: InstancedBufferGeometry;
    material: NodeMaterial;
    gpuSorter?: GpuRadixSorter;
    webgpuCache?: SOGWebGPUCache;
    webglSorter?: WebGLSortBackend;
    count: number;
    matrix: Matrix4;
  }) {
    this.backend = options.backend;
    this.textures = options.textures;
    this.codebook = options.codebook;
    this.geometry = options.geometry;
    this.material = options.material;
    if (options.gpuSorter) this.gpuSorter = options.gpuSorter;
    if (options.webgpuCache) this.webgpuCache = options.webgpuCache;
    if (options.webglSorter) this.webglSorter = options.webglSorter;
    this.activeRange = { offset: 0, count: options.count, matrix: options.matrix };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.gpuSorter?.dispose();
    this.webgpuCache?.dispose();
    this.webglSorter?.dispose();
    this.material.dispose();
    this.geometry.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.codebook.dispose();
  }
}
