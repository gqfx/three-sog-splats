import {
  Box3,
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
  Vector2,
  Vector3,
  Vector4,
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
  SOGContributionCullingStats,
} from '../core/types.js';
import type { SOGResource } from '../resource/SOGResource.js';
import { getCachedCenters } from './centers.js';
import {
  createSOGGeometry,
  createSOGMaterial,
} from './material.js';
import type { SOGMaterialTextures } from './material.js';
import { SOGRenderStore } from './SOGRenderStore.js';
import { SOGWebGPUCache } from './SOGWebGPUCache.js';
import { DEFAULT_CONTRIBUTION_CULL_THRESHOLD } from './contribution.js';
import { GpuRadixSorter } from './sort/GpuRadixSorter.js';
import { WebGLSortBackend } from './sort/WebGLSortBackend.js';
import { prepareBudget, projectedCacheBytes, validateDeviceImages, validateDeviceBuffers } from './budget.js';

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

function isTranslationMatrix(matrix: Matrix4): boolean {
  const expected = new Matrix4().makeTranslation(
    matrix.elements[12]!,
    matrix.elements[13]!,
    matrix.elements[14]!,
  );
  return matrix.elements.every((value, index) => (
    Number.isFinite(Math.fround(value)) && Math.abs(value - expected.elements[index]!) <= 1e-8
  ));
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
  #projectionKey = '';
  #instanceTransforms: Matrix4[] = [new Matrix4()];
  #contributionCullingEnabled = true;
  #contributionCullThreshold = DEFAULT_CONTRIBUTION_CULL_THRESHOLD;
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
      staticDecodeDurationMs: 0,
      projectionWarmupDurationMs: 0,
      firstVisibleFrameDurationMs: 0,
      sortDurationMs: 0,
      sortCount: 0,
      projectionRefreshDurationMs: 0,
      projectionRefreshCount: 0,
      projectedCacheEnabled: false,
      contributionCullingEnabled: false,
      contributionCullThreshold: DEFAULT_CONTRIBUTION_CULL_THRESHOLD,
      cullingStats: null,
      cullingStatsReadbackCount: 0,
      instanceTransformCount: 1,
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

  setContributionCullingEnabled(enabled: boolean): this {
    this.#contributionCullingEnabled = enabled;
    this.#diagnostics.contributionCullingEnabled = enabled && !!this.#store?.webgpuCache;
    this.#diagnostics.cullingStats = null;
    this.#projectionKey = '';
    return this;
  }

  setContributionCullThreshold(threshold: number): this {
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new RangeError('SOG contribution cull threshold must be a finite non-negative number.');
    }
    this.#contributionCullThreshold = threshold;
    this.#diagnostics.contributionCullThreshold = threshold;
    this.#diagnostics.cullingStats = null;
    this.#projectionKey = '';
    return this;
  }

  async readContributionCullingStatsAsync(): Promise<SOGContributionCullingStats | null> {
    const renderer = this.#renderer;
    const cache = this.#store?.webgpuCache;
    if (!renderer || !cache || this.#state !== 'ready') return null;
    const stats = await cache.readCullingStatsAsync(renderer);
    this.#diagnostics.cullingStats = stats;
    this.#diagnostics.cullingStatsReadbackCount += 1;
    this.#diagnostics.readbackCount += 1;
    return stats;
  }

  /**
   * Batches translated copies into one WebGPU draw while retaining one source
   * payload and globally sorting the expanded logical stream. Call before prepare().
   */
  setInstanceTransforms(transforms: readonly Matrix4[]): this {
    if (this.#state !== 'unprepared' || this.#preparePromise) {
      throw new SOGError(
        'PREPARATION_FAILED',
        'SOG instance transforms must be configured before prepare().',
      );
    }
    if (transforms.length === 0) {
      throw new RangeError('SOG instance transforms require at least one matrix.');
    }
    if (transforms.some((matrix) => !isTranslationMatrix(matrix))) {
      throw new RangeError(
        'Batched SOG instance transforms currently support translations only.',
      );
    }
    const logicalCount = this.#source.count * transforms.length;
    if (logicalCount > 5_000_000) {
      throw new RangeError(`SOG runtime instances exceed the 5,000,000-splat limit (${logicalCount}).`);
    }
    this.#instanceTransforms = transforms.map((matrix) => matrix.clone());
    this.#diagnostics.activeSplatCount = logicalCount;
    this.#diagnostics.instanceTransformCount = transforms.length;
    return this;
  }

  async prepare(renderer: WebGPURenderer, options: SOGPrepareOptions = {}): Promise<void> {
    assertThreeWebGPURenderer(renderer);
    prepareBudget(options);
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
    this.#preparePromise = this.#prepare(renderer, signal, options).finally(() => {
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

  async #prepare(renderer: WebGPURenderer, signal: AbortSignal, options: SOGPrepareOptions): Promise<void> {
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
      validateDeviceImages(renderer, this.#source.nativeImages.values());
      const budget = prepareBudget(options);
      const logicalCount = this.#source.count * this.#instanceTransforms.length;
      const nativeBytes = [...this.#source.nativeImages.values()].reduce((sum, image) => sum + image.width * image.height * 4, 4096);
      // Conservative sort allowance includes both radix layouts and translations.
      const baseGpuBytes = nativeBytes + (backend === 'webgpu'
        ? logicalCount * 24 + 1024 * 1024 + this.#instanceTransforms.length * 16
        : logicalCount * 4);
      const cacheBytes = projectedCacheBytes(this.#source.meta, this.#instanceTransforms.length);
      const shouldCacheProjectedData = backend === 'webgpu'
        && cacheBytes <= budget.maxProjectedCacheBytes
        && baseGpuBytes + cacheBytes <= budget.maxGpuBytes;
      const hasInstanceTransform = this.#instanceTransforms.length > 1
        || !this.#instanceTransforms[0]!.equals(new Matrix4());
      if (baseGpuBytes > budget.maxGpuBytes) {
        throw new SOGError('PREPARATION_FAILED', 'SOG source and sort resources exceed maxGpuBytes.');
      }
      if (hasInstanceTransform && !shouldCacheProjectedData) {
        throw new SOGError('PREPARATION_FAILED', 'Translated SOG instances require WebGPU and sufficient projected-cache/GPU budgets.');
      }

      if (backend === 'webgpu') {
        validateDeviceBuffers(renderer, Math.max(logicalCount * (shouldCacheProjectedData ? 16 : 4),
          this.#instanceTransforms.length * (shouldCacheProjectedData ? 128 : 16),
          shouldCacheProjectedData ? (this.#source.meta.shN?.count ?? 0) * 15 * 16 : 0));
      }
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

      let gpuSorter: GpuRadixSorter | undefined;
      let webgpuCache: SOGWebGPUCache | undefined;
      let webglSorter: WebGLSortBackend | undefined;
      if (backend === 'webgpu') {
        const sourceBounds = new Box3(
          new Vector3(...this.#source.bounds.min),
          new Vector3(...this.#source.bounds.max),
        );
        const logicalBounds = new Box3().makeEmpty();
        for (const transform of this.#instanceTransforms) {
          logicalBounds.union(sourceBounds.clone().applyMatrix4(transform));
        }
        const logicalCount = this.#source.count * this.#instanceTransforms.length;
        gpuSorter = await GpuRadixSorter.create(
          renderer,
          logicalCount,
          {
            meansLow,
            meansHigh,
            width: meansImage.width,
            sourceCount: this.#source.count,
            translations: this.#instanceTransforms.map((transform) => new Vector3(
              transform.elements[12]!,
              transform.elements[13]!,
              transform.elements[14]!,
            )),
          },
          new Vector3(...this.#source.meta.means.mins),
          new Vector3(...this.#source.meta.means.maxs),
          logicalBounds,
        );
        cleanup.defer(() => gpuSorter?.dispose());
        this.#diagnostics.radixBackend = gpuSorter.kind;
        this.#diagnostics.radixBits = gpuSorter.bits;
        this.#diagnostics.radixSelectionReason = gpuSorter.selectionReason;
        gpuSorter.updateViewMatrix(new Matrix4());
        const sortStartedAt = now();
        await gpuSorter.sortAsync(renderer);
        this.#diagnostics.sortDurationMs = now() - sortStartedAt;
        this.#diagnostics.sortCount += 1;
        if (shouldCacheProjectedData) {
          webgpuCache = new SOGWebGPUCache(
            materialTextures,
            this.#source.meta,
            this.#instanceTransforms,
            gpuSorter.orderAttribute,
          );
          cleanup.defer(() => webgpuCache?.dispose());
          webgpuCache.updateCulling(
            this.#contributionCullingEnabled,
            this.#contributionCullThreshold,
            this.#source.count * this.#instanceTransforms.length,
          );
          const decodeStartedAt = now();
          await webgpuCache.decodeAsync(renderer);
          this.#diagnostics.staticDecodeDurationMs = now() - decodeStartedAt;
          const projectionWarmupStartedAt = now();
          await webgpuCache.warmProjectionAsync(renderer);
          this.#diagnostics.projectionWarmupDurationMs = now() - projectionWarmupStartedAt;
          this.#diagnostics.projectedCacheEnabled = true;
          this.#diagnostics.contributionCullingEnabled = this.#contributionCullingEnabled;
        }
      } else {
        if (this.#instanceTransforms.length > 1) {
          throw new SOGError(
            'UNSUPPORTED_RENDERER',
            'Batched SOG instance transforms require the WebGPU backend.',
          );
        }
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
        this.#source.count * this.#instanceTransforms.length,
        this.#source.bounds,
        backend === 'webgl' ? webglSorter?.orderAttribute : undefined,
        Math.exp(Math.max(...this.#source.meta.scales.codebook.filter(Number.isFinite))),
      );
      if (webgpuCache) geometry.setIndirect(webgpuCache.indirectAttribute);
      if (hasInstanceTransform && geometry.boundingBox) {
        const sourceBounds = geometry.boundingBox.clone();
        geometry.boundingBox.makeEmpty();
        for (const transform of this.#instanceTransforms) {
          geometry.boundingBox.union(sourceBounds.clone().applyMatrix4(transform));
        }
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(geometry.boundingSphere!);
      }
      const material = createSOGMaterial(
        materialTextures,
        this.#source.meta,
        orderAttribute,
        backend,
        webgpuCache?.projected,
      );
      cleanup.defer(() => geometry.dispose());
      cleanup.defer(() => material.dispose());
      store = new SOGRenderStore({
        backend,
        textures: textureMap,
        codebook,
        geometry,
        material,
        ...(gpuSorter ? { gpuSorter } : {}),
        ...(webgpuCache ? { webgpuCache } : {}),
        ...(webglSorter ? { webglSorter } : {}),
        count: this.#source.count * this.#instanceTransforms.length,
        matrix: this.matrixWorld,
      });
      cleanup.release();
      const nativeTextureBytes = [...this.#source.nativeImages.values()].reduce(
        (total, image) => total + image.width * image.height * 4,
        0,
      );
      this.#diagnostics.allocatedGpuBytes = (gpuSorter?.allocatedBytes ?? webglSorter?.gpuAllocatedBytes ?? 0)
        + (webgpuCache?.allocatedBytes ?? 0)
        + nativeTextureBytes
        + (256 * 4 * 4);
      this.#diagnostics.allocatedCpuBytes = webglSorter?.cpuAllocatedBytes
        ?? ((gpuSorter?.allocatedBytes ?? 0)
          + (webgpuCache?.allocatedBytes ?? 0)
          + (256 * 4 * 4));

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
        this.#updateForCamera(camera);
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

  #updateForCamera(camera: Camera): void {
    const renderer = this.#renderer;
    const store = this.#store;
    if (!renderer || !store || this.#state !== 'ready') return;
    this.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);
    const viewKey = `${this.#source.version}|${view.elements.map((value) => value.toFixed(7)).join(',')}`;
    if (viewKey !== this.#matrixKey) {
      this.#matrixKey = viewKey;
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
    if (store.webgpuCache) {
      const target = renderer.getRenderTarget?.();
      const viewport = new Vector2(1, 1);
      if (target) viewport.set(target.viewport.z, target.viewport.w);
      else if (typeof renderer.getViewport === 'function') {
        const rectangle = renderer.getViewport(new Vector4());
        viewport.set(rectangle.z, rectangle.w).multiplyScalar(renderer.getPixelRatio());
      } else renderer.getDrawingBufferSize?.(viewport);
      const drawLimit = Math.max(0, Math.min(
        store.webgpuCache.logicalCount,
        Math.floor(this.geometry.instanceCount),
      ));
      const projectionKey = `${viewKey}|${camera.projectionMatrix.elements
        .map((value) => value.toFixed(7)).join(',')}|${viewport.x}x${viewport.y}`
        + `|${drawLimit}|${this.#contributionCullingEnabled ? 1 : 0}`
        + `|${this.#contributionCullThreshold}`;
      if (projectionKey !== this.#projectionKey) {
        this.#projectionKey = projectionKey;
        const localCameraPosition = new Vector3()
          .setFromMatrixPosition(camera.matrixWorld)
          .applyMatrix4(this.matrixWorld.clone().invert());
        const viewProjectionModel = new Matrix4().multiplyMatrices(camera.projectionMatrix, view);
        store.webgpuCache.updateCamera(
          viewProjectionModel,
          localCameraPosition,
          viewport.x,
          viewport.y,
        );
        store.webgpuCache.updateCulling(
          this.#contributionCullingEnabled,
          this.#contributionCullThreshold,
          drawLimit,
        );
        this.#diagnostics.cullingStats = null;
        const startedAt = now();
        store.webgpuCache.project(renderer);
        this.#diagnostics.projectionRefreshDurationMs = now() - startedAt;
        this.#diagnostics.projectionRefreshCount += 1;
      }
    }
  }
}
