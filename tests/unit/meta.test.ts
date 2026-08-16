import { describe, expect, it } from 'vitest';
import type { SOGAttributeName, SOGNativeImage } from '../../src/core/types.js';
import {
  calculateBounds,
  decodeCenter,
  parseAndValidateMeta,
  validateImageDimensions,
} from '../../src/format/meta.js';
import { parseZipArchive } from '../../src/format/zip.js';
import { codebook, createBundle, validMeta } from '../helpers/fixture-builder.js';

function nativeImage(attribute: SOGAttributeName, width: number, height: number): SOGNativeImage {
  return {
    attribute,
    filename: `${attribute}.webp`,
    width,
    height,
    source: { width, height } as unknown as TexImageSource,
    close: () => {},
  };
}

describe('SOG v2 metadata', () => {
  it('normalizes metadata and derives bounds', () => {
    const entries = parseZipArchive(createBundle());
    const meta = parseAndValidateMeta(validMeta, entries);
    expect(meta.version).toBe(2);
    expect(meta.scales.codebook).toHaveLength(256);
    expect(calculateBounds(meta).center).toEqual([0, 0, 0]);
  });

  it('patches a known null-leading legacy codebook', () => {
    const meta = structuredClone(validMeta) as any;
    meta.scales.codebook = [...codebook];
    meta.scales.codebook[0] = null;
    const parsed = parseAndValidateMeta(meta, parseZipArchive(createBundle(meta)));
    expect(parsed.scales.codebook[0]).toBeCloseTo(
      parsed.scales.codebook[1]! + (parsed.scales.codebook[1]! - parsed.scales.codebook[255]!) / 255,
    );
  });

  it('reports the logical attribute and filename when a file is missing', () => {
    const entries = parseZipArchive(createBundle(undefined, { omit: 'means_u.webp' }));
    expect(() => parseAndValidateMeta(validMeta, entries)).toThrowError(/means_u.*means_u\.webp/);
  });

  it('rejects the wrong version, count, dimensions, and codebooks', () => {
    for (const patch of [
      { version: 1 },
      { count: 0 },
      { scales: { ...validMeta.scales, codebook: [1] } },
      { means: { ...validMeta.means, mins: [0, 0] } },
      { antialias: 'yes' },
      { model: 'unsupported' },
    ]) {
      const meta = { ...validMeta, ...patch };
      expect(() => parseAndValidateMeta(meta, parseZipArchive(createBundle(meta)))).toThrowError(/Invalid SOG v2 metadata/);
    }
  });

  it('rejects incomplete spherical-harmonic descriptors', () => {
    const meta = {
      ...validMeta,
      shN: { count: 256, bands: 1, codebook, files: ['shN_centroids.webp'] },
    };
    expect(() => parseAndValidateMeta(meta, parseZipArchive(createBundle(meta)))).toThrowError(/shN\.files/);
  });

  it('validates v2 spherical-harmonic palette metadata and full-height textures', () => {
    const input = {
      ...validMeta,
      shN: {
        count: 65_536,
        bands: 2,
        codebook,
        files: ['shN_centroids.webp', 'shN_labels.webp'],
      },
    };
    const meta = parseAndValidateMeta(input, parseZipArchive(createBundle(input)));
    const images = new Map<SOGAttributeName, SOGNativeImage>([
      ['means_l', nativeImage('means_l', 2, 2)],
      ['means_u', nativeImage('means_u', 2, 2)],
      ['quats', nativeImage('quats', 2, 2)],
      ['scales', nativeImage('scales', 2, 2)],
      ['sh0', nativeImage('sh0', 2, 2)],
      ['shN_labels', nativeImage('shN_labels', 2, 2)],
      ['shN_centroids', nativeImage('shN_centroids', 512, 1024)],
    ]);
    expect(meta.shN).toMatchObject({ count: 65_536, bands: 2 });
    expect(validateImageDimensions(meta, images)).toBe(2);
  });

  it('rejects invalid spherical-harmonic palette metadata and dimensions', () => {
    for (const shN of [
      { count: 0, bands: 1 },
      { count: 65_537, bands: 1 },
      { count: 256, bands: 0 },
      { count: 256, bands: 4 },
    ]) {
      const input = {
        ...validMeta,
        shN: { ...shN, codebook, files: ['shN_centroids.webp', 'shN_labels.webp'] },
      };
      expect(() => parseAndValidateMeta(input, parseZipArchive(createBundle(input))))
        .toThrowError(/Invalid SOG v2 metadata/);
    }

    const input = {
      ...validMeta,
      shN: {
        count: 65_536,
        bands: 2,
        codebook,
        files: ['shN_centroids.webp', 'shN_labels.webp'],
      },
    };
    const meta = parseAndValidateMeta(input, parseZipArchive(createBundle(input)));
    const images = new Map<SOGAttributeName, SOGNativeImage>([
      ['means_l', nativeImage('means_l', 2, 2)],
      ['means_u', nativeImage('means_u', 2, 2)],
      ['quats', nativeImage('quats', 2, 2)],
      ['scales', nativeImage('scales', 2, 2)],
      ['sh0', nativeImage('sh0', 2, 2)],
      ['shN_labels', nativeImage('shN_labels', 2, 2)],
      ['shN_centroids', nativeImage('shN_centroids', 512, 4)],
    ]);
    expect(() => validateImageDimensions(meta, images)).toThrowError(/expected 512x1024/);
  });

  it('decodes 16-bit split means with the symmetric inverse log transform', () => {
    expect(decodeCenter([0, 0, 0], [0, 128, 255], [-1, -1, -1], [1, 1, 1]))
      .toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)]));
  });
});
