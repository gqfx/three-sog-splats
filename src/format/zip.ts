import { inflateSync } from 'fflate';
import { SOGError } from '../core/errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT_LENGTH = 0xffff;

export interface ZipEntry {
  readonly filename: string;
  readonly compressionMethod: 0 | 8;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly bytes: Uint8Array;
}

function fail(message: string, unsupported = false): never {
  throw new SOGError(
    unsupported ? 'UNSUPPORTED_ARCHIVE' : 'INVALID_ARCHIVE',
    message,
    { stage: 'archive' },
  );
}

function assertRange(offset: number, length: number, total: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > total) {
    fail(`Invalid ZIP archive: ${label} is outside the archive bounds.`);
  }
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - (22 + MAX_COMMENT_LENGTH));
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      view.getUint32(offset, true) === EOCD_SIGNATURE
      && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength
    ) return offset;
  }
  return fail('Invalid ZIP archive: end-of-central-directory record not found.');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseZipArchive(data: ArrayBuffer): ReadonlyMap<string, ZipEntry> {
  if (data.byteLength < 22) fail('Invalid ZIP archive: file is too small.');

  const view = new DataView(data);
  const eocdOffset = findEocd(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const directoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const directorySize = view.getUint32(eocdOffset + 12, true);
  const directoryOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('Unsupported ZIP archive: multi-disk archives are not supported.', true);
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    fail('Unsupported ZIP archive: Zip64 is not supported.', true);
  }
  assertRange(directoryOffset, directorySize, data.byteLength, 'central directory');
  if (directoryOffset + directorySize > eocdOffset) {
    fail('Invalid ZIP archive: central directory overlaps the end-of-central-directory record.');
  }

  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assertRange(offset, 46, data.byteLength, `central directory entry ${index}`);
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      fail(`Invalid ZIP archive: central directory entry ${index} has an invalid signature.`);
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const recordLength = 46 + filenameLength + extraLength + commentLength;
    assertRange(offset, recordLength, data.byteLength, `central directory entry ${index}`);

    if ((flags & 0x1) !== 0) fail('Unsupported ZIP archive: encrypted entries are not supported.', true);
    if (method !== 0 && method !== 8) {
      fail(`Unsupported ZIP archive: compression method ${method} is not supported.`, true);
    }

    let filename: string;
    try {
      filename = decoder.decode(new Uint8Array(data, offset + 46, filenameLength));
    } catch (error) {
      throw new SOGError('INVALID_ARCHIVE', 'Invalid ZIP archive: filenames must be valid UTF-8.', {
        stage: 'archive',
        cause: error,
      });
    }
    if (!filename || filename.includes('\\') || filename.startsWith('/') || filename.split('/').includes('..')) {
      fail(`Invalid ZIP archive: unsafe filename "${filename}".`);
    }
    if (entries.has(filename)) fail(`Invalid ZIP archive: duplicate entry "${filename}".`);

    assertRange(localOffset, 30, data.byteLength, `local header for ${filename}`);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      fail(`Invalid ZIP archive: local header for "${filename}" has an invalid signature.`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assertRange(dataOffset, compressedSize, data.byteLength, `data for ${filename}`);
    if (localFlags !== flags || localMethod !== method) {
      fail(`Invalid ZIP archive: local header flags or compression for "${filename}" do not match its central-directory entry.`);
    }
    let localFilename: string;
    try {
      localFilename = decoder.decode(new Uint8Array(data, localOffset + 30, localNameLength));
    } catch (error) {
      throw new SOGError('INVALID_ARCHIVE', `Invalid ZIP archive: local filename for "${filename}" is not valid UTF-8.`, {
        stage: 'archive',
        cause: error,
      });
    }
    if (localFilename !== filename) {
      fail(`Invalid ZIP archive: local filename "${localFilename}" does not match "${filename}".`);
    }
    if (dataOffset + compressedSize > directoryOffset) {
      fail(`Invalid ZIP archive: data for "${filename}" overlaps the central directory.`);
    }

    const compressed = new Uint8Array(data, dataOffset, compressedSize);
    let bytes: Uint8Array;
    try {
      bytes = method === 0 ? compressed.slice() : inflateSync(compressed);
    } catch (error) {
      throw new SOGError('INVALID_ARCHIVE', `Invalid ZIP archive: failed to inflate "${filename}".`, {
        stage: 'archive',
        cause: error,
      });
    }
    if (bytes.byteLength !== uncompressedSize) {
      fail(`Invalid ZIP archive: size mismatch for "${filename}".`);
    }
    if (crc32(bytes) !== expectedCrc) {
      fail(`Invalid ZIP archive: CRC mismatch for "${filename}".`);
    }

    entries.set(filename, {
      filename,
      compressionMethod: method,
      compressedSize,
      uncompressedSize,
      bytes,
    });
    offset += recordLength;
  }

  if (offset !== directoryOffset + directorySize) {
    fail('Invalid ZIP archive: central directory size does not match its entries.');
  }
  return entries;
}
