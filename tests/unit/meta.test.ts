import { describe, expect, it } from 'vitest';
import { calculateBounds, decodeCenter, parseAndValidateMeta } from '../../src/format/meta.js';
import { parseZipArchive } from '../../src/format/zip.js';
import { codebook, createBundle, validMeta } from '../helpers/fixture-builder.js';

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
      shN: { codebook, files: ['shN_centroids.webp'] },
    };
    expect(() => parseAndValidateMeta(meta, parseZipArchive(createBundle(meta)))).toThrowError(/shN\.files/);
  });

  it('decodes 16-bit split means with the symmetric inverse log transform', () => {
    expect(decodeCenter([0, 0, 0], [0, 128, 255], [-1, -1, -1], [1, 1, 1]))
      .toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)]));
  });
});
