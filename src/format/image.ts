import { abortError, SOGError, throwIfAborted } from '../core/errors.js';
import type { SOGAttributeName, SOGImageDecoder, SOGNativeImage } from '../core/types.js';
import { readImageDimensions } from './image-dimensions.js';

function inferMimeType(filename: string): string {
  if (/\.webp$/i.test(filename)) return 'image/webp';
  if (/\.png$/i.test(filename)) return 'image/png';
  throw new SOGError('IMAGE_DECODE_FAILED', `Unsupported SOG image type for "${filename}".`, { stage: 'decode' });
}

function attributeFromFilename(filename: string): SOGAttributeName {
  const stem = filename.split('/').at(-1)?.replace(/\.[^.]+$/, '');
  const attributes: SOGAttributeName[] = ['means_l', 'means_u', 'quats', 'scales', 'sh0', 'shN_centroids', 'shN_labels'];
  return attributes.find((attribute) => attribute.toLowerCase() === stem?.toLowerCase()) ?? 'sh0';
}

function closeSource(source: ImageBitmap | HTMLImageElement | undefined): void {
  if (source && 'close' in source) source.close();
}

async function decodeWithImageElement(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new SOGError('IMAGE_DECODE_FAILED', 'This environment does not provide createImageBitmap or HTML image decoding.', { stage: 'decode' });
  }
  throwIfAborted(signal);
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        image.onload = null;
        image.onerror = null;
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(abortError());
      };
      signal.addEventListener('abort', abort, { once: true });
      image.decoding = 'async';
      image.onload = () => { cleanup(); resolve(image); };
      image.onerror = () => {
        cleanup();
        reject(new SOGError('IMAGE_DECODE_FAILED', 'The browser failed to decode a SOG image.', { stage: 'decode' }));
      };
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function decodeWithWorker(worker: Worker, bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<ImageBitmap> {
  throwIfAborted(signal);
  return new Promise<ImageBitmap>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap }>) => event.data.bitmap?.close();
      worker.onerror = null;
    };
    const abort = () => { cleanup(); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap; error?: string }>) => {
      cleanup();
      if (event.data.bitmap) resolve(event.data.bitmap);
      else reject(new Error(event.data.error ?? 'Image worker returned no bitmap.'));
    };
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message)); };
    try {
      const copy = bytes.slice().buffer;
      worker.postMessage({ buffer: copy, mimeType }, [copy]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function decodeOnMainThread(bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<ImageBitmap | HTMLImageElement> {
  throwIfAborted(signal);
  // Create the fallback Blob only if the worker cannot decode this image.
  const blob = new Blob([bytes.slice()], { type: mimeType });
  return typeof createImageBitmap === 'function'
    ? createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' })
    : decodeWithImageElement(blob, signal);
}

export class BrowserSOGImageDecoder implements SOGImageDecoder {
  readonly #reuseWorkers: boolean;
  readonly #workers = new Set<Worker>();
  readonly #idleWorkers: Worker[] = [];
  readonly #pending = new Set<AbortController>();
  #disposed = false;

  /** Loader-scoped instances reuse workers, then dispose after the decode stage. */
  constructor(reuseWorkers = false) { this.#reuseWorkers = reuseWorkers; }

  getDimensions = readImageDimensions;

  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#pending) controller.abort();
    for (const worker of this.#workers) worker.terminate();
    this.#workers.clear();
    this.#idleWorkers.length = 0;
  }

  async decode(bytes: Uint8Array, filename: string, signal: AbortSignal): Promise<SOGNativeImage> {
    throwIfAborted(signal);
    if (this.#disposed) throw new SOGError('IMAGE_DECODE_FAILED', 'The image decoder is disposed.', { stage: 'decode' });
    const mimeType = inferMimeType(filename);
    const externalSignal = signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal.addEventListener('abort', abort, { once: true });
    signal = controller.signal;
    this.#pending.add(controller);
    let source: ImageBitmap | HTMLImageElement | undefined;
    try {
      if (typeof Worker !== 'undefined') {
        let worker: Worker | undefined;
        try {
          worker = this.#idleWorkers.pop() ?? new Worker(new URL('../workers/image.worker.js', import.meta.url), {
            name: 'three-sog-image', type: 'module',
          });
          this.#workers.add(worker);
          source = await decodeWithWorker(worker, bytes, mimeType, signal);
          if (this.#reuseWorkers && !signal.aborted && !this.#disposed) {
            this.#idleWorkers.push(worker);
            worker = undefined;
          }
        } catch (workerError) {
          if (signal.aborted) throw workerError;
          source = await decodeOnMainThread(bytes, mimeType, signal);
        } finally {
          if (worker) { worker.terminate(); this.#workers.delete(worker); }
        }
      } else {
        source = await decodeOnMainThread(bytes, mimeType, signal);
      }
      throwIfAborted(signal);
      if (this.#disposed) throw new Error('The image decoder was disposed during decoding.');
      const decoded = source;
      return {
        attribute: attributeFromFilename(filename), filename,
        width: decoded.width, height: decoded.height, source: decoded,
        close: () => closeSource(decoded),
      };
    } catch (error) {
      closeSource(source);
      if (signal.aborted) throw abortError();
      if (error instanceof SOGError) throw error;
      throw new SOGError('IMAGE_DECODE_FAILED', `Failed to decode SOG image "${filename}".`, { stage: 'decode', cause: error });
    } finally {
      externalSignal.removeEventListener('abort', abort);
      this.#pending.delete(controller);
    }
  }
}
