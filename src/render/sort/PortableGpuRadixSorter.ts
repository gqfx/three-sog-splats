import { Matrix4 } from 'three/webgpu';
import type {
  ComputeNode,
  StorageBufferAttribute,
  Texture,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  Loop,
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
import { createUintStorage } from '../three-r185/adapter.js';

export interface GpuRadixTextures {
  readonly meansLow: Texture;
  readonly meansHigh: Texture;
  readonly width: number;
}

export function nextSortCapacity(count: number): number {
  return Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
}

export class PortableGpuRadixSorter {
  readonly count: number;
  readonly capacity: number;
  readonly orderAttribute: StorageBufferAttribute;
  readonly allocatedBytes: number;
  readonly viewMatrixUniform = uniform(new Matrix4());
  readonly #keyAttribute: StorageBufferAttribute;
  readonly #scratchKeyAttribute: StorageBufferAttribute;
  readonly #scratchOrderAttribute: StorageBufferAttribute;
  readonly #histogramAttribute: StorageBufferAttribute;
  readonly #computeNodes: ComputeNode[];

  constructor(count: number, textures: GpuRadixTextures, mins: Vector3, maxs: Vector3) {
    this.count = count;
    this.capacity = nextSortCapacity(count);
    this.#keyAttribute = createUintStorage(new Uint32Array(this.capacity));
    this.orderAttribute = createUintStorage(Uint32Array.from({ length: this.capacity }, (_, index) => index));
    this.#scratchKeyAttribute = createUintStorage(new Uint32Array(this.capacity));
    this.#scratchOrderAttribute = createUintStorage(new Uint32Array(this.capacity));
    this.#histogramAttribute = createUintStorage(new Uint32Array(256));
    this.allocatedBytes = (this.capacity * 4 * 4) + (256 * 4);
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
    for (const node of this.#computeNodes) node.dispose();
    this.#keyAttribute.dispose();
    this.orderAttribute.dispose();
    this.#scratchKeyAttribute.dispose();
    this.#scratchOrderAttribute.dispose();
    this.#histogramAttribute.dispose();
  }

  #buildNodes(textures: GpuRadixTextures, minsValue: Vector3, maxsValue: Vector3): ComputeNode[] {
    const count = this.count;
    const keysA = storage(this.#keyAttribute, 'uint', this.capacity);
    const valuesA = storage(this.orderAttribute, 'uint', this.capacity);
    const keysB = storage(this.#scratchKeyAttribute, 'uint', this.capacity);
    const valuesB = storage(this.#scratchOrderAttribute, 'uint', this.capacity);
    const histogram = storage(this.#histogramAttribute, 'uint', 256);
    const mins = uniform(minsValue);
    const maxs = uniform(maxsValue);
    const width = uint(textures.width);

    const generateKeys = Fn(() => {
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
      keysA.element(instanceIndex).assign(ordered);
      valuesA.element(instanceIndex).assign(instanceIndex);
    })().compute(count, [64]);
    generateKeys.setName('SOG depth-key generation');

    const nodes: ComputeNode[] = [generateKeys];
    for (let pass = 0; pass < 4; pass += 1) {
      const readKeys = pass % 2 === 0 ? keysA : keysB;
      const readValues = pass % 2 === 0 ? valuesA : valuesB;
      const writeKeys = pass % 2 === 0 ? keysB : keysA;
      const writeValues = pass % 2 === 0 ? valuesB : valuesA;
      const shift = uint(pass * 8);
      const radixPass = Fn(() => {
        Loop({ start: uint(0), end: uint(256), type: 'uint', condition: '<' }, ({ i }) => {
          histogram.element(i).assign(0);
        });
        Loop({ start: uint(0), end: uint(count), type: 'uint', condition: '<' }, ({ i }) => {
          const bucket = readKeys.element(i).shiftRight(shift).bitAnd(uint(0xff));
          histogram.element(bucket).addAssign(1);
        });
        const prefix = uint(0).toVar();
        Loop({ start: uint(0), end: uint(256), type: 'uint', condition: '<' }, ({ i }) => {
          const bucketCount = histogram.element(i).toVar();
          histogram.element(i).assign(prefix);
          prefix.addAssign(bucketCount);
        });
        Loop({ start: uint(0), end: uint(count), type: 'uint', condition: '<' }, ({ i }) => {
          const key = readKeys.element(i).toVar();
          const bucket = key.shiftRight(shift).bitAnd(uint(0xff));
          const destination = histogram.element(bucket).toVar();
          writeKeys.element(destination).assign(key);
          writeValues.element(destination).assign(readValues.element(i));
          histogram.element(bucket).addAssign(1);
        });
      })().compute(1);
      radixPass.setName(`SOG portable radix pass ${pass}`);
      nodes.push(radixPass);
    }
    return nodes;
  }
}
