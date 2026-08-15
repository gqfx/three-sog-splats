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
});
