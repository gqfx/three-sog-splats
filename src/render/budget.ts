import { SOGError } from '../core/errors.js';
import type { SOGMetaV2, SOGPrepareOptions, SOGNativeImage } from '../core/types.js';
import type { WebGPURenderer } from 'three/webgpu';

export const DEFAULT_MAX_GPU_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_PROJECTED_CACHE_BYTES = 256 * 1024 * 1024;

export function projectedCacheBytes(meta: SOGMetaV2, instances: number): number {
  const count = meta.count * instances;
  const blocks = Math.max(1, Math.ceil(count / 256));
  let scanBytes = blocks * 4;
  for (let size = blocks; size > 256;) { size = Math.ceil(size / 256); scanBytes += size * 4; }
  const coefficients = meta.shN ? meta.shN.count * [0, 3, 8, 15][meta.shN.bands]! : 0;
  return meta.count * 40 + coefficients * 16 + instances * 128 + count * 36
    + count * 4 + 40 + blocks * 16 + scanBytes;
}

export function prepareBudget(options: SOGPrepareOptions) {
  const maxGpuBytes = options.maxGpuBytes ?? DEFAULT_MAX_GPU_BYTES;
  const maxProjectedCacheBytes = options.maxProjectedCacheBytes ?? DEFAULT_MAX_PROJECTED_CACHE_BYTES;
  if (!Number.isSafeInteger(maxGpuBytes) || maxGpuBytes <= 0) throw new RangeError('maxGpuBytes must be a positive safe integer.');
  if (!Number.isSafeInteger(maxProjectedCacheBytes) || maxProjectedCacheBytes < 0) throw new RangeError('maxProjectedCacheBytes must be a non-negative safe integer.');
  return { maxGpuBytes, maxProjectedCacheBytes };
}

/** The active backend's public device/context; never request a second adapter. */
export function validateDeviceImages(renderer: WebGPURenderer, images: Iterable<SOGNativeImage>): void {
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    device?: { limits: { maxTextureDimension2D: number } };
    getContext?: () => WebGL2RenderingContext;
  };
  const gl = backend.isWebGPUBackend ? undefined : backend.getContext?.();
  const maxDimension = backend.device?.limits.maxTextureDimension2D
    ?? (gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : 8192);
  for (const image of images) {
    if (image.width > maxDimension || image.height > maxDimension) {
      throw new SOGError('PREPARATION_FAILED', `SOG image "${image.filename}" exceeds the active device's ${maxDimension}-pixel texture limit.`);
    }
  }
}

export function validateDeviceBuffers(renderer: WebGPURenderer, maxBufferBytes: number): void {
  const backend = renderer.backend as unknown as {
    device?: { limits: { maxStorageBufferBindingSize?: number; maxBufferSize?: number } };
  };
  const limits = backend.device?.limits;
  const maximum = Math.min(limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024, limits?.maxBufferSize ?? 256 * 1024 * 1024);
  if (maxBufferBytes > maximum) throw new SOGError('PREPARATION_FAILED', `SOG storage buffer exceeds the active device's ${maximum}-byte buffer limit.`);
}
