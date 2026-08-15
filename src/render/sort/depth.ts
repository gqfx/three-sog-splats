import type { Matrix4 } from 'three/webgpu';

const bitsBuffer = new ArrayBuffer(4);
const bitsFloat = new Float32Array(bitsBuffer);
const bitsUint = new Uint32Array(bitsBuffer);

export function floatToOrderedUint(value: number): number {
  bitsFloat[0] = value;
  const bits = bitsUint[0] ?? 0;
  return (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits ^ 0x80000000) >>> 0);
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
