import { Inflate } from 'fflate';
import { SOGError } from '../core/errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT_LENGTH = 0xffff;

export const DEFAULT_MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRIES = 256;

export interface ZipArchiveLimits {
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxEntries?: number;
}

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

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
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

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateBounded(compressed: Uint8Array, expectedSize: number): Uint8Array {
  const output = new Uint8Array(expectedSize);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (chunk.byteLength > expectedSize - written) {
      fail('Invalid ZIP archive: actual DEFLATE output exceeds the declared size.');
    }
    output.set(chunk, written);
    written += chunk.byteLength;
  });
  // Limit work between callbacks. A 1 KiB DEFLATE input chunk expands to at
  // most about 1 MiB, so a false size cannot force whole-stream decompression.
  const inputChunkSize = 1024;
  if (compressed.length === 0) inflater.push(compressed, true);
  for (let offset = 0; offset < compressed.length; offset += inputChunkSize) {
    const end = Math.min(offset + inputChunkSize, compressed.length);
    inflater.push(compressed.subarray(offset, end), end === compressed.length);
  }
  if (written !== expectedSize) fail('Invalid ZIP archive: DEFLATE output size mismatch.');
  return output;
}

export function parseZipArchive(
  data: ArrayBuffer,
  limits: ZipArchiveLimits = {},
): ReadonlyMap<string, ZipEntry> {
  if (data.byteLength < 22) fail('Invalid ZIP archive: file is too small.');

  const maxEntryBytes = positiveLimit(
    limits.maxEntryBytes,
    DEFAULT_MAX_ARCHIVE_ENTRY_BYTES,
    'maxEntryBytes',
  );
  const maxTotalBytes = positiveLimit(
    limits.maxTotalBytes,
    DEFAULT_MAX_ARCHIVE_BYTES,
    'maxTotalBytes',
  );
  const maxEntries = positiveLimit(limits.maxEntries, DEFAULT_MAX_ARCHIVE_ENTRIES, 'maxEntries');

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
  if (entryCount > maxEntries) {
    fail(`SOG ZIP archive contains ${entryCount} entries, exceeding the limit of ${maxEntries}.`);
  }
  assertRange(directoryOffset, directorySize, data.byteLength, 'central directory');
  if (directoryOffset + directorySize > eocdOffset) {
    fail('Invalid ZIP archive: central directory overlaps the end-of-central-directory record.');
  }

  // Preflight every declared output size before inflating even the first entry.
  // This keeps a late oversized entry from causing avoidable earlier allocations.
  let preflightOffset = directoryOffset;
  let totalUncompressedSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(preflightOffset, 46, data.byteLength, `central directory entry ${index}`);
    if (view.getUint32(preflightOffset, true) !== CENTRAL_SIGNATURE) {
      fail(`Invalid ZIP archive: central directory entry ${index} has an invalid signature.`);
    }
    const uncompressedSize = view.getUint32(preflightOffset + 24, true);
    const recordLength = 46
      + view.getUint16(preflightOffset + 28, true)
      + view.getUint16(preflightOffset + 30, true)
      + view.getUint16(preflightOffset + 32, true);
    assertRange(preflightOffset, recordLength, data.byteLength, `central directory entry ${index}`);
    if (uncompressedSize > maxEntryBytes) {
      fail(`SOG ZIP entry ${index} declares ${uncompressedSize} uncompressed bytes, exceeding the per-entry limit of ${maxEntryBytes}.`);
    }
    totalUncompressedSize += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressedSize) || totalUncompressedSize > maxTotalBytes) {
      fail(`SOG ZIP entries declare more than the ${maxTotalBytes}-byte uncompressed archive limit.`);
    }
    preflightOffset += recordLength;
  }
  if (preflightOffset !== directoryOffset + directorySize) {
    fail('Invalid ZIP archive: central directory size does not match its entries.');
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

    if (method === 0 && compressedSize !== uncompressedSize) {
      fail(`Invalid ZIP archive: stored size mismatch for "${filename}".`);
    }
    const compressed = new Uint8Array(data, dataOffset, compressedSize);
    let bytes: Uint8Array;
    try {
      bytes = method === 0
        ? compressed.slice()
        : inflateBounded(compressed, uncompressedSize);
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
