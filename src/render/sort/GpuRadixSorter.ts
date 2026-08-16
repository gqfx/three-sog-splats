import type {
  Box3,
  ComputeNode,
  Matrix4,
  StorageBufferAttribute,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { AdaptiveDepthKeyGenerator } from './AdaptiveDepthKeyGenerator.js';
import type { GpuSortTextures } from './AdaptiveDepthKeyGenerator.js';
import { OneSweepRadixSortBackend } from './OneSweepRadixSortBackend.js';
import { PortableRadixSortBackend } from './PortableRadixSortBackend.js';
import type { RadixSortBackend } from './backend.js';
import type { RadixBackendKind } from './backend.js';
import { selectRadixBackend } from './selection.js';
import type {
  RadixSelectionReason,
  RadixSelectionTestDependencies,
} from './selection.js';

export class GpuRadixSorter {
  readonly count: number;
  readonly kind: RadixBackendKind;
  readonly radixBits: 4 | 8;
  readonly requestedBits: number;
  readonly bits: number;
  readonly selectionReason: RadixSelectionReason;
  readonly allocatedBytes: number;
  readonly orderAttribute: StorageBufferAttribute;
  readonly computeNodes: ComputeNode[];
  readonly #keys: AdaptiveDepthKeyGenerator;
  readonly #backend: RadixSortBackend;
  #disposed = false;

  private constructor(
    keys: AdaptiveDepthKeyGenerator,
    backend: RadixSortBackend,
    selectionReason: RadixSelectionReason,
  ) {
    this.count = keys.count;
    this.kind = backend.kind;
    this.radixBits = backend.radixBits;
    this.requestedBits = keys.requestedBits;
    this.bits = keys.bits;
    this.selectionReason = selectionReason;
    this.allocatedBytes = keys.allocatedBytes + backend.allocatedBytes;
    this.orderAttribute = backend.orderAttribute;
    this.computeNodes = keys.computeNode
      ? [keys.computeNode, ...backend.computeNodes]
      : [];
    this.#keys = keys;
    this.#backend = backend;
  }

  static async create(
    renderer: WebGPURenderer,
    count: number,
    textures: GpuSortTextures,
    mins: Vector3,
    maxs: Vector3,
    bounds: Box3,
    dependencies: RadixSelectionTestDependencies = {},
  ): Promise<GpuRadixSorter> {
    const selection = await selectRadixBackend(renderer, dependencies);
    const radixBits = selection.kind === 'onesweep' ? 8 : 4;
    const keys = new AdaptiveDepthKeyGenerator(
      count,
      textures,
      mins,
      maxs,
      bounds,
      radixBits,
    );
    let backend: RadixSortBackend | null = null;
    try {
      backend = selection.kind === 'onesweep'
        ? new OneSweepRadixSortBackend(
          count,
          keys.keyAttribute,
          keys.bits,
          selection.adapterInfo!.subgroupMinSize!,
        )
        : new PortableRadixSortBackend(count, keys.keyAttribute, keys.bits);
      return new GpuRadixSorter(keys, backend, selection.reason);
    } catch (error) {
      backend?.dispose();
      keys.dispose();
      throw error;
    }
  }

  updateViewMatrix(matrix: Matrix4): void {
    this.#keys.updateViewMatrix(matrix);
  }

  sort(renderer: WebGPURenderer): void {
    if (this.computeNodes.length > 0) renderer.compute(this.computeNodes);
  }

  async sortAsync(renderer: WebGPURenderer): Promise<void> {
    if (this.computeNodes.length > 0) await renderer.computeAsync(this.computeNodes);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // The backend owns all radix nodes and the key generator owns its node.
    this.#backend.dispose();
    this.#keys.dispose();
  }
}
