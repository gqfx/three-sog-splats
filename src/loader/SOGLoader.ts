import { abortError, isAbortError, SOGError, throwIfAborted } from '../core/errors.js';
import { CleanupStack } from '../core/cleanup.js';
import { LoadDiagnosticsBuilder } from '../core/diagnostics.js';
import type {
  SOGAttributeName,
  SOGImageDecoder,
  SOGLoadOptions,
  SOGNativeImage,
} from '../core/types.js';
import { SOG_MVP_MAX_SPLATS } from '../core/types.js';
import { BrowserSOGImageDecoder } from '../format/image.js';
import { parseZipArchiveAsync } from '../format/archive-worker-client.js';
import {
  calculateBounds,
  getAttributeFiles,
  parseAndValidateMeta,
  validateImageDimensions,
} from '../format/meta.js';
import type { ZipEntry } from '../format/zip.js';
import { NativeSOGStorage } from '../resource/SOGResource.js';
import type { SOGResource } from '../resource/SOGResource.js';

interface SharedLoad {
  readonly controller: AbortController;
  readonly progressListeners: Set<NonNullable<SOGLoadOptions['onProgress']>>;
  promise: Promise<NativeSOGStorage>;
  storage: NativeSOGStorage | null;
  subscribers: number;
  settled: boolean;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function resolveUrl(url: string): string {
  try {
    const base = typeof document === 'undefined' ? undefined : document.baseURI;
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function validateSource(url: string): void {
  const pathname = (() => {
    try {
      return new URL(url, 'https://sog.invalid/').pathname;
    } catch {
      return url;
    }
  })();
  if (/lod-meta\.json$/i.test(pathname) || /meta\.json$/i.test(pathname) || !/\.sog$/i.test(pathname)) {
    throw new SOGError('UNSUPPORTED_SOURCE', 'The MVP loader accepts one bundled .sog v2 archive; unbundled and streamed sources are not supported.');
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function download(
  url: string,
  options: SOGLoadOptions,
  signal: AbortSignal,
  diagnostics: LoadDiagnosticsBuilder,
): Promise<ArrayBuffer> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new SOGError('DOWNLOAD_FAILED', 'No fetch implementation is available.', { stage: 'download' });
  }
  const response = await fetchImplementation(url, {
    signal,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  if (!response.ok) {
    throw new SOGError('DOWNLOAD_FAILED', `Failed to download SOG bundle: ${response.status} ${response.statusText}.`, { stage: 'download' });
  }
  const totalHeader = response.headers.get('content-length');
  const parsedTotal = totalHeader === null ? Number.NaN : Number(totalHeader);
  const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : undefined;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    diagnostics.downloadedBytes = buffer.byteLength;
    options.onProgress?.(buffer.byteLength, total);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      received += result.value.byteLength;
      options.onProgress?.(received, total);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  diagnostics.downloadedBytes = received;
  return bytes.buffer;
}

async function decodeImages(
  decoder: SOGImageDecoder,
  files: ReadonlyMap<SOGAttributeName, string>,
  entries: ReadonlyMap<string, ZipEntry>,
  signal: AbortSignal,
): Promise<ReadonlyMap<SOGAttributeName, SOGNativeImage>> {
  const decoded = await Promise.allSettled(
    [...files].map(async ([attribute, filename]) => {
      const entry = entries.get(filename);
      if (!entry) throw new SOGError('MISSING_ATTRIBUTE', `SOG attribute "${attribute}" references missing bundle file "${filename}".`, { stage: 'decode' });
      const image = await decoder.decode(entry.bytes, filename, signal);
      return [attribute, { ...image, attribute, filename }] as const;
    }),
  );
  const failure = decoded.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    for (const result of decoded) if (result.status === 'fulfilled') result.value[1].close();
    throw failure.reason;
  }
  return new Map(decoded.map((result) => (result as PromiseFulfilledResult<readonly [SOGAttributeName, SOGNativeImage]>).value));
}

export class SOGLoader {
  readonly #inFlight = new Map<string, SharedLoad>();
  readonly #identity = new WeakMap<object, number>();
  #nextIdentity = 1;

  async loadAsync(url: string, options: SOGLoadOptions = {}): Promise<SOGResource> {
    validateSource(url);
    throwIfAborted(options.signal);
    const resolvedUrl = resolveUrl(url);
    const key = this.#operationKey(resolvedUrl, options);
    let shared = this.#inFlight.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        progressListeners: new Set(),
        subscribers: 0,
        settled: false,
        storage: null,
        promise: undefined as never,
      };
      const created = shared;
      const sharedOptions: SOGLoadOptions = {
        ...options,
        onProgress: (loaded, total) => {
          for (const listener of created.progressListeners) listener(loaded, total);
        },
      };
      created.promise = this.#load(resolvedUrl, sharedOptions, controller.signal).then((storage) => {
        created.storage = storage;
        if (created.subscribers === 0) storage.destroyIfUnreferenced();
        return storage;
      }).finally(() => {
        created.settled = true;
        if (this.#inFlight.get(key) === created) this.#inFlight.delete(key);
      });
      void created.promise.catch(() => {});
      this.#inFlight.set(key, created);
    }

    shared.subscribers += 1;
    if (options.onProgress) shared.progressListeners.add(options.onProgress);
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      shared.subscribers -= 1;
      if (shared.subscribers === 0) {
        if (!shared.settled) shared.controller.abort();
        else shared.storage?.destroyIfUnreferenced();
      }
    };
    options.signal?.addEventListener('abort', detach, { once: true });
    try {
      const storage = await raceWithAbort(shared.promise, options.signal);
      throwIfAborted(options.signal);
      return storage.acquire();
    } finally {
      options.signal?.removeEventListener('abort', detach);
      if (options.onProgress) shared.progressListeners.delete(options.onProgress);
      detach();
    }
  }

  #objectId(value: object | undefined): number {
    if (value === undefined) return 0;
    const existing = this.#identity.get(value);
    if (existing !== undefined) return existing;
    const id = this.#nextIdentity;
    this.#nextIdentity += 1;
    this.#identity.set(value, id);
    return id;
  }

  #operationKey(url: string, options: SOGLoadOptions): string {
    if (options.dedupeKey !== undefined) return `${url}|${options.dedupeKey}`;
    const headers = options.headers === undefined
      ? ''
      : JSON.stringify([...new Headers(options.headers).entries()].sort(([left], [right]) => left.localeCompare(right)));
    return [
      url,
      options.credentials ?? 'same-origin',
      headers,
      options.useArchiveWorker !== false,
      this.#objectId(options.fetch),
      this.#objectId(options.imageDecoder),
    ].join('|');
  }

  async #load(url: string, options: SOGLoadOptions, signal: AbortSignal): Promise<NativeSOGStorage> {
    const diagnostics = new LoadDiagnosticsBuilder(url);
    const cleanup = new CleanupStack();
    try {
      const archive = await diagnostics.measure('download', () => download(url, options, signal, diagnostics));
      throwIfAborted(signal);
      const entries = await diagnostics.measure('archive', () => parseZipArchiveAsync(
        archive,
        options.useArchiveWorker !== false,
        signal,
      ));
      diagnostics.archiveEntries = entries.size;
      throwIfAborted(signal);

      const meta = await diagnostics.measure('validation', () => {
        const metaEntry = entries.get('meta.json');
        if (!metaEntry) throw new SOGError('MISSING_ATTRIBUTE', 'The SOG bundle does not contain meta.json.', { stage: 'validation' });
        let parsed: unknown;
        try {
          parsed = JSON.parse(textDecoder.decode(metaEntry.bytes));
        } catch (error) {
          throw new SOGError('INVALID_METADATA', 'SOG meta.json is not valid UTF-8 JSON.', { stage: 'validation', cause: error });
        }
        return parseAndValidateMeta(parsed, entries);
      });
      diagnostics.splatCount = meta.count;
      if (meta.count > SOG_MVP_MAX_SPLATS) {
        throw new SOGError('INVALID_METADATA', `SOG count ${meta.count} exceeds the documented MVP limit of ${SOG_MVP_MAX_SPLATS}.`, { stage: 'validation' });
      }

      const decoder = options.imageDecoder ?? new BrowserSOGImageDecoder();
      const images = await diagnostics.measure('decode', () => decodeImages(decoder, getAttributeFiles(meta), entries, signal));
      for (const image of images.values()) cleanup.defer(() => image.close());
      diagnostics.decodedImages = images.size;
      throwIfAborted(signal);

      let shBands = 0;
      await diagnostics.measure('validation', () => {
        shBands = validateImageDimensions(meta, images);
      });

      diagnostics.retainedTemporaryBytes = 0;
      await diagnostics.measure('resource', () => Promise.resolve());
      const storage = new NativeSOGStorage({
        meta,
        bounds: calculateBounds(meta),
        diagnostics: diagnostics.snapshot(),
        images,
        shBands,
      });
      cleanup.release();
      return storage;
    } catch (error) {
      diagnostics.failCurrent();
      try {
        await cleanup.dispose();
      } catch (cleanupError) {
        throw new SOGError('PREPARATION_FAILED', 'SOG loading and cleanup both failed.', {
          ...(diagnostics.failedStage === undefined ? {} : { stage: diagnostics.failedStage }),
          diagnostics: diagnostics.snapshot(),
          cause: new AggregateError([error, cleanupError]),
        });
      }
      if (isAbortError(error) || signal.aborted) {
        throw new SOGError('ABORTED', 'The SOG load was aborted.', {
          ...(diagnostics.failedStage === undefined ? {} : { stage: diagnostics.failedStage }),
          diagnostics: diagnostics.snapshot(),
          cause: error,
        });
      }
      if (error instanceof SOGError) {
        const stage = error.stage ?? diagnostics.failedStage;
        throw new SOGError(error.code, error.message, {
          ...(stage === undefined ? {} : { stage }),
          diagnostics: diagnostics.snapshot(),
          cause: error,
        });
      }
      throw new SOGError('DOWNLOAD_FAILED', 'Failed to load SOG resource.', {
        ...(diagnostics.failedStage === undefined ? {} : { stage: diagnostics.failedStage }),
        diagnostics: diagnostics.snapshot(),
        cause: error,
      });
    }
  }
}
