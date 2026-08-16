import {
  FloatType,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  Vector3,
} from 'three/webgpu';
import type { Texture, WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  exp,
  float,
  int,
  ivec2,
  sign,
  textureLoad,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { SOGMetaV2 } from '../core/types.js';

export interface CenterDecodeTextures {
  readonly meansLow: Texture;
  readonly meansHigh: Texture;
  readonly width: number;
  readonly height: number;
}

const centerCache = new WeakMap<object, Promise<Float32Array>>();

export function unpackWebGLCenterReadback(
  rgba: Float32Array,
  width: number,
  height: number,
  count: number,
): Float32Array {
  const centers = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const readbackIndex = (height - 1 - y) * width + x;
    centers[index * 3] = rgba[readbackIndex * 4] ?? 0;
    centers[index * 3 + 1] = rgba[readbackIndex * 4 + 1] ?? 0;
    centers[index * 3 + 2] = rgba[readbackIndex * 4 + 2] ?? 0;
  }
  return centers;
}

function buildCenterMaterial(textures: CenterDecodeTextures, meta: SOGMetaV2): NodeMaterial {
  const material = new NodeMaterial();
  material.name = 'SOG means-only center decode';
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const pixel = ivec2(
      int(uv().x.mul(textures.width).floor()),
      int(uv().y.mul(textures.height).floor()),
    );
    const low = textureLoad(textures.meansLow, pixel).rgb;
    const high = textureLoad(textures.meansHigh, pixel).rgb;
    const normalized = high.mul(255).round().mul(256).add(low.mul(255).round()).div(65535);
    const logCenter = vec3(
      float(meta.means.mins[0]).add(float(meta.means.maxs[0] - meta.means.mins[0]).mul(normalized.x)),
      float(meta.means.mins[1]).add(float(meta.means.maxs[1] - meta.means.mins[1]).mul(normalized.y)),
      float(meta.means.mins[2]).add(float(meta.means.maxs[2] - meta.means.mins[2]).mul(normalized.z)),
    );
    const center = vec3(
      sign(logCenter.x).mul(exp(logCenter.x.abs()).sub(1)),
      sign(logCenter.y).mul(exp(logCenter.y.abs()).sub(1)),
      sign(logCenter.z).mul(exp(logCenter.z.abs()).sub(1)),
    );
    return vec4(center.x, center.y, center.z, 1);
  })();
  return material;
}

async function decodeCenters(
  renderer: WebGPURenderer,
  textures: CenterDecodeTextures,
  meta: SOGMetaV2,
): Promise<Float32Array> {
  const material = buildCenterMaterial(textures, meta);
  const quad = new QuadMesh(material);
  const target = new RenderTarget(textures.width, textures.height, {
    type: FloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.name = 'sog-center-readback';
  const previous = renderer.getRenderTarget();
  try {
    renderer.initRenderTarget(target);
    await renderer.compileAsync(quad, quad.camera);
    renderer.setRenderTarget(target);
    quad.render(renderer);
    const pixels = await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      textures.width,
      textures.height,
    );
    const rgba = pixels instanceof Float32Array
      ? pixels
      : new Float32Array(pixels.buffer, pixels.byteOffset, Math.floor(pixels.byteLength / 4));
    return unpackWebGLCenterReadback(rgba, textures.width, textures.height, meta.count);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    material.dispose();
  }
}

export async function getCachedCenters(
  resourceKey: object,
  renderer: WebGPURenderer,
  textures: CenterDecodeTextures,
  meta: SOGMetaV2,
): Promise<{ centers: Float32Array; didReadback: boolean }> {
  const existing = centerCache.get(resourceKey);
  if (existing) return { centers: await existing, didReadback: false };
  const promise = decodeCenters(renderer, textures, meta);
  centerCache.set(resourceKey, promise);
  try {
    return { centers: await promise, didReadback: true };
  } catch (error) {
    centerCache.delete(resourceKey);
    throw error;
  }
}

export function estimateCenterBounds(centers: Float32Array): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let index = 0; index < centers.length; index += 3) {
    min.min(new Vector3(centers[index], centers[index + 1], centers[index + 2]));
    max.max(new Vector3(centers[index], centers[index + 1], centers[index + 2]));
  }
  return { min, max };
}
