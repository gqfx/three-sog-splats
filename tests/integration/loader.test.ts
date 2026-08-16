import { describe, expect, it, vi } from 'vitest';
import { SOGError } from '../../src/core/errors.js';
import { SOG_MVP_MAX_SPLATS } from '../../src/core/types.js';
import { SOGLoader } from '../../src/loader/SOGLoader.js';
import {
  bundleResponse,
  codebook,
  createBundle,
  FakeImageDecoder,
  validMeta,
} from '../helpers/fixture-builder.js';

describe('SOGLoader', () => {
  it('accepts exactly 5,000,000 splats and rejects larger resources', async () => {
    expect(SOG_MVP_MAX_SPLATS).toBe(5_000_000);
    const atLimit = { ...validMeta, count: SOG_MVP_MAX_SPLATS };
    const resource = await new SOGLoader().loadAsync('five-million.sog', {
      fetch: async () => bundleResponse(createBundle(atLimit)),
      imageDecoder: new FakeImageDecoder(4_096, 1_221),
      useArchiveWorker: false,
    });
    expect(resource.count).toBe(5_000_000);
    resource.dispose();

    const aboveLimit = { ...validMeta, count: SOG_MVP_MAX_SPLATS + 1 };
    await expect(new SOGLoader().loadAsync('too-large.sog', {
      fetch: async () => bundleResponse(createBundle(aboveLimit)),
      imageDecoder: new FakeImageDecoder(4_096, 1_222),
      useArchiveWorker: false,
    })).rejects.toThrow(/exceeds the documented MVP limit of 5000000/);
  });

  it('loads a native SOG resource without expanding Gaussian attributes', async () => {
    const archive = createBundle();
    const decoder = new FakeImageDecoder();
    const resource = await new SOGLoader().loadAsync('scene.sog', {
      fetch: vi.fn(async () => bundleResponse(archive)),
      imageDecoder: decoder,
      useArchiveWorker: false,
    });
    expect(resource.count).toBe(4);
    expect(resource.nativeImages.size).toBe(5);
    expect(resource).not.toHaveProperty('positions');
    expect(Object.isFrozen(resource.meta)).toBe(true);
    expect(Object.isFrozen(resource.meta.scales.codebook)).toBe(true);
    expect(() => (resource.nativeImages as Map<string, unknown>).set('unexpected', {})).toThrow();
    expect(resource.diagnostics.downloadedBytes).toBe(archive.byteLength);
    expect(Object.keys(resource.diagnostics.stages)).toEqual([
      'download',
      'archive',
      'validation',
      'decode',
      'resource',
    ]);
    resource.dispose();
    resource.dispose();
    expect(decoder.closed).toBe(5);
  });

  it('rejects mismatched decoded dimensions and reports the failed stage', async () => {
    const error = await new SOGLoader().loadAsync('mismatch.sog', {
      fetch: async () => bundleResponse(createBundle()),
      imageDecoder: new FakeImageDecoder(2, 2, { 'means_u.webp': [3, 2] }),
      useArchiveWorker: false,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'IMAGE_DIMENSION_MISMATCH',
      stage: 'validation',
      diagnostics: { failedStage: 'validation', decodedImages: 5 },
    });
  });

  it('loads the full-height palette layout used by real SOG v2 SH assets', async () => {
    const meta = {
      ...validMeta,
      shN: {
        count: 65_536,
        bands: 2,
        codebook,
        files: ['shN_centroids.webp', 'shN_labels.webp'],
      },
    };
    const resource = await new SOGLoader().loadAsync('sh2.sog', {
      fetch: async () => bundleResponse(createBundle(meta)),
      imageDecoder: new FakeImageDecoder(2, 2, { 'shN_centroids.webp': [512, 1024] }),
      useArchiveWorker: false,
    });
    expect(resource.shBands).toBe(2);
    expect(resource.meta.shN).toMatchObject({ count: 65_536, bands: 2 });
    expect(resource.nativeImages.size).toBe(7);
    resource.dispose();
  });

  it('aborts the shared operation after its final consumer detaches', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = new SOGLoader().loadAsync('abort.sog', {
      fetch,
      signal: controller.signal,
      useArchiveWorker: false,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('deduplicates equivalent in-flight work and returns independent leases', async () => {
    const archive = createBundle();
    const fetch = vi.fn(async () => {
      await Promise.resolve();
      return bundleResponse(archive);
    });
    const decoder = new FakeImageDecoder();
    const loader = new SOGLoader();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const [first, second] = await Promise.all([
      loader.loadAsync('same.sog', { fetch, imageDecoder: decoder, onProgress: firstProgress, useArchiveWorker: false }),
      loader.loadAsync('same.sog', { fetch, imageDecoder: decoder, onProgress: secondProgress, useArchiveWorker: false }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(firstProgress).toHaveBeenCalled();
    expect(secondProgress).toHaveBeenCalled();
    expect(first).not.toBe(second);
    first.dispose();
    expect(second.state).toBe('ready');
    second.dispose();
    expect(decoder.closed).toBe(5);
  });

  it('does not deduplicate requests with different headers or worker options', async () => {
    const archive = createBundle();
    const fetch = vi.fn(async () => bundleResponse(archive));
    const decoder = new FakeImageDecoder();
    const loader = new SOGLoader();
    const [first, second] = await Promise.all([
      loader.loadAsync('options.sog', {
        fetch,
        headers: { authorization: 'first' },
        imageDecoder: decoder,
        useArchiveWorker: false,
      }),
      loader.loadAsync('options.sog', {
        fetch,
        headers: { authorization: 'second' },
        imageDecoder: decoder,
        useArchiveWorker: true,
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    first.dispose();
    second.dispose();
  });

  it('rejects non-MVP sources', async () => {
    await expect(new SOGLoader().loadAsync('lod-meta.json')).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE',
    });
  });

  it('detaches a cancelled caller without aborting another consumer', async () => {
    const archive = createBundle();
    const fetch = vi.fn(async () => bundleResponse(archive));
    const decoder = new FakeImageDecoder();
    const loader = new SOGLoader();
    const controller = new AbortController();
    const cancelled = loader.loadAsync('shared.sog', {
      fetch,
      imageDecoder: decoder,
      signal: controller.signal,
      useArchiveWorker: false,
    });
    const successful = loader.loadAsync('shared.sog', { fetch, imageDecoder: decoder, useArchiveWorker: false });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(SOGError);
    const resource = await successful;
    expect(fetch).toHaveBeenCalledTimes(1);
    resource.dispose();
  });

  it('releases every native image across repeated load/dispose cycles', async () => {
    const archive = createBundle();
    const decoder = new FakeImageDecoder();
    const loader = new SOGLoader();
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const loaded = await loader.loadAsync(`cycle-${iteration}.sog`, {
        fetch: async () => bundleResponse(archive),
        imageDecoder: decoder,
        useArchiveWorker: false,
      });
      loaded.dispose();
    }
    expect(decoder.closed).toBe(50);
  });
});
