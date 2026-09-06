import { Matrix4, StorageBufferAttribute } from 'three/webgpu';
import type {
  Box3,
  ComputeNode,
  Texture,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  clamp,
  exp,
  float,
  floor,
  instanceIndex,
  int,
  ivec2,
  sign,
  storage,
  textureLoad,
  uint,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import {
  ADAPTIVE_DEPTH_BIN_COUNT,
  cameraRelativeDepthRange,
  createAdaptiveDepthKeyConfig,
  requestedAdaptiveDepthBits,
} from './adaptive.js';

const WORKGROUP_SIZE = 256;
const BIN_EPSILON = 0.001;

export interface GpuSortTextures {
  readonly meansLow: Texture;
  readonly meansHigh: Texture;
  readonly width: number;
  /** Source splats before translated runtime copies are expanded. */
  readonly sourceCount?: number;
  /** One translation per logical copy. Omitted for a single identity copy. */
  readonly translations?: readonly Vector3[];
}

/** Generates adaptive camera-relative radix keys entirely on the GPU. */
export class AdaptiveDepthKeyGenerator {
  readonly count: number;
  readonly capacity: number;
  readonly requestedBits: number;
  readonly bits: number;
  readonly allocatedBytes: number;
  readonly keyAttribute: StorageBufferAttribute;
  readonly computeNode: ComputeNode | null;
  readonly viewMatrixUniform = uniform(new Matrix4());
  readonly #minimumDepthUniform = uniform(-0.5);
  readonly #depthRangeUniform = uniform(1);
  readonly #binWeights = uniformArray(
    Array.from({ length: ADAPTIVE_DEPTH_BIN_COUNT * 2 }, () => 0),
    'float',
  );
  readonly #bounds: Box3;
  readonly #radixBits: 4 | 8;
  readonly #translations: StorageBufferAttribute;
  #disposed = false;

  constructor(
    count: number,
    textures: GpuSortTextures,
    mins: Vector3,
    maxs: Vector3,
    bounds: Box3,
    radixBits: 4 | 8,
  ) {
    this.count = count;
    this.capacity = Math.max(1, count);
    this.requestedBits = requestedAdaptiveDepthBits(count);
    this.#radixBits = radixBits;
    this.bits = Math.ceil(this.requestedBits / radixBits) * radixBits;
    this.#bounds = bounds.clone();
    const sourceCount = textures.sourceCount ?? count;
    const copyCount = count === 0 ? 1 : Math.ceil(count / sourceCount);
    if (count > 0 && (!Number.isSafeInteger(sourceCount) || sourceCount <= 0)) {
      throw new RangeError('GPU sort source count must be a positive safe integer.');
    }
    if (textures.translations && textures.translations.length !== copyCount) {
      throw new RangeError('GPU sort translations must contain exactly one entry per logical copy.');
    }
    const translationValues = new Float32Array(Math.max(1, copyCount) * 4);
    for (let index = 0; index < (textures.translations?.length ?? 0); index += 1) {
      const translation = textures.translations![index]!;
      translationValues[index * 4] = translation.x;
      translationValues[index * 4 + 1] = translation.y;
      translationValues[index * 4 + 2] = translation.z;
    }
    this.#translations = new StorageBufferAttribute(translationValues, 4);
    this.#translations.needsUpdate = true;
    this.keyAttribute = new StorageBufferAttribute(new Uint32Array(this.capacity), 1);
    this.allocatedBytes = this.capacity * Uint32Array.BYTES_PER_ELEMENT
      + translationValues.byteLength;
    this.computeNode = count === 0 ? null : this.#buildNode(textures, mins, maxs);
    this.updateViewMatrix(new Matrix4());
  }

  updateViewMatrix(matrix: Matrix4): void {
    this.viewMatrixUniform.value.copy(matrix);
    const depth = cameraRelativeDepthRange(this.#bounds, matrix);
    const config = createAdaptiveDepthKeyConfig(
      this.count,
      this.#radixBits,
      depth.min,
      depth.max,
    );
    this.#minimumDepthUniform.value = config.min;
    this.#depthRangeUniform.value = config.range;
    for (let index = 0; index < config.binWeights.length; index += 1) {
      this.#binWeights.array[index] = config.binWeights[index];
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.computeNode?.dispose();
    this.keyAttribute.dispose();
    this.#translations.dispose();
  }

  #buildNode(textures: GpuSortTextures, minsValue: Vector3, maxsValue: Vector3): ComputeNode {
    const keys = storage(this.keyAttribute, 'uint', this.capacity);
    const sourceCount = uint(textures.sourceCount ?? this.count);
    const copyCount = Math.max(1, textures.translations?.length ?? 1);
    const translations = storage(this.#translations, 'vec4', copyCount).toReadOnly();
    const mins = uniform(minsValue);
    const maxs = uniform(maxsValue);
    const width = uint(textures.width);
    const node = Fn(() => {
      const sourceIndex = instanceIndex.mod(sourceCount);
      const copyIndex = instanceIndex.div(sourceCount);
      const pixel = ivec2(int(sourceIndex.mod(width)), int(sourceIndex.div(width)));
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
      ).add(translations.element(copyIndex).xyz);
      const viewZ = this.viewMatrixUniform.mul(vec4(center.x, center.y, center.z, 1)).z;
      const normalizedBin = clamp(
        viewZ.sub(this.#minimumDepthUniform).div(this.#depthRangeUniform)
          .mul(float(ADAPTIVE_DEPTH_BIN_COUNT)),
        float(0),
        float(ADAPTIVE_DEPTH_BIN_COUNT - BIN_EPSILON),
      ).toVar();
      const bin = uint(floor(normalizedBin)).toVar();
      const base = float(this.#binWeights.element(bin.mul(uint(2))) as any).toVar();
      const divider = float(
        this.#binWeights.element(bin.mul(uint(2)).add(uint(1))) as any,
      ).toVar();
      keys.element(instanceIndex).assign(uint(
        base.add(divider.mul(normalizedBin.sub(float(bin)))),
      ));
    })().compute(this.count, [WORKGROUP_SIZE]);
    node.setName('SOG adaptive depth-key generation');
    return node;
  }
}
