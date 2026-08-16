import type { Matrix4, Texture } from 'three';

export type SOGAttributeName =
  | 'means_l'
  | 'means_u'
  | 'quats'
  | 'scales'
  | 'sh0'
  | 'shN_centroids'
  | 'shN_labels';

export type SOGVec3 = readonly [number, number, number];

export interface SOGMetaV2 {
  readonly version: 2;
  readonly count: number;
  readonly antialias?: boolean;
  readonly model?: 'antialiased' | '2dgs';
  readonly means: {
    readonly mins: SOGVec3;
    readonly maxs: SOGVec3;
    readonly files: readonly [string, string];
  };
  readonly scales: {
    readonly codebook: readonly number[];
    readonly files: readonly [string];
  };
  readonly quats: {
    readonly files: readonly [string];
  };
  readonly sh0: {
    readonly codebook: readonly number[];
    readonly files: readonly [string];
  };
  readonly shN?: {
    readonly count: number;
    readonly bands: 1 | 2 | 3;
    readonly codebook: readonly number[];
    readonly files: readonly [string, string];
  };
}

export interface SOGBounds {
  readonly min: SOGVec3;
  readonly max: SOGVec3;
  readonly center: SOGVec3;
  readonly halfExtents: SOGVec3;
}

export interface SOGNativeImage {
  readonly attribute: SOGAttributeName;
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly source: TexImageSource;
  close(): void;
}

export type SOGLoadStage =
  | 'download'
  | 'archive'
  | 'validation'
  | 'decode'
  | 'resource';

export interface SOGStageTiming {
  readonly durationMs: number;
  readonly startedAt: number;
}

export interface SOGLoadDiagnostics {
  readonly url: string;
  readonly stages: Partial<Record<SOGLoadStage, SOGStageTiming>>;
  readonly downloadedBytes: number;
  readonly archiveEntries: number;
  readonly decodedImages: number;
  readonly splatCount: number;
  readonly retainedTemporaryBytes: number;
  readonly failedStage?: SOGLoadStage;
}

export interface SOGLoadOptions {
  readonly signal?: AbortSignal;
  readonly credentials?: RequestCredentials;
  readonly headers?: HeadersInit;
  readonly onProgress?: (loaded: number, total: number | undefined) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly imageDecoder?: SOGImageDecoder;
  readonly dedupeKey?: string;
  readonly useArchiveWorker?: boolean;
}

export interface SOGImageDecoder {
  decode(
    bytes: Uint8Array,
    filename: string,
    signal: AbortSignal,
  ): Promise<SOGNativeImage>;
}

export type SOGResourceState = 'ready' | 'disposed';
export type SOGMeshState = 'unprepared' | 'preparing' | 'ready' | 'failed' | 'disposed';
export type SOGBackendKind = 'webgpu' | 'webgl';
export type SOGRadixBackendKind = 'portable' | 'onesweep';

export interface SOGPrepareOptions {
  readonly signal?: AbortSignal;
}

export interface SOGContributionCullingStats {
  readonly submitted: number;
  readonly visible: number;
  readonly behindOrAlpha: number;
  readonly outsideFrustum: number;
  readonly lowContribution: number;
}

export interface SOGRenderDiagnostics {
  backend: SOGBackendKind | null;
  radixBackend: SOGRadixBackendKind | null;
  radixBits: number;
  radixSelectionReason: string | null;
  prepareDurationMs: number;
  uploadDurationMs: number;
  compileDurationMs: number;
  staticDecodeDurationMs: number;
  projectionWarmupDurationMs: number;
  firstVisibleFrameDurationMs: number;
  sortDurationMs: number;
  sortCount: number;
  projectionRefreshDurationMs: number;
  projectionRefreshCount: number;
  projectedCacheEnabled: boolean;
  contributionCullingEnabled: boolean;
  contributionCullThreshold: number;
  cullingStats: SOGContributionCullingStats | null;
  cullingStatsReadbackCount: number;
  instanceTransformCount: number;
  readbackCount: number;
  orderUploadCount: number;
  activeSplatCount: number;
  deferredUploadCount: number;
  deferredCompileCount: number;
  allocatedGpuBytes: number;
  allocatedCpuBytes: number;
  state: SOGMeshState;
}

export interface SOGActiveRange {
  readonly offset: number;
  readonly count: number;
  readonly matrix: Matrix4;
}

export interface PreparedSOGTextures {
  readonly attributes: ReadonlyMap<SOGAttributeName, Texture>;
  readonly codebook: Texture;
}

export const SOG_MVP_MAX_SPLATS = 5_000_000;
export const SOG_MVP_ESTIMATED_BYTES_PER_SPLAT = 52;
