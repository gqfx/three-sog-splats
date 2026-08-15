import { abortError, SOGError, throwIfAborted } from '../core/errors.js';
import type { SOGAttributeName, SOGImageDecoder, SOGNativeImage } from '../core/types.js';

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

async function decodeWithImageElement(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new SOGError('IMAGE_DECODE_FAILED', 'This environment does not provide createImageBitmap or HTML image decoding.', { stage: 'decode' });
  }
  throwIfAborted(signal);
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const abort = () => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      image.decoding = 'async';
      image.onload = () => {
        signal.removeEventListener('abort', abort);
        resolve(image);
      };
      image.onerror = () => {
        signal.removeEventListener('abort', abort);
        reject(new SOGError('IMAGE_DECODE_FAILED', 'The browser failed to decode a SOG image.', { stage: 'decode' }));
      };
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function decodeWithWorker(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  signal: AbortSignal,
): Promise<ImageBitmap> {
  const worker = new Worker(new URL('../workers/image.worker.js', import.meta.url), {
    name: 'three-sog-image',
    type: 'module',
  });
  try {
    return await new Promise<ImageBitmap>((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap; error?: string }>) => {
        signal.removeEventListener('abort', abort);
        if (event.data.bitmap) resolve(event.data.bitmap);
        else reject(new SOGError('IMAGE_DECODE_FAILED', `Failed to decode SOG image "${filename}": ${event.data.error ?? 'image worker returned no bitmap'}.`, { stage: 'decode' }));
      };
      worker.onerror = (event) => {
        signal.removeEventListener('abort', abort);
        reject(new SOGError('IMAGE_DECODE_FAILED', `SOG image worker failed for "${filename}": ${event.message}.`, { stage: 'decode' }));
      };
      const copy = bytes.slice().buffer;
      worker.postMessage({ buffer: copy, mimeType }, [copy]);
    });
  } finally {
    worker.terminate();
  }
}

async function decodeOnMainThread(blob: Blob, signal: AbortSignal): Promise<ImageBitmap | HTMLImageElement> {
  return typeof createImageBitmap === 'function'
    ? createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
        imageOrientation: 'none',
      })
    : decodeWithImageElement(blob, signal);
}

export class BrowserSOGImageDecoder implements SOGImageDecoder {
  async decode(bytes: Uint8Array, filename: string, signal: AbortSignal): Promise<SOGNativeImage> {
    throwIfAborted(signal);
    const mimeType = inferMimeType(filename);
    const blob = new Blob([bytes.slice()], { type: mimeType });
    try {
      let source: ImageBitmap | HTMLImageElement;
      if (typeof Worker !== 'undefined') {
        try {
          source = await decodeWithWorker(bytes, mimeType, filename, signal);
        } catch (workerError) {
          if (signal.aborted) throw workerError;
          source = await decodeOnMainThread(blob, signal);
        }
      } else {
        source = await decodeOnMainThread(blob, signal);
      }
      throwIfAborted(signal);
      const close = 'close' in source && typeof source.close === 'function' ? () => source.close() : () => {};
      return {
        attribute: attributeFromFilename(filename),
        filename,
        width: source.width,
        height: source.height,
        source,
        close,
      };
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof SOGError) throw error;
      throw new SOGError('IMAGE_DECODE_FAILED', `Failed to decode SOG image "${filename}".`, { stage: 'decode', cause: error });
    }
  }
}
