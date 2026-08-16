import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DataTexture,
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  array,
  atomicAdd,
  atomicLoad,
  countOneBits,
  instanceIndex,
  storage,
  subgroupBallot,
  subgroupExclusiveAdd,
  subgroupShuffle,
  textureLoad,
  workgroupArray,
  workgroupBarrier,
} from 'three/tsl';

describe('Three.js r184-r185 public API contract', () => {
  it('exports every Three.js primitive consumed directly by the renderer', () => {
    expect(WebGPURenderer).toBeTypeOf('function');
    expect(DataTexture).toBeTypeOf('function');
    expect(StorageBufferAttribute).toBeTypeOf('function');
    expect(IndirectStorageBufferAttribute).toBeTypeOf('function');
    expect(Fn).toBeTypeOf('function');
    expect(array).toBeTypeOf('function');
    expect(storage).toBeTypeOf('function');
    expect(textureLoad).toBeTypeOf('function');
    expect(atomicAdd).toBeTypeOf('function');
    expect(atomicLoad).toBeTypeOf('function');
    expect(countOneBits).toBeTypeOf('function');
    expect(subgroupBallot).toBeTypeOf('function');
    expect(subgroupExclusiveAdd).toBeTypeOf('function');
    expect(subgroupShuffle).toBeTypeOf('function');
    expect(workgroupArray).toBeTypeOf('function');
    expect(workgroupBarrier).toBeTypeOf('function');
    expect(instanceIndex).toBeDefined();
  });

  it('uses direct public Three.js imports without an adapter layer', async () => {
    const root = resolve(import.meta.dirname, '../../src');
    const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.ts'));
    for (const file of files) {
      const source = await readFile(resolve(root, file), 'utf8');
      expect(file).not.toMatch(/adapter/i);
      expect(source, file).not.toMatch(/three\/src\//);
      expect(source, file).not.toMatch(/three\/build\//);
    }
  });
});
