import type {
  ComputeNode,
  StorageBufferAttribute,
  WebGPURenderer,
} from 'three/webgpu';

export type RadixBackendKind = 'portable' | 'onesweep';

export interface RadixBackendDiagnostics {
  readonly kind: RadixBackendKind;
  readonly radixBits: 4 | 8;
  readonly allocatedBytes: number;
}

/** Internal contract shared by the portable and OneSweep implementations. */
export interface RadixSortBackend extends RadixBackendDiagnostics {
  readonly count: number;
  readonly capacity: number;
  readonly orderAttribute: StorageBufferAttribute;
  readonly computeNodes: readonly ComputeNode[];
  sort(renderer: WebGPURenderer): void;
  sortAsync(renderer: WebGPURenderer): Promise<void>;
  dispose(): void;
}

/** @internal Test-only construction seam. It is not exported by the package. */
export interface RadixBackendFactory<TBackend extends RadixSortBackend = RadixSortBackend> {
  create(kind: RadixBackendKind): TBackend;
}
