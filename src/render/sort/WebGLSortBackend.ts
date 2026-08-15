import { Matrix4 } from 'three/webgpu';
import type { InstancedBufferAttribute } from 'three/webgpu';
import { abortError, throwIfAborted } from '../../core/errors.js';
import { createUintInstanced } from '../three-r185/adapter.js';
import { createDepthKeys } from './depth.js';
import { radixSortIndices } from './radix.js';

interface SortResult {
  type: 'sorted';
  generation: number;
  durationMs: number;
  order: ArrayBuffer;
}

export interface WebGLSortMetrics {
  onSort(durationMs: number): void;
  onUpload(): void;
}

export class WebGLSortBackend {
  readonly orderAttribute: InstancedBufferAttribute;
  readonly allocatedBytes: number;
  readonly gpuAllocatedBytes: number;
  readonly cpuAllocatedBytes: number;
  readonly #centers: Float32Array;
  readonly #metrics: WebGLSortMetrics;
  #worker: Worker | null = null;
  #generation = 0;
  #matrixKey = '';
  #recycle: ArrayBuffer | null = null;
  #disposed = false;

  constructor(centers: Float32Array, metrics: WebGLSortMetrics) {
    this.#centers = centers;
    this.#metrics = metrics;
    const count = centers.length / 3;
    this.orderAttribute = createUintInstanced(Uint32Array.from({ length: count }, (_, index) => index));
    const usesWorker = typeof Worker !== 'undefined';
    this.gpuAllocatedBytes = this.orderAttribute.array.byteLength;
    this.cpuAllocatedBytes = centers.byteLength
      + this.orderAttribute.array.byteLength
      + (usesWorker ? centers.byteLength + this.orderAttribute.array.byteLength : 0);
    this.allocatedBytes = this.gpuAllocatedBytes + this.cpuAllocatedBytes;
    if (usesWorker) {
      this.#worker = new Worker(new URL('../../workers/sort.worker.js', import.meta.url), {
        name: 'three-sog-sort',
        type: 'module',
      });
      const transfer = centers.slice().buffer;
      this.#worker.postMessage({ type: 'initialize', centers: transfer }, [transfer]);
      this.#worker.onmessage = (event: MessageEvent<SortResult>) => this.#accept(event.data);
    }
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.update(new Matrix4(), true);
    if (this.#worker) {
      const target = this.#generation;
      await new Promise<void>((resolve, reject) => {
        const worker = this.#worker;
        if (!worker) return resolve();
        const timeoutState: { value?: ReturnType<typeof globalThis.setTimeout> } = {};
        const cleanup = () => {
          if (timeoutState.value !== undefined) globalThis.clearTimeout(timeoutState.value);
          signal?.removeEventListener('abort', abort);
          worker.removeEventListener('message', listener);
          worker.removeEventListener('error', workerError);
        };
        const abort = () => {
          cleanup();
          reject(abortError('Initial SOG fallback sorting was aborted.'));
        };
        const listener = (event: MessageEvent<SortResult>) => {
          if (event.data.type === 'sorted' && event.data.generation >= target) {
            cleanup();
            resolve();
          }
        };
        const workerError = (event: ErrorEvent) => {
          cleanup();
          reject(new Error(`Initial SOG worker sort failed: ${event.message}`));
        };
        timeoutState.value = globalThis.setTimeout(() => {
          cleanup();
          reject(new Error('Timed out waiting for the initial SOG worker sort.'));
        }, 10_000);
        worker.addEventListener('message', listener);
        worker.addEventListener('error', workerError);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }

  update(matrix: Matrix4, force = false): void {
    if (this.#disposed) return;
    const key = matrix.elements.map((value) => value.toFixed(7)).join(',');
    if (!force && key === this.#matrixKey) return;
    this.#matrixKey = key;
    this.#generation += 1;
    if (this.#worker) {
      const message = {
        type: 'sort',
        generation: this.#generation,
        matrix: matrix.toArray(),
        ...(this.#recycle ? { recycle: this.#recycle } : {}),
      };
      const transfer = this.#recycle ? [this.#recycle] : [];
      this.#recycle = null;
      this.#worker.postMessage(message, transfer);
    } else {
      const startedAt = performance.now();
      const order = radixSortIndices(createDepthKeys(this.#centers, matrix));
      (this.orderAttribute.array as Uint32Array).set(order);
      this.orderAttribute.needsUpdate = true;
      this.#metrics.onSort(performance.now() - startedAt);
      this.#metrics.onUpload();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#worker?.terminate();
    this.#worker = null;
    this.#recycle = null;
    this.orderAttribute.dispose();
  }

  #accept(result: SortResult): void {
    if (result.type !== 'sorted' || this.#disposed) return;
    if (result.generation < this.#generation) {
      this.#recycle = result.order;
      return;
    }
    const order = new Uint32Array(result.order);
    (this.orderAttribute.array as Uint32Array).set(order);
    this.orderAttribute.needsUpdate = true;
    this.#recycle = result.order;
    this.#metrics.onSort(result.durationMs);
    this.#metrics.onUpload();
  }
}
