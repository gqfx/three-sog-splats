/// <reference lib="webworker" />

import { SOGError } from '../core/errors.js';
import { parseZipArchive } from '../format/zip.js';

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const entries = [...parseZipArchive(event.data).values()].map((entry) => {
      const bytes = entry.bytes.slice();
      return {
        filename: entry.filename,
        compressionMethod: entry.compressionMethod,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        buffer: bytes.buffer,
      };
    });
    self.postMessage({ entries }, { transfer: entries.map((entry) => entry.buffer) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof SOGError ? error.code : 'INVALID_ARCHIVE',
    });
  }
};

export {};
