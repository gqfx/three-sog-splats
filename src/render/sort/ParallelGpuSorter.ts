import { Matrix4, StorageBufferAttribute } from 'three/webgpu';
import type {
  ComputeNode,
  Texture,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  Loop,
  atomicAdd,
  atomicLoad,
  atomicStore,
  exp,
  floatBitsToUint,
  instanceIndex,
  int,
  ivec2,
  sign,
  storage,
  textureLoad,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { DEPTH_BUCKET_COUNT } from './depth.js';

const WORKGROUP_SIZE = 256;

export interface GpuSortTextures {
  readonly meansLow: Texture;
  readonly meansHigh: Texture;
  readonly width: number;
}

export function parallelSortAllocationBytes(count: number): number {
  const capacity = Math.max(1, count);
  return (capacity * 2 * Uint32Array.BYTES_PER_ELEMENT)
    + (DEPTH_BUCKET_COUNT * 2 * Uint32Array.BYTES_PER_ELEMENT);
}

/**
 * GPU counting sort for approximate, back-to-front splat ordering.
 *
 * The reset, histogram, and scatter stages dispatch one invocation per bucket
 * or splat. Only the fixed-size prefix scan is serial; it never scales with the
 * active splat count. Relative order inside one 16-bit depth bucket is
 * intentionally unspecified.
 */
export class ParallelGpuSorter {
  readonly count: number;
  readonly capacity: number;
  readonly orderAttribute: StorageBufferAttribute;
  readonly bucketAttribute: StorageBufferAttribute;
  readonly allocatedBytes: number;
  readonly viewMatrixUniform = uniform(new Matrix4());
  readonly #histogramAttribute: StorageBufferAttribute;
  readonly #offsetAttribute: StorageBufferAttribute;
  readonly #computeNodes: ComputeNode[];
  #disposed = false;

  constructor(count: number, textures: GpuSortTextures, mins: Vector3, maxs: Vector3) {
    this.count = count;
    this.capacity = Math.max(1, count);
    this.bucketAttribute = new StorageBufferAttribute(new Uint32Array(this.capacity), 1);
    this.orderAttribute = new StorageBufferAttribute(
      Uint32Array.from({ length: this.capacity }, (_, index) => index),
      1,
    );
    this.#histogramAttribute = new StorageBufferAttribute(new Uint32Array(DEPTH_BUCKET_COUNT), 1);
    this.#offsetAttribute = new StorageBufferAttribute(new Uint32Array(DEPTH_BUCKET_COUNT), 1);
    this.allocatedBytes = parallelSortAllocationBytes(count);
    this.#computeNodes = count === 0 ? [] : this.#buildNodes(textures, mins, maxs);
  }

  updateViewMatrix(matrix: Matrix4): void {
    this.viewMatrixUniform.value.copy(matrix);
  }

  sort(renderer: WebGPURenderer): void {
    if (this.#computeNodes.length > 0) renderer.compute(this.#computeNodes);
  }

  async sortAsync(renderer: WebGPURenderer): Promise<void> {
    if (this.#computeNodes.length > 0) await renderer.computeAsync(this.#computeNodes);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const node of this.#computeNodes) node.dispose();
    this.bucketAttribute.dispose();
    this.orderAttribute.dispose();
    this.#histogramAttribute.dispose();
    this.#offsetAttribute.dispose();
  }

  #buildNodes(textures: GpuSortTextures, minsValue: Vector3, maxsValue: Vector3): ComputeNode[] {
    const buckets = storage(this.bucketAttribute, 'uint', this.capacity);
    const order = storage(this.orderAttribute, 'uint', this.capacity);
    const histogram = storage(this.#histogramAttribute, 'uint', DEPTH_BUCKET_COUNT).toAtomic();
    const offsets = storage(this.#offsetAttribute, 'uint', DEPTH_BUCKET_COUNT).toAtomic();
    const mins = uniform(minsValue);
    const maxs = uniform(maxsValue);
    const width = uint(textures.width);

    const reset = Fn(() => {
      atomicStore(histogram.element(instanceIndex), uint(0));
      atomicStore(offsets.element(instanceIndex), uint(0));
    })().compute(DEPTH_BUCKET_COUNT, [WORKGROUP_SIZE]);
    reset.setName('SOG depth-bucket reset');

    const histogramPass = Fn(() => {
      const pixel = ivec2(int(instanceIndex.mod(width)), int(instanceIndex.div(width)));
      const low = textureLoad(textures.meansLow, pixel).rgb;
      const high = textureLoad(textures.meansHigh, pixel).rgb;
      const quantized = high.mul(255).round().mul(256).add(low.mul(255).round()).div(65535);
      const logCenter = vec3(
        mins.x.add(maxs.x.sub(mins.x).mul(quantized.x)),
        mins.y.add(maxs.y.sub(mins.y).mul(quantized.y)),
        mins.z.add(maxs.z.sub(mins.z).mul(quantized.z)),
      );
      const center = vec3(
        sign(logCenter.x).mul(exp(logCenter.x.abs()).sub(1)),
        sign(logCenter.y).mul(exp(logCenter.y.abs()).sub(1)),
        sign(logCenter.z).mul(exp(logCenter.z.abs()).sub(1)),
      );
      const viewZ = this.viewMatrixUniform.mul(vec4(center.x, center.y, center.z, 1)).z;
      // @types/three@0.185.0 omits TSL extension methods from BitcastNode.
      const bits = (floatBitsToUint(viewZ) as any).toVar();
      const ordered = bits.bitAnd(uint(0x80000000)).notEqual(0)
        .select(bits.bitNot(), bits.bitXor(uint(0x80000000)));
      const bucket = ordered.shiftRight(uint(16)).toVar();
      buckets.element(instanceIndex).assign(bucket);
      atomicAdd(histogram.element(bucket), uint(1));
    })().compute(this.count, [WORKGROUP_SIZE]);
    histogramPass.setName('SOG depth-bucket histogram');

    const prefix = Fn(() => {
      const sum = uint(0).toVar();
      Loop({ start: 0, end: DEPTH_BUCKET_COUNT, type: 'uint', condition: '<' }, ({ i }) => {
        const bucketCount = atomicLoad(histogram.element(i)).toVar();
        atomicStore(offsets.element(i), sum);
        sum.addAssign(bucketCount);
      });
    })().compute(1);
    prefix.setName('SOG depth-bucket prefix');

    const scatter = Fn(() => {
      const bucket = buckets.element(instanceIndex).toVar();
      const destination = atomicAdd(offsets.element(bucket), uint(1)).toVar();
      order.element(destination).assign(instanceIndex);
    })().compute(this.count, [WORKGROUP_SIZE]);
    scatter.setName('SOG depth-bucket scatter');

    return [reset, histogramPass, prefix, scatter];
  }
}
