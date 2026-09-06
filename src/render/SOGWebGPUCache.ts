import {
  Matrix4,
  StorageBufferAttribute,
  Vector3,
} from 'three/webgpu';
import type { ComputeNode, WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  clamp,
  dot,
  float,
  instanceIndex,
  int,
  ivec2,
  max,
  normalize,
  packSnorm2x16,
  sqrt,
  storage,
  textureLoad,
  uint,
  uniform,
  unpackSnorm2x16,
  uvec2,
  uvec4,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SOGMetaV2 } from '../core/types.js';
import type { SOGContributionCullingStats } from '../core/types.js';
import {
  codebookValue,
  decodeCenter,
  decodeQuaternion,
  rotateByQuaternion,
  shBasis,
  texelForIndex,
} from './material.js';
import type { SOGMaterialTextures, SOGProjectedBuffers } from './material.js';
import { SOGContributionCuller } from './SOGContributionCuller.js';

const WORKGROUP_SIZE = 256;

function packColor(color: any): any {
  const encoded: any = uvec4(clamp(color, 0, 1).mul(255).round() as any) as any;
  return encoded.x
    .bitOr(encoded.y.shiftLeft(uint(8)))
    .bitOr(encoded.z.shiftLeft(uint(16)))
    .bitOr(encoded.w.shiftLeft(uint(24)));
}

function unpackColor(encoded: any): any {
  return vec4(
    float(encoded.bitAnd(uint(0xff))),
    float(encoded.shiftRight(uint(8)).bitAnd(uint(0xff))),
    float(encoded.shiftRight(uint(16)).bitAnd(uint(0xff))),
    float(encoded.shiftRight(uint(24)).bitAnd(uint(0xff))),
  ).div(255);
}

/**
 * WebGPU-only cache which expands static SOG attributes once and refreshes
 * screen-space splat data only when the camera or model transform changes.
 */
export class SOGWebGPUCache {
  readonly sourceCount: number;
  readonly logicalCount: number;
  readonly instanceCount: number;
  readonly allocatedBytes: number;
  readonly projected: SOGProjectedBuffers;
  readonly #centers: StorageBufferAttribute;
  readonly #shapes: StorageBufferAttribute;
  readonly #sourceInfo: StorageBufferAttribute;
  readonly #shCoefficients: StorageBufferAttribute | null;
  readonly #instanceMatrices: StorageBufferAttribute;
  readonly #projectedCenters: StorageBufferAttribute;
  readonly #projectedEllipses: StorageBufferAttribute;
  readonly #projectedColors: StorageBufferAttribute;
  readonly #culler: SOGContributionCuller;
  readonly #decodeNodes: ComputeNode[];
  readonly #projectionNode: ComputeNode;
  readonly #viewProjectionModel = uniform(new Matrix4());
  readonly #localCameraPosition = uniform(new Vector3());
  #disposed = false;

  constructor(
    textures: SOGMaterialTextures,
    meta: SOGMetaV2,
    instanceTransforms: readonly Matrix4[],
    orderAttribute: StorageBufferAttribute,
  ) {
    this.sourceCount = meta.count;
    this.instanceCount = instanceTransforms.length;
    this.logicalCount = meta.count * instanceTransforms.length;
    const sourceCapacity = Math.max(1, this.sourceCount);
    const logicalCapacity = Math.max(1, this.logicalCount);
    this.#centers = new StorageBufferAttribute(new Float32Array(sourceCapacity * 4), 4);
    this.#shapes = new StorageBufferAttribute(new Uint32Array(sourceCapacity * 4), 4);
    this.#sourceInfo = new StorageBufferAttribute(new Uint32Array(sourceCapacity * 2), 2);
    const coefficientCount = meta.shN ? [0, 3, 8, 15][meta.shN.bands]! : 0;
    const coefficientCapacity = meta.shN ? meta.shN.count * coefficientCount : 0;
    this.#shCoefficients = coefficientCapacity > 0
      ? new StorageBufferAttribute(new Float32Array(coefficientCapacity * 4), 4)
      : null;
    this.#instanceMatrices = new StorageBufferAttribute(
      new Float32Array(Math.max(1, this.instanceCount) * 16 * 2),
      16,
    );
    const matrixValues = this.#instanceMatrices.array as Float32Array;
    for (let index = 0; index < instanceTransforms.length; index += 1) {
      instanceTransforms[index]!.toArray(matrixValues, index * 16);
      instanceTransforms[index]!.clone().invert().toArray(
        matrixValues,
        (this.instanceCount + index) * 16,
      );
    }
    this.#instanceMatrices.needsUpdate = true;
    this.#projectedCenters = new StorageBufferAttribute(new Float32Array(logicalCapacity * 4), 4);
    this.#projectedEllipses = new StorageBufferAttribute(new Float32Array(logicalCapacity * 4), 4);
    this.#projectedColors = new StorageBufferAttribute(new Uint32Array(logicalCapacity), 1);
    const projectedInputs = {
      centers: this.#projectedCenters,
      ellipses: this.#projectedEllipses,
      colors: this.#projectedColors,
      sourceCount: this.sourceCount,
      logicalCount: this.logicalCount,
    };
    this.#culler = new SOGContributionCuller(projectedInputs, orderAttribute);
    this.projected = {
      ...projectedInputs,
      visibleIndices: this.#culler.visibleIndices,
    };
    this.#decodeNodes = this.#buildDecodeNodes(textures, meta, coefficientCount);
    this.#projectionNode = this.#buildProjectionNode(textures, meta, coefficientCount);
    this.allocatedBytes = sourceCapacity * (4 * 4 + 4 * 4 + 2 * 4)
      + coefficientCapacity * 4 * 4
      + Math.max(1, this.instanceCount) * 16 * 4 * 2
      + logicalCapacity * (4 * 4 + 4 * 4 + 4)
      + this.#culler.allocatedBytes;
  }

  get indirectAttribute(): SOGContributionCuller['indirectAttribute'] {
    return this.#culler.indirectAttribute;
  }

  async decodeAsync(renderer: WebGPURenderer): Promise<void> {
    if (this.#decodeNodes.length > 0) await renderer.computeAsync(this.#decodeNodes);
  }

  async warmProjectionAsync(renderer: WebGPURenderer): Promise<void> {
    if (this.logicalCount > 0) {
      await renderer.computeAsync(this.#projectionNode);
      await this.#culler.computeAsync(renderer);
    }
  }

  updateCamera(
    viewProjectionModel: Matrix4,
    localCameraPosition: Vector3,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    this.#viewProjectionModel.value.copy(viewProjectionModel);
    this.#localCameraPosition.value.copy(localCameraPosition);
    this.#culler.setViewport(viewportWidth, viewportHeight);
  }

  updateCulling(enabled: boolean, threshold: number, drawLimit: number): void {
    this.#culler.setEnabled(enabled);
    this.#culler.setThreshold(threshold);
    this.#culler.setDrawLimit(drawLimit);
  }

  project(renderer: WebGPURenderer): void {
    if (this.logicalCount > 0) {
      renderer.compute(this.#projectionNode);
      this.#culler.compute(renderer);
    }
  }

  async readCullingStatsAsync(
    renderer: WebGPURenderer,
  ): Promise<SOGContributionCullingStats> {
    return this.#culler.readStatsAsync(renderer);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const node of this.#decodeNodes) node.dispose();
    this.#projectionNode.dispose();
    this.#culler.dispose();
    this.#centers.dispose();
    this.#shapes.dispose();
    this.#sourceInfo.dispose();
    this.#shCoefficients?.dispose();
    this.#instanceMatrices.dispose();
    this.#projectedCenters.dispose();
    this.#projectedEllipses.dispose();
    this.#projectedColors.dispose();
  }

  #buildDecodeNodes(
    textures: SOGMaterialTextures,
    meta: SOGMetaV2,
    coefficientCount: number,
  ): ComputeNode[] {
    if (this.sourceCount === 0) return [];
    const centers = storage(this.#centers, 'vec4', Math.max(1, this.sourceCount));
    const shapes = storage(this.#shapes, 'uvec4', Math.max(1, this.sourceCount));
    const sourceInfo = storage(this.#sourceInfo, 'uvec2', Math.max(1, this.sourceCount));
    const decodeAttributes = Fn(() => {
      const pixel = texelForIndex(instanceIndex, textures.width);
      const center = decodeCenter(textures, meta, instanceIndex);
      const quaternion = decodeQuaternion(textures, pixel);
      const encodedColor = textureLoad(textures.sh0, pixel);
      const encodedScale = textureLoad(textures.scales, pixel);
      centers.element(instanceIndex).assign(vec4(center, 1));
      shapes.element(instanceIndex).assign(uvec4(
        packSnorm2x16(quaternion.xy) as any,
        packSnorm2x16(quaternion.zw) as any,
        packColor(encodedScale),
        uint(0),
      ));
      const paletteIndex = uint(0).toVar();
      if (meta.shN && textures.shLabels) {
        const label = textureLoad(textures.shLabels, pixel).rg.mul(255).round();
        paletteIndex.assign(uint(label.x).add(uint(label.y).mul(256)));
      }
      sourceInfo.element(instanceIndex).assign(uvec2(packColor(encodedColor), paletteIndex));
    })().compute(this.sourceCount, [WORKGROUP_SIZE]);
    decodeAttributes.setName('SOG one-time static attribute dequantization');
    const nodes = [decodeAttributes];
    if (this.#shCoefficients && textures.shCentroids && meta.shN) {
      const coefficientCapacity = meta.shN.count * coefficientCount;
      const coefficients = storage(this.#shCoefficients, 'vec4', coefficientCapacity);
      const decodeCoefficients = Fn(() => {
        const paletteIndex = instanceIndex.div(uint(coefficientCount));
        const coefficientIndex = instanceIndex.mod(uint(coefficientCount));
        const x = paletteIndex.mod(64).mul(uint(coefficientCount)).add(coefficientIndex);
        const y = paletteIndex.div(64);
        const encoded = textureLoad(textures.shCentroids!, ivec2(int(x), int(y))).rgb.mul(255).round();
        coefficients.element(instanceIndex).assign(vec4(
          codebookValue(textures.codebook, encoded.x, 'b'),
          codebookValue(textures.codebook, encoded.y, 'b'),
          codebookValue(textures.codebook, encoded.z, 'b'),
          0,
        ));
      })().compute(coefficientCapacity, [WORKGROUP_SIZE]);
      decodeCoefficients.setName('SOG one-time SH palette dequantization');
      nodes.push(decodeCoefficients);
    }
    return nodes;
  }

  #buildProjectionNode(
    textures: SOGMaterialTextures,
    meta: SOGMetaV2,
    coefficientCount: number,
  ): ComputeNode {
    const sourceCapacity = Math.max(1, this.sourceCount);
    const logicalCapacity = Math.max(1, this.logicalCount);
    const centers = storage(this.#centers, 'vec4', sourceCapacity).toReadOnly();
    const shapes = storage(this.#shapes, 'uvec4', sourceCapacity).toReadOnly();
    const sourceInfo = storage(this.#sourceInfo, 'uvec2', sourceCapacity).toReadOnly();
    const coefficients = this.#shCoefficients
      ? storage(this.#shCoefficients, 'vec4', this.#shCoefficients.count).toReadOnly()
      : null;
    const instanceMatrices = storage(
      this.#instanceMatrices,
      'mat4',
      Math.max(1, this.instanceCount) * 2,
    ).toReadOnly();
    const projectedCenters = storage(this.#projectedCenters, 'vec4', logicalCapacity);
    const projectedEllipses = storage(this.#projectedEllipses, 'vec4', logicalCapacity);
    const projectedColors = storage(this.#projectedColors, 'uint', logicalCapacity);
    const node = Fn(() => {
      const sourceIndex = instanceIndex.mod(uint(this.sourceCount));
      const copyIndex = instanceIndex.div(uint(this.sourceCount));
      const center = centers.element(sourceIndex).xyz;
      const packedShape = shapes.element(sourceIndex);
      const quaternion = normalize(vec4(
        unpackSnorm2x16(packedShape.x) as any,
        unpackSnorm2x16(packedShape.y) as any,
      ));
      const scaleLabels = unpackColor(packedShape.z).rgb.mul(255).round();
      const scale = vec3(
        codebookValue(textures.codebook, scaleLabels.x, 'r').exp(),
        codebookValue(textures.codebook, scaleLabels.y, 'r').exp(),
        codebookValue(textures.codebook, scaleLabels.z, 'r').exp(),
      );
      const axisX = rotateByQuaternion(vec3(scale.x, 0, 0), quaternion);
      const axisY = rotateByQuaternion(vec3(0, scale.y, 0), quaternion);
      const axisZ = rotateByQuaternion(vec3(0, 0, scale.z), quaternion);
      const copyMatrix = instanceMatrices.element(copyIndex);
      const mvp = this.#viewProjectionModel.mul(copyMatrix);
      const centerClip = mvp.mul(vec4(center, 1)).toVar();
      const axisXClip = mvp.mul(vec4(center.add(axisX), 1));
      const axisYClip = mvp.mul(vec4(center.add(axisY), 1));
      const axisZClip = mvp.mul(vec4(center.add(axisZ), 1));
      const offsetX = axisXClip.xy.div(axisXClip.w).sub(centerClip.xy.div(centerClip.w));
      const offsetY = axisYClip.xy.div(axisYClip.w).sub(centerClip.xy.div(centerClip.w));
      const offsetZ = axisZClip.xy.div(axisZClip.w).sub(centerClip.xy.div(centerClip.w));
      const covarianceXX = dot(vec3(offsetX.x, offsetY.x, offsetZ.x), vec3(offsetX.x, offsetY.x, offsetZ.x));
      const covarianceXY = dot(vec3(offsetX.x, offsetY.x, offsetZ.x), vec3(offsetX.y, offsetY.y, offsetZ.y));
      const covarianceYY = dot(vec3(offsetX.y, offsetY.y, offsetZ.y), vec3(offsetX.y, offsetY.y, offsetZ.y));
      const discriminant = sqrt(max(0, covarianceXX.sub(covarianceYY).pow(2).add(covarianceXY.pow(2).mul(4))));
      const majorValue = max(1e-10, covarianceXX.add(covarianceYY).add(discriminant).mul(0.5));
      const minorValue = max(1e-10, covarianceXX.add(covarianceYY).sub(discriminant).mul(0.5));
      const majorDirection = normalize(vec2(covarianceXY, majorValue.sub(covarianceXX)).add(vec2(1e-10, 0)));
      const minorDirection = vec2(majorDirection.y.negate(), majorDirection.x);
      const ellipseX = majorDirection.mul(sqrt(majorValue));
      const ellipseY = minorDirection.mul(sqrt(minorValue));
      const source = sourceInfo.element(sourceIndex);
      // Keep original DC labels until SH evaluation. DC itself may lie outside
      // [0, 1]; clamping it before adding higher bands changes the final color.
      const encodedColor = unpackColor(source.x);
      const colorLabels = encodedColor.rgb.mul(255).round();
      const color = vec4(vec3(
        codebookValue(textures.codebook, colorLabels.x, 'g'),
        codebookValue(textures.codebook, colorLabels.y, 'g'),
        codebookValue(textures.codebook, colorLabels.z, 'g'),
      ).mul(0.28209479177387814).add(0.5), encodedColor.a).toVar();
      if (coefficients && meta.shN) {
        const localCamera = instanceMatrices.element(uint(this.instanceCount).add(copyIndex))
          .mul(vec4(this.#localCameraPosition, 1)).xyz;
        const basis = shBasis(normalize(localCamera.sub(center)));
        const paletteOffset = source.y.mul(uint(coefficientCount));
        for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
          color.rgb.addAssign(
            coefficients.element(paletteOffset.add(uint(coefficient))).rgb.mul(basis[coefficient]!),
          );
        }
      }
      projectedCenters.element(instanceIndex).assign(centerClip);
      projectedEllipses.element(instanceIndex).assign(vec4(ellipseX, ellipseY));
      projectedColors.element(instanceIndex).assign(packColor(vec4(clamp(color.rgb, 0, 1), color.a)));
    })().compute(this.logicalCount, [WORKGROUP_SIZE]);
    node.setName('SOG camera-change projection and SH refresh');
    return node;
  }
}
