import {
  DataTexture,
  FloatType,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  NearestFilter,
  NodeMaterial,
  NoColorSpace,
  PerspectiveCamera,
  RGBAFormat,
  Texture,
  Vector3,
} from 'three/webgpu';
import type { Camera, WebGPURenderer } from 'three/webgpu';
import { CleanupStack } from '../core/cleanup.js';
import { abortError, SOGError, throwIfAborted } from '../core/errors.js';
import type {
  SOGActiveRange,
  SOGAttributeName,
  SOGMeshState,
  SOGNativeImage,
  SOGPrepareOptions,
  SOGRenderDiagnostics,
  SOGBackendKind,
} from '../core/types.js';
import type { SOGResource } from '../resource/SOGResource.js';
import { getCachedCenters } from './centers.js';
import {
  createSOGGeometry,
  createSOGMaterial,
} from './material.js';
import type { SOGMaterialTextures } from './material.js';
import { SOGRenderStore } from './SOGRenderStore.js';
import { ParallelGpuSorter } from './sort/ParallelGpuSorter.js';
import { WebGLSortBackend } from './sort/WebGLSortBackend.js';

const now = (): number => globalThis.performance?.now() ?? Date.now();

interface ThreeRendererBackendFlags {
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
}

function assertThreeWebGPURenderer(renderer: WebGPURenderer): void {
  if ((renderer as unknown as { isWebGPURenderer?: boolean })?.isWebGPURenderer !== true) {
    throw new SOGError(
      'UNSUPPORTED_RENDERER',
      'SOGGaussianSplatMesh requires Three.js WebGPURenderer; classic WebGLRenderer is not supported.',
    );
  }
}

function createSOGAttributeTexture(image: SOGNativeImage, name: string): Texture {
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

function createSOGCodebookTexture(
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

function combinedSignal(internal: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return internal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([internal, external]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  internal.addEventListener('abort', abort, { once: true });
  external.addEventListener('abort', abort, { once: true });
  if (internal.aborted || external.aborted) controller.abort();
  return controller.signal;
}

export class SOGGaussianSplatMesh extends Mesh<InstancedBufferGeometry, NodeMaterial> {
  readonly isSOGGaussianSplatMesh = true;
  readonly resource: SOGResource;
  readonly #source: SOGResource;
  readonly #diagnostics: SOGRenderDiagnostics;
  #state: SOGMeshState = 'unprepared';
  #renderer: WebGPURenderer | null = null;
  #store: SOGRenderStore | null = null;
  #preparePromise: Promise<void> | null = null;
  #prepareController: AbortController | null = null;
  #matrixKey = '';
  #firstFrameStartedAt: number | null = null;
  #firstFrameMemory: { textures: number; programs: number } | null = null;

  constructor(resource: SOGResource) {
    super(new InstancedBufferGeometry(), new NodeMaterial());
    resource.assertReady();
    this.resource = resource;
    this.#source = resource.clone();
    this.name = 'SOGGaussianSplatMesh';
    this.visible = false;
    this.frustumCulled = true;
    this.renderOrder = 1;
    this.#diagnostics = {
      backend: null,
      radixBackend: null,
      radixBits: 0,
      radixSelectionReason: null,
      prepareDurationMs: 0,
      uploadDurationMs: 0,
      compileDurationMs: 0,
      firstVisibleFrameDurationMs: 0,
      sortDurationMs: 0,
      sortCount: 0,
      readbackCount: 0,
      orderUploadCount: 0,
      activeSplatCount: resource.count,
      deferredUploadCount: 0,
      deferredCompileCount: 0,
      allocatedGpuBytes: 0,
      allocatedCpuBytes: 0,
      state: 'unprepared',
    };
  }

  get state(): SOGMeshState {
    return this.#state;
  }

  get diagnostics(): Readonly<SOGRenderDiagnostics> {
    return Object.freeze({ ...this.#diagnostics });
  }

  get activeRanges(): readonly SOGActiveRange[] {
    return this.#store ? [this.#store.activeRange] : [];
  }

  async prepare(renderer: WebGPURenderer, options: SOGPrepareOptions = {}): Promise<void> {
    assertThreeWebGPURenderer(renderer);
    if (this.#state === 'disposed') throw new SOGError('PREPARATION_FAILED', 'Cannot prepare a disposed SOG mesh.');
    if (this.#renderer && this.#renderer !== renderer) {
      throw new SOGError('RENDERER_MISMATCH', 'A prepared SOG mesh cannot be rebound to another renderer; create another mesh over the same resource.');
    }
    if (this.#state === 'ready') return;
    if (this.#preparePromise) return this.#preparePromise;
    this.#renderer = renderer;
    const controller = new AbortController();
    this.#prepareController = controller;
    const signal = combinedSignal(controller.signal, options.signal);
    this.#preparePromise = this.#prepare(renderer, signal).finally(() => {
      this.#preparePromise = null;
      this.#prepareController = null;
    });
    return this.#preparePromise;
  }

  dispose(): void {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    this.#diagnostics.state = 'disposed';
    this.visible = false;
    this.#prepareController?.abort();
    const store = this.#store;
    this.#store = null;
    if (store) store.dispose();
    else {
      this.geometry.dispose();
      this.material.dispose();
    }
    this.#source.dispose();
    this.onBeforeRender = () => {};
    this.onAfterRender = () => {};
  }

  async #prepare(renderer: WebGPURenderer, signal: AbortSignal): Promise<void> {
    const startedAt = now();
    this.#state = 'preparing';
    this.#diagnostics.state = 'preparing';
    let store: SOGRenderStore | null = null;
    const cleanup = new CleanupStack();
    try {
      this.#source.assertReady();
      throwIfAborted(signal);
      await renderer.init();
      throwIfAborted(signal);
      const backendFlags = renderer.backend as ThreeRendererBackendFlags;
      let backend: SOGBackendKind;
      if (backendFlags.isWebGPUBackend === true) backend = 'webgpu';
      else if (backendFlags.isWebGLBackend === true) backend = 'webgl';
      else throw new SOGError('UNSUPPORTED_RENDERER', 'The initialized Three.js renderer backend is not supported.');
      this.#diagnostics.backend = backend;

      const textureMap = new Map<SOGAttributeName, Texture>();
      cleanup.defer(() => {
        for (const texture of textureMap.values()) texture.dispose();
      });
      for (const [attribute, image] of this.#source.nativeImages) {
        textureMap.set(attribute, createSOGAttributeTexture(image, `sog-${attribute}`));
      }
      const codebook = createSOGCodebookTexture(
        this.#source.meta.scales.codebook,
        this.#source.meta.sh0.codebook,
        this.#source.meta.shN?.codebook,
      );
      cleanup.defer(() => codebook.dispose());
      const uploadStartedAt = now();
      for (const texture of [...textureMap.values(), codebook]) {
        throwIfAborted(signal);
        renderer.initTexture(texture);
      }
      await Promise.resolve();
      throwIfAborted(signal);
      this.#diagnostics.uploadDurationMs = now() - uploadStartedAt;

      const meansLow = textureMap.get('means_l');
      const meansHigh = textureMap.get('means_u');
      const quats = textureMap.get('quats');
      const scales = textureMap.get('scales');
      const sh0 = textureMap.get('sh0');
      if (!meansLow || !meansHigh || !quats || !scales || !sh0) {
        throw new SOGError('PREPARATION_FAILED', 'The validated SOG source is missing a required render texture.');
      }
      const meansImage = this.#source.nativeImages.get('means_l');
      if (!meansImage) throw new SOGError('PREPARATION_FAILED', 'The SOG source is missing means_l dimensions.');
      const materialTextures: SOGMaterialTextures = {
        meansLow,
        meansHigh,
        quats,
        scales,
        sh0,
        codebook,
        width: meansImage.width,
        ...(textureMap.get('shN_centroids') ? { shCentroids: textureMap.get('shN_centroids')! } : {}),
        ...(textureMap.get('shN_labels') ? { shLabels: textureMap.get('shN_labels')! } : {}),
      };

      let gpuSorter: ParallelGpuSorter | undefined;
      let webglSorter: WebGLSortBackend | undefined;
      if (backend === 'webgpu') {
        gpuSorter = new ParallelGpuSorter(
          this.#source.count,
          { meansLow, meansHigh, width: meansImage.width },
          new Vector3(...this.#source.meta.means.mins),
          new Vector3(...this.#source.meta.means.maxs),
        );
        cleanup.defer(() => gpuSorter?.dispose());
        gpuSorter.updateViewMatrix(new Matrix4());
        const sortStartedAt = now();
        await gpuSorter.sortAsync(renderer);
        this.#diagnostics.sortDurationMs = now() - sortStartedAt;
        this.#diagnostics.sortCount += 1;
      } else {
        const centerResult = await getCachedCenters(meansImage, renderer, {
          meansLow,
          meansHigh,
          width: meansImage.width,
          height: meansImage.height,
        }, this.#source.meta);
        if (centerResult.didReadback) this.#diagnostics.readbackCount += 1;
        webglSorter = new WebGLSortBackend(centerResult.centers, {
          onSort: (durationMs) => {
            this.#diagnostics.sortDurationMs = durationMs;
            this.#diagnostics.sortCount += 1;
          },
          onUpload: () => {
            this.#diagnostics.orderUploadCount += 1;
          },
        });
        cleanup.defer(() => webglSorter?.dispose());
        await webglSorter.prepare(signal);
      }
      throwIfAborted(signal);

      const orderAttribute = gpuSorter?.orderAttribute ?? webglSorter?.orderAttribute;
      if (!orderAttribute) throw new SOGError('PREPARATION_FAILED', 'No SOG sort order resource was created.');
      const geometry = createSOGGeometry(
        this.#source.count,
        this.#source.bounds,
        backend === 'webgl' ? webglSorter?.orderAttribute : undefined,
        Math.exp(Math.max(...this.#source.meta.scales.codebook.filter(Number.isFinite))),
      );
      const material = createSOGMaterial(materialTextures, this.#source.meta, orderAttribute, backend);
      cleanup.defer(() => geometry.dispose());
      cleanup.defer(() => material.dispose());
      store = new SOGRenderStore({
        backend,
        textures: textureMap,
        codebook,
        geometry,
        material,
        ...(gpuSorter ? { gpuSorter } : {}),
        ...(webglSorter ? { webglSorter } : {}),
        count: this.#source.count,
        matrix: this.matrixWorld,
      });
      cleanup.release();
      const nativeTextureBytes = [...this.#source.nativeImages.values()].reduce(
        (total, image) => total + image.width * image.height * 4,
        0,
      );
      this.#diagnostics.allocatedGpuBytes = (gpuSorter?.allocatedBytes ?? webglSorter?.gpuAllocatedBytes ?? 0)
        + nativeTextureBytes
        + (256 * 4 * 4);
      this.#diagnostics.allocatedCpuBytes = gpuSorter?.allocatedBytes
        ?? webglSorter?.cpuAllocatedBytes
        ?? 0;

      const compileStartedAt = now();
      this.geometry.dispose();
      this.material.dispose();
      this.geometry = geometry;
      this.material = material;
      this.#store = store;
      const compileMesh = new Mesh(geometry, material);
      compileMesh.frustumCulled = false;
      throwIfAborted(signal);
      await renderer.compileAsync(compileMesh, new PerspectiveCamera());
      throwIfAborted(signal);
      this.#diagnostics.compileDurationMs = now() - compileStartedAt;
      throwIfAborted(signal);

      store = null;
      this.#state = 'ready';
      this.#diagnostics.state = 'ready';
      this.#diagnostics.prepareDurationMs = now() - startedAt;
      this.visible = true;
      this.onBeforeRender = (_renderer, _scene, camera) => {
        if (this.#diagnostics.firstVisibleFrameDurationMs === 0) {
          this.#firstFrameStartedAt = now();
          this.#firstFrameMemory = {
            textures: renderer.info.memory.textures,
            programs: renderer.info.memory.programs,
          };
        }
        this.#updateSort(camera);
      };
      this.onAfterRender = () => {
        if (this.#firstFrameStartedAt !== null && this.#diagnostics.firstVisibleFrameDurationMs === 0) {
          if (this.#firstFrameMemory) {
            this.#diagnostics.deferredUploadCount = Math.max(
              0,
              renderer.info.memory.textures - this.#firstFrameMemory.textures,
            );
            this.#diagnostics.deferredCompileCount = Math.max(
              0,
              renderer.info.memory.programs - this.#firstFrameMemory.programs,
            );
          }
          this.#diagnostics.firstVisibleFrameDurationMs = Math.max(Number.EPSILON, now() - this.#firstFrameStartedAt);
          this.#firstFrameStartedAt = null;
          this.#firstFrameMemory = null;
        }
      };
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (store) store.dispose();
        else await cleanup.dispose();
      } catch (caught) {
        cleanupError = caught;
      }
      if (this.#store === store) this.#store = null;
      if ((this.#state as SOGMeshState) !== 'disposed' && store && this.geometry === store.geometry) {
        this.geometry = new InstancedBufferGeometry();
        this.material = new NodeMaterial();
      }
      if ((this.#state as SOGMeshState) !== 'disposed') {
        this.#state = 'failed';
        this.#diagnostics.state = 'failed';
      }
      this.visible = false;
      if (signal.aborted) throw abortError('SOG mesh preparation was aborted.');
      if (cleanupError) {
        throw new SOGError('PREPARATION_FAILED', 'SOG preparation and cleanup both failed.', {
          cause: new AggregateError([error, cleanupError]),
        });
      }
      if (error instanceof SOGError) throw error;
      throw new SOGError('PREPARATION_FAILED', 'Failed to prepare the SOG mesh.', { cause: error });
    }
  }

  #updateSort(camera: Camera): void {
    const renderer = this.#renderer;
    const store = this.#store;
    if (!renderer || !store || this.#state !== 'ready') return;
    this.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);
    const key = `${this.#source.version}|${view.elements.map((value) => value.toFixed(7)).join(',')}`;
    if (key === this.#matrixKey) return;
    this.#matrixKey = key;
    if (store.gpuSorter) {
      store.gpuSorter.updateViewMatrix(view);
      const startedAt = now();
      store.gpuSorter.sort(renderer);
      this.#diagnostics.sortDurationMs = now() - startedAt;
      this.#diagnostics.sortCount += 1;
    } else {
      store.webglSorter?.update(view);
    }
  }
}
