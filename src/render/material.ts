import {
  Box3,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  NodeMaterial,
  NormalBlending,
  Sphere,
  Vector3,
} from 'three/webgpu';
import type {
  InstancedBufferAttribute,
  StorageBufferAttribute,
  Texture,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  clamp,
  cross,
  dot,
  exp,
  float,
  int,
  instanceIndex,
  ivec2,
  max,
  modelViewMatrix,
  modelWorldMatrixInverse,
  normalize,
  sqrt,
  storage,
  textureLoad,
  uint,
  unpackHalf2x16,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SOGBounds, SOGMetaV2 } from '../core/types.js';

export interface SOGMaterialTextures {
  readonly meansLow: Texture;
  readonly meansHigh: Texture;
  readonly quats: Texture;
  readonly scales: Texture;
  readonly sh0: Texture;
  readonly shCentroids?: Texture;
  readonly shLabels?: Texture;
  readonly codebook: Texture;
  readonly width: number;
}

export interface SOGProjectedBuffers {
  readonly centers: StorageBufferAttribute;
  readonly ellipses: StorageBufferAttribute;
  readonly colors: StorageBufferAttribute;
  readonly visibleIndices: StorageBufferAttribute;
  readonly sourceCount: number;
  readonly logicalCount: number;
}

export function texelForIndex(index: any, width: number): any {
  return ivec2(int(index.mod(uint(width))), int(index.div(uint(width))));
}

export function codebookValue(codebook: Texture, index: any, channel: 'r' | 'g' | 'b'): any {
  return textureLoad(codebook, ivec2(int(index), int(0)))[channel];
}

export function decodeCenter(textures: SOGMaterialTextures, meta: SOGMetaV2, index: any): any {
  const pixel = texelForIndex(index, textures.width);
  const low = textureLoad(textures.meansLow, pixel).rgb;
  const high = textureLoad(textures.meansHigh, pixel).rgb;
  const normalized = high.mul(255).round().mul(256).add(low.mul(255).round()).div(65535);
  const logCenter = vec3(
    float(meta.means.mins[0]).add(float(meta.means.maxs[0] - meta.means.mins[0]).mul(normalized.x)),
    float(meta.means.mins[1]).add(float(meta.means.maxs[1] - meta.means.mins[1]).mul(normalized.y)),
    float(meta.means.mins[2]).add(float(meta.means.maxs[2] - meta.means.mins[2]).mul(normalized.z)),
  );
  return vec3(
    logCenter.x.sign().mul(exp(logCenter.x.abs()).sub(1)),
    logCenter.y.sign().mul(exp(logCenter.y.abs()).sub(1)),
    logCenter.z.sign().mul(exp(logCenter.z.abs()).sub(1)),
  );
}

export function rotateByQuaternion(vector: any, quaternion: any): any {
  const twice = cross(quaternion.xyz, vector).add(quaternion.w.mul(vector)).mul(2);
  return vector.add(cross(quaternion.xyz, twice));
}

export function decodeQuaternion(textures: SOGMaterialTextures, pixel: any): any {
  const encoded = textureLoad(textures.quats, pixel);
  const abc = encoded.xyz.sub(0.5).mul(Math.SQRT2);
  const missing = sqrt(max(0, float(1).sub(dot(abc, abc))));
  const mode = uint(encoded.w.mul(255).round()).sub(252);
  const quaternion = mode.equal(0).select(
    vec4(abc.x, abc.y, abc.z, missing),
    mode.equal(1).select(
      vec4(missing, abc.y, abc.z, abc.x),
      mode.equal(2).select(
        vec4(abc.y, missing, abc.z, abc.x),
        vec4(abc.y, abc.z, missing, abc.x),
      ),
    ),
  );
  return normalize(quaternion);
}

export function decodeScale(textures: SOGMaterialTextures, pixel: any): any {
  const encoded = textureLoad(textures.scales, pixel).rgb.mul(255).round();
  return vec3(
    exp(codebookValue(textures.codebook, encoded.x, 'r')),
    exp(codebookValue(textures.codebook, encoded.y, 'r')),
    exp(codebookValue(textures.codebook, encoded.z, 'r')),
  );
}

export function shBasis(direction: any): any[] {
  const x = direction.x;
  const y = direction.y;
  const z = direction.z;
  return [
    float(-0.4886025119029199).mul(y),
    float(0.4886025119029199).mul(z),
    float(-0.4886025119029199).mul(x),
    float(1.0925484305920792).mul(x).mul(y),
    float(-1.0925484305920792).mul(y).mul(z),
    float(0.31539156525252005).mul(float(3).mul(z).mul(z).sub(1)),
    float(-1.0925484305920792).mul(x).mul(z),
    float(0.5462742152960396).mul(x.mul(x).sub(y.mul(y))),
    float(-0.5900435899266435).mul(y).mul(float(3).mul(x.mul(x)).sub(y.mul(y))),
    float(2.890611442640554).mul(x).mul(y).mul(z),
    float(-0.4570457994644658).mul(y).mul(float(5).mul(z.mul(z)).sub(1)),
    float(0.3731763325901154).mul(z).mul(float(5).mul(z.mul(z)).sub(3)),
    float(-0.4570457994644658).mul(x).mul(float(5).mul(z.mul(z)).sub(1)),
    float(1.445305721320277).mul(z).mul(x.mul(x).sub(y.mul(y))),
    float(-0.5900435899266435).mul(x).mul(x.mul(x).sub(float(3).mul(y.mul(y)))),
  ];
}

function decodeColor(
  textures: SOGMaterialTextures,
  meta: SOGMetaV2,
  index: any,
  center: any,
): any {
  const pixel = texelForIndex(index, textures.width);
  const encoded = textureLoad(textures.sh0, pixel);
  const labels = encoded.rgb.mul(255).round();
  const result = vec3(
    codebookValue(textures.codebook, labels.x, 'g'),
    codebookValue(textures.codebook, labels.y, 'g'),
    codebookValue(textures.codebook, labels.z, 'g'),
  ).mul(0.28209479177387814).add(0.5).toVar();

  if (meta.shN && textures.shCentroids && textures.shLabels) {
    const label = textureLoad(textures.shLabels, pixel).rg.mul(255).round();
    const paletteIndex = uint(label.x).add(uint(label.y).mul(256));
    const coefficientCount = [0, 3, 8, 15][meta.shN.bands]!;
    const localCameraPosition = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const direction = normalize(localCameraPosition.sub(center));
    const basis = shBasis(direction);
    for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
      const x = paletteIndex.mod(64).mul(coefficientCount).add(coefficient);
      const y = paletteIndex.div(64);
      const encodedCoefficient = textureLoad(textures.shCentroids, ivec2(int(x), int(y))).rgb.mul(255).round();
      const value = vec3(
        codebookValue(textures.codebook, encodedCoefficient.x, 'b'),
        codebookValue(textures.codebook, encodedCoefficient.y, 'b'),
        codebookValue(textures.codebook, encodedCoefficient.z, 'b'),
      );
      result.addAssign(value.mul(basis[coefficient]!));
    }
  }
  return vec4(clamp(result, 0, 1), encoded.a);
}

export function createSOGMaterial(
  textures: SOGMaterialTextures,
  meta: SOGMetaV2,
  orderAttribute: StorageBufferAttribute | InstancedBufferAttribute,
  backend: 'webgpu' | 'webgl',
  projected?: SOGProjectedBuffers,
): NodeMaterial {
  const order = backend === 'webgpu'
    ? storage(orderAttribute as StorageBufferAttribute, 'uint', meta.count)
    : null;
  const material = new NodeMaterial();
  material.name = `SOG v2 (${meta.shN ? 'SH' : 'no-SH'})`;
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = false;
  material.side = DoubleSide;
  // Gaussian quads are flat sprites. Rendering transparent DoubleSide material
  // in two passes repeats all vertex work while the back-face pass contributes
  // no additional coverage.
  material.forceSinglePass = true;
  material.blending = NormalBlending;

  material.vertexNode = Fn(() => {
    const corner = (attribute('position', 'vec3') as any).xy;
    if (backend === 'webgpu' && projected) {
      const projectedCenters = storage(projected.centers, 'vec4', projected.logicalCount).toReadOnly();
      const projectedEllipses = storage(projected.ellipses, 'uvec2', projected.logicalCount).toReadOnly();
      const projectedColors = storage(projected.colors, 'uint', projected.logicalCount).toReadOnly();
      const visibleIndices = storage(projected.visibleIndices, 'uint', projected.logicalCount).toReadOnly();
      const logicalIndex = visibleIndices.element(instanceIndex);
      const copyIndex = logicalIndex.div(uint(projected.sourceCount));
      const sourceOrderIndex = logicalIndex.mod(uint(projected.sourceCount));
      const sourceIndex = order!.element(sourceOrderIndex);
      const projectedIndex = copyIndex.mul(uint(projected.sourceCount)).add(sourceIndex);
      const centerClip = projectedCenters.element(projectedIndex).toVar();
      const packedEllipse = projectedEllipses.element(projectedIndex);
      const ellipseX = unpackHalf2x16(packedEllipse.x) as any;
      const ellipseY = unpackHalf2x16(packedEllipse.y) as any;
      centerClip.xy.addAssign(
        ellipseX.mul(corner.x).add(ellipseY.mul(corner.y)).mul(centerClip.w).mul(2),
      );
      const packedColor = projectedColors.element(projectedIndex);
      const color = vec4(
        float(packedColor.bitAnd(uint(0xff))),
        float(packedColor.shiftRight(uint(8)).bitAnd(uint(0xff))),
        float(packedColor.shiftRight(uint(16)).bitAnd(uint(0xff))),
        float(packedColor.shiftRight(uint(24)).bitAnd(uint(0xff))),
      ).div(255);
      varyingProperty('vec2', 'sogCorner').assign(corner);
      varyingProperty('vec4', 'sogColor').assign(color);
      return centerClip;
    }
    const sourceIndex = backend === 'webgpu'
      ? order!.element(instanceIndex)
      : attribute('sogOrder', 'uint');
    const pixel = texelForIndex(sourceIndex, textures.width);
    const center = decodeCenter(textures, meta, sourceIndex);
    const quaternion = decodeQuaternion(textures, pixel);
    const scale = decodeScale(textures, pixel);
    const axisX = rotateByQuaternion(vec3(scale.x, 0, 0), quaternion);
    const axisY = rotateByQuaternion(vec3(0, scale.y, 0), quaternion);
    const axisZ = rotateByQuaternion(vec3(0, 0, scale.z), quaternion);
    const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
    const centerClip = mvp.mul(vec4(center.x, center.y, center.z, 1)).toVar();
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
    centerClip.xy.addAssign(ellipseX.mul(corner.x).add(ellipseY.mul(corner.y)).mul(centerClip.w).mul(2));
    varyingProperty('vec2', 'sogCorner').assign(corner);
    varyingProperty('vec4', 'sogColor').assign(decodeColor(textures, meta, sourceIndex, center));
    return centerClip;
  })();

  material.fragmentNode = Fn(() => {
    const corner = varyingProperty('vec2', 'sogCorner');
    const color = varyingProperty('vec4', 'sogColor');
    const radiusSquared = dot(corner, corner);
    radiusSquared.greaterThan(1).discard();
    const alpha = color.a.mul(exp(radiusSquared.mul(-4)));
    alpha.lessThan(float(1 / 255)).discard();
    return vec4(color.rgb, alpha);
  })();
  return material;
}

export function createSOGGeometry(
  count: number,
  bounds: SOGBounds,
  orderAttribute?: InstancedBufferAttribute,
  maxScale = 0,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
  ], 3));
  // Reuse the four quad corners instead of invoking the vertex shader for six
  // duplicated non-indexed vertices per splat.
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  if (orderAttribute) geometry.setAttribute('sogOrder', orderAttribute);
  geometry.instanceCount = count;
  const coverageRadius = maxScale * 2;
  geometry.boundingBox = new Box3(
    new Vector3(...bounds.min).addScalar(-coverageRadius),
    new Vector3(...bounds.max).addScalar(coverageRadius),
  );
  geometry.boundingSphere = new Sphere(
    new Vector3(...bounds.center),
    Math.hypot(
      bounds.halfExtents[0] + coverageRadius,
      bounds.halfExtents[1] + coverageRadius,
      bounds.halfExtents[2] + coverageRadius,
    ),
  );
  return geometry;
}
