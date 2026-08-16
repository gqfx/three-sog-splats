import { InstancedBufferAttribute, Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { SOGBounds, SOGMetaV2 } from '../../src/core/types.js';
import {
  createSOGGeometry,
  createSOGMaterial,
  type SOGMaterialTextures,
} from '../../src/render/material.js';

const meta: SOGMetaV2 = {
  version: 2,
  count: 4,
  means: { mins: [-1, -1, -1], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] },
  scales: { codebook: Array.from({ length: 256 }, () => -4), files: ['scales.webp'] },
  quats: { files: ['quats.webp'] },
  sh0: { codebook: Array.from({ length: 256 }, () => 0), files: ['sh0.webp'] },
};

const bounds: SOGBounds = {
  min: [-1, -1, -1],
  max: [1, 1, 1],
  center: [0, 0, 0],
  halfExtents: [1, 1, 1],
};

function textures(): SOGMaterialTextures {
  return {
    meansLow: new Texture(),
    meansHigh: new Texture(),
    quats: new Texture(),
    scales: new Texture(),
    sh0: new Texture(),
    codebook: new Texture(),
    width: 2,
  };
}

describe('SOG material and quad geometry', () => {
  it('uses one transparent pass and four indexed vertex corners', () => {
    const order = new InstancedBufferAttribute(new Uint32Array([0, 1, 2, 3]), 1);
    const material = createSOGMaterial(textures(), meta, order, 'webgl');
    const geometry = createSOGGeometry(meta.count, bounds, order);
    expect(material.transparent).toBe(true);
    expect(material.forceSinglePass).toBe(true);
    expect(geometry.getAttribute('position').count).toBe(4);
    expect(geometry.index?.count).toBe(6);
    material.dispose();
    geometry.dispose();
  });
});
