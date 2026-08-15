import { SOGError } from '../core/errors.js';
import type {
  SOGAttributeName,
  SOGBounds,
  SOGLoadDiagnostics,
  SOGMetaV2,
  SOGNativeImage,
  SOGResourceState,
} from '../core/types.js';

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #source: ReadonlyMap<K, V>;

  constructor(source: ReadonlyMap<K, V>) {
    this.#source = source;
    Object.freeze(this);
  }

  get size(): number { return this.#source.size; }
  get(key: K): V | undefined { return this.#source.get(key); }
  has(key: K): boolean { return this.#source.has(key); }
  entries(): MapIterator<[K, V]> { return this.#source.entries(); }
  keys(): MapIterator<K> { return this.#source.keys(); }
  values(): MapIterator<V> { return this.#source.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#source[Symbol.iterator](); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#source.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}

export class NativeSOGStorage {
  readonly meta: SOGMetaV2;
  readonly bounds: SOGBounds;
  readonly diagnostics: SOGLoadDiagnostics;
  readonly images: ReadonlyMap<SOGAttributeName, SOGNativeImage>;
  readonly shBands: number;
  readonly #ownedImages: ReadonlyMap<SOGAttributeName, SOGNativeImage>;
  #references = 0;
  #disposed = false;
  #version = 1;

  constructor(options: {
    meta: SOGMetaV2;
    bounds: SOGBounds;
    diagnostics: SOGLoadDiagnostics;
    images: ReadonlyMap<SOGAttributeName, SOGNativeImage>;
    shBands: number;
  }) {
    this.meta = deepFreeze(options.meta);
    this.bounds = deepFreeze(options.bounds);
    this.diagnostics = options.diagnostics;
    this.#ownedImages = new Map([...options.images].map(([attribute, image]) => [
      attribute,
      Object.freeze({ ...image }),
    ]));
    this.images = new ReadonlyMapView(this.#ownedImages);
    this.shBands = options.shBands;
  }

  get version(): number {
    return this.#version;
  }

  acquire(): SOGResource {
    if (this.#disposed) throw new SOGError('RESOURCE_DISPOSED', 'The shared SOG source has already been disposed.');
    this.#references += 1;
    return new SOGResource(this);
  }

  release(): void {
    if (this.#references <= 0) return;
    this.#references -= 1;
    if (this.#references === 0) this.destroy();
  }

  destroyIfUnreferenced(): void {
    if (this.#references === 0) this.destroy();
  }

  destroy(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#version += 1;
    for (const image of this.#ownedImages.values()) image.close();
  }
}

export class SOGResource {
  readonly #storage: NativeSOGStorage;
  #state: SOGResourceState = 'ready';

  constructor(storage: NativeSOGStorage) {
    this.#storage = storage;
  }

  get count(): number {
    return this.#storage.meta.count;
  }

  get bounds(): SOGBounds {
    return this.#storage.bounds;
  }

  get meta(): SOGMetaV2 {
    return this.#storage.meta;
  }

  get diagnostics(): SOGLoadDiagnostics {
    return this.#storage.diagnostics;
  }

  get state(): SOGResourceState {
    return this.#state;
  }

  get version(): number {
    return this.#storage.version;
  }

  get shBands(): number {
    return this.#storage.shBands;
  }

  get nativeImages(): ReadonlyMap<SOGAttributeName, SOGNativeImage> {
    this.assertReady();
    return this.#storage.images;
  }

  clone(): SOGResource {
    this.assertReady();
    return this.#storage.acquire();
  }

  dispose(): void {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    this.#storage.release();
  }

  assertReady(): void {
    if (this.#state !== 'ready') throw new SOGError('RESOURCE_DISPOSED', 'The SOG resource has been disposed.');
  }
}
