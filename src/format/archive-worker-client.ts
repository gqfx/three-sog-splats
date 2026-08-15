import { abortError, SOGError, throwIfAborted } from '../core/errors.js';
import type { ZipEntry } from './zip.js';
import { parseZipArchive } from './zip.js';

interface WorkerEntry {
  filename: string;
  compressionMethod: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  buffer: ArrayBuffer;
}

interface WorkerResponse {
  entries?: WorkerEntry[];
  error?: string;
  code?: 'INVALID_ARCHIVE' | 'UNSUPPORTED_ARCHIVE';
}

export async function parseZipArchiveAsync(
  data: ArrayBuffer,
  useWorker: boolean,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ZipEntry>> {
  throwIfAborted(signal);
  if (!useWorker || typeof Worker === 'undefined') return parseZipArchive(data);

  const worker = new Worker(new URL('../workers/archive.worker.js', import.meta.url), {
    name: 'three-sog-archive',
    type: 'module',
  });
  try {
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        signal.removeEventListener('abort', abort);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        signal.removeEventListener('abort', abort);
        reject(new SOGError('INVALID_ARCHIVE', `SOG archive worker failed: ${event.message}`, { stage: 'archive' }));
      };
      worker.postMessage(data, [data]);
    });
    if (response.error) {
      throw new SOGError(response.code ?? 'INVALID_ARCHIVE', response.error, { stage: 'archive' });
    }
    return new Map((response.entries ?? []).map((entry) => [entry.filename, {
      filename: entry.filename,
      compressionMethod: entry.compressionMethod,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      bytes: new Uint8Array(entry.buffer),
    }]));
  } finally {
    worker.terminate();
  }
}
