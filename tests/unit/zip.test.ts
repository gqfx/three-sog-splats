import { describe, expect, it } from 'vitest';
import { SOGError } from '../../src/core/errors.js';
import { parseZipArchive } from '../../src/format/zip.js';
import {
  createBundle,
  corruptFirstStoredEntry,
  mutateCompressionMethod,
  mutateEncryptionFlag,
  mutateZip64Marker,
} from '../helpers/fixture-builder.js';

describe('parseZipArchive', () => {
  it.each([0, 6] as const)('indexes stored/deflated entries at level %s', (level) => {
    const entries = parseZipArchive(createBundle(undefined, { level }));
    expect([...entries.keys()]).toContain('meta.json');
    expect(new TextDecoder().decode(entries.get('meta.json')?.bytes)).toContain('"version":2');
  });

  it('rejects invalid data', () => {
    expect(() => parseZipArchive(new ArrayBuffer(24))).toThrowError(SOGError);
  });

  it('rejects an unsupported compression method explicitly', () => {
    const archive = mutateCompressionMethod(createBundle(), 12);
    expect(() => parseZipArchive(archive)).toThrowError(/compression method 12/);
  });

  it('rejects encrypted and Zip64 bundles explicitly', () => {
    expect(() => parseZipArchive(mutateEncryptionFlag(createBundle()))).toThrowError(/encrypted entries/);
    expect(() => parseZipArchive(mutateZip64Marker(createBundle()))).toThrowError(/Zip64/);
  });

  it('rejects corrupt entry payloads by CRC', () => {
    expect(() => parseZipArchive(corruptFirstStoredEntry(createBundle()))).toThrowError(/CRC mismatch/);
  });

  it('rejects declared entry, total, and entry-count limits before extraction', () => {
    const archive = createBundle();
    expect(() => parseZipArchive(archive, { maxEntryBytes: 1 })).toThrowError(/per-entry limit/);
    expect(() => parseZipArchive(archive, { maxTotalBytes: 1 })).toThrowError(/archive limit/);
    expect(() => parseZipArchive(archive, { maxEntries: 1 })).toThrowError(/entries.*limit/);
  });
});

it('rejects a truncated-output CRC even when the declared budget is one byte', async () => {
  const { zipSync } = await import('fflate');
  const { crc32 } = await import('../../src/format/zip.js');
  const archive = zipSync({ 'data.bin': new Uint8Array(1024 * 1024).fill(65) }, { level: 9 });
  const view = new DataView(archive.buffer);
  for (let offset = 0; offset + 46 <= archive.length; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint32(offset + 14, crc32(Uint8Array.of(65)), true);
      view.setUint32(offset + 22, 1, true);
    }
    if (signature === 0x02014b50) {
      view.setUint32(offset + 16, crc32(Uint8Array.of(65)), true);
      view.setUint32(offset + 24, 1, true);
    }
  }
  expect(() => parseZipArchive(archive.buffer, { maxEntryBytes: 1, maxTotalBytes: 1 }))
    .toThrow(/failed to inflate/);
});

it('uses the standard CRC-32 polynomial and handles multi-chunk DEFLATE', async () => {
  const { zipSync } = await import('fflate');
  const { crc32 } = await import('../../src/format/zip.js');
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
  let seed = 7;
  const payload = Uint8Array.from({ length: 100_000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  });
  const archive = zipSync({ 'data.bin': payload }, { level: 6 });
  expect(parseZipArchive(archive.buffer).get('data.bin')!.bytes).toEqual(payload);
});
