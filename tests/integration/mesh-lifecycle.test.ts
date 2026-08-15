import { PerspectiveCamera } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import { SOGGaussianSplatMesh } from '../../src/render/SOGGaussianSplatMesh.js';
import { SOGLoader } from '../../src/loader/SOGLoader.js';
import { bundleResponse, createBundle, FakeImageDecoder } from '../helpers/fixture-builder.js';

function fakeRenderer(): WebGPURenderer {
  return {
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true },
    init: vi.fn(async () => {}),
    initTexture: vi.fn(),
    compileAsync: vi.fn(async () => {}),
    compute: vi.fn(),
    computeAsync: vi.fn(async () => {}),
    info: { memory: { textures: 6, programs: 2 } },
  } as unknown as WebGPURenderer;
}

async function resource() {
  const archive = createBundle();
  return new SOGLoader().loadAsync('mesh.sog', {
    fetch: async () => bundleResponse(archive),
    imageDecoder: new FakeImageDecoder(),
    useArchiveWorker: false,
  });
}

describe('SOGGaussianSplatMesh lifecycle', () => {
  it('prepares idempotently, sorts without readback, and disposes deterministically', async () => {
    const source = await resource();
    const mesh = new SOGGaussianSplatMesh(source);
    const renderer = fakeRenderer();
    await Promise.all([mesh.prepare(renderer), mesh.prepare(renderer)]);
    expect(mesh.state).toBe('ready');
    expect(mesh.visible).toBe(true);
    expect(mesh.diagnostics.backend).toBe('webgpu');
    expect(mesh.diagnostics.readbackCount).toBe(0);
    expect(renderer.init).toHaveBeenCalledTimes(1);
    expect(renderer.initTexture).toHaveBeenCalledTimes(6);
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld();
    mesh.onBeforeRender(renderer as never, mesh as never, camera, mesh.geometry, mesh.material, null as never);
    mesh.onAfterRender(renderer as never, mesh as never, camera, mesh.geometry, mesh.material, null as never);
    const countAfterFirstCamera = mesh.diagnostics.sortCount;
    mesh.onBeforeRender(renderer as never, mesh as never, camera, mesh.geometry, mesh.material, null as never);
    expect(mesh.diagnostics.sortCount).toBe(countAfterFirstCamera);
    expect(mesh.diagnostics.firstVisibleFrameDurationMs).toBeGreaterThan(0);
    expect(mesh.diagnostics.deferredUploadCount).toBe(0);
    expect(mesh.diagnostics.deferredCompileCount).toBe(0);
    mesh.dispose();
    mesh.dispose();
    expect(mesh.state).toBe('disposed');
    expect(mesh.visible).toBe(false);
    source.dispose();
  });

  it('rejects classic WebGLRenderer and renderer rebinding', async () => {
    const source = await resource();
    const mesh = new SOGGaussianSplatMesh(source);
    await expect(mesh.prepare({ isWebGLRenderer: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_RENDERER',
    });
    await mesh.prepare(fakeRenderer());
    await expect(mesh.prepare(fakeRenderer())).rejects.toMatchObject({
      code: 'RENDERER_MISMATCH',
    });
    mesh.dispose();
    source.dispose();
  });

  it('holds an internal source lease independently of the caller resource', async () => {
    const source = await resource();
    const mesh = new SOGGaussianSplatMesh(source);
    source.dispose();
    await mesh.prepare(fakeRenderer());
    expect(mesh.state).toBe('ready');
    mesh.dispose();
  });

  it('cancels pending preparation and remains safe to dispose', async () => {
    const source = await resource();
    const renderer = fakeRenderer();
    (renderer.init as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const mesh = new SOGGaussianSplatMesh(source);
    const preparing = mesh.prepare(renderer);
    mesh.dispose();
    await expect(preparing).rejects.toMatchObject({ code: 'ABORTED' });
    expect(mesh.state).toBe('disposed');
    source.dispose();
  });

  it('turns renderer/device initialization loss into a typed failure and remains disposable', async () => {
    const source = await resource();
    const renderer = fakeRenderer();
    (renderer.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GPU device lost'));
    const mesh = new SOGGaussianSplatMesh(source);
    await expect(mesh.prepare(renderer)).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
    expect(mesh.state).toBe('failed');
    mesh.dispose();
    expect(mesh.state).toBe('disposed');
    source.dispose();
  });

  it('disposes prepared GPU objects exactly once when cancelled during compilation', async () => {
    const source = await resource();
    const renderer = fakeRenderer();
    let releaseCompile = () => {};
    (renderer.compileAsync as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((resolve) => {
      releaseCompile = resolve;
    }));
    const mesh = new SOGGaussianSplatMesh(source);
    const preparing = mesh.prepare(renderer);
    await vi.waitFor(() => expect(renderer.compileAsync).toHaveBeenCalled());
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    mesh.geometry.addEventListener('dispose', geometryDisposed);
    mesh.material.addEventListener('dispose', materialDisposed);
    mesh.dispose();
    releaseCompile();
    await expect(preparing).rejects.toMatchObject({ code: 'ABORTED' });
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    source.dispose();
  });
});
