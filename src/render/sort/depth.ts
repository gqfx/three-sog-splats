import type { Matrix4 } from 'three/webgpu';

const bitsBuffer = new ArrayBuffer(4);
const bitsFloat = new Float32Array(bitsBuffer);
const bitsUint = new Uint32Array(bitsBuffer);

export const DEPTH_BUCKET_BITS = 16;
export const DEPTH_BUCKET_COUNT = 2 ** DEPTH_BUCKET_BITS;

export function floatToOrderedUint(value: number): number {
  bitsFloat[0] = value;
  const bits = bitsUint[0] ?? 0;
  return (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits ^ 0x80000000) >>> 0);
}

export function orderedUintToDepthBucket(key: number): number {
  return (key >>> (32 - DEPTH_BUCKET_BITS)) & (DEPTH_BUCKET_COUNT - 1);
}

export function floatToDepthBucket(value: number): number {
  return orderedUintToDepthBucket(floatToOrderedUint(value));
}

export function createDepthKeys(centers: Float32Array, viewMatrix: Matrix4): Uint32Array {
  const count = Math.floor(centers.length / 3);
  const result = new Uint32Array(count);
  const elements = viewMatrix.elements;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const x = centers[offset] ?? 0;
    const y = centers[offset + 1] ?? 0;
    const z = centers[offset + 2] ?? 0;
    const viewZ = (elements[2] ?? 0) * x + (elements[6] ?? 0) * y + (elements[10] ?? 0) * z + (elements[14] ?? 0);
    result[index] = floatToOrderedUint(viewZ);
  }
  return result;
}

export function createDepthBuckets(centers: Float32Array, viewMatrix: Matrix4): Uint32Array {
  return createDepthKeys(centers, viewMatrix).map(orderedUintToDepthBucket);
}

export function isCompleteMonotonicBucketOrder(
  buckets: Uint32Array,
  order: Uint32Array,
): boolean {
  if (order.length !== buckets.length) return false;
  const seen = new Uint8Array(buckets.length);
  let previous = 0;
  for (let destination = 0; destination < order.length; destination += 1) {
    const sourceIndex = order[destination];
    if (sourceIndex === undefined || sourceIndex >= buckets.length || seen[sourceIndex] !== 0) return false;
    const bucket = buckets[sourceIndex];
    if (bucket === undefined || (destination > 0 && bucket < previous)) return false;
    seen[sourceIndex] = 1;
    previous = bucket;
  }
  return true;
}
