English | [简体中文](./README.zh-CN.md)

# three-sog-splats

Native bundled SOG v2 Gaussian-splat loading and rendering for Three.js r185.
The package preserves SOG WebP attributes and codebooks instead of expanding a
complete CPU-side Gaussian representation.

## Compatibility

- `three@0.185.0` is the tested baseline; the peer range is `^0.185.0`.
- Use `WebGPURenderer` from `three/webgpu`. The primary backend is WebGPU; the
  renderer's forced WebGL backend is the supported fallback.
- The classic `WebGLRenderer` API is deliberately rejected with a typed error.
- TypeScript consumers also need `@types/three@0.185.0`, because the Three.js
  runtime package does not ship those declarations.

Three.js is external and supplied by the application. `fflate` is the archive
dependency. PlayCanvas Engine and the local `potree-engine` checkout are design
references only: neither is bundled or used at runtime.

## Install

```bash
npm install three@0.185.0 three-sog-splats
npm install --save-dev @types/three@0.185.0
```

## Usage

```ts
import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { SOGGaussianSplatMesh, SOGLoader } from 'three-sog-splats';

const renderer = new WebGPURenderer({ antialias: true });
const scene = new Scene();
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1_000);

const controller = new AbortController();
const resource = await new SOGLoader().loadAsync('/scene.sog', {
  signal: controller.signal,
  onProgress: (loaded, total) => console.log(loaded, total),
});
const splats = new SOGGaussianSplatMesh(resource);

// Uploads source/codebook/order resources, performs the initial sort, and
// compiles the exact material/backend variant before the object is visible.
await splats.prepare(renderer, { signal: controller.signal });
scene.add(splats);

renderer.setAnimationLoop(() => renderer.render(scene, camera));

// When the object is no longer needed:
scene.remove(splats);
splats.dispose();
resource.dispose();
```

Pass `{ forceWebGL: true }` to `WebGPURenderer` to exercise the fallback. It
decodes and asynchronously reads back `center.xyz` once per native resource,
sorts in a transferable worker, and uploads only the instanced order. All other
attributes remain GPU-native. The WebGPU path generates keys and sorts entirely
in GPU storage buffers with no center, key, or order readback.

Equivalent in-flight loads from one `SOGLoader` are deduplicated. Each caller
receives an independent resource lease; cancelling one caller does not abort
other consumers, and the shared operation is aborted after the final consumer
detaches.

Renderer/device initialization loss rejects preparation as
`PREPARATION_FAILED` and cleans partial resources. After a device is lost for an
already prepared renderer, dispose the mesh and create/prepare a new mesh after
the application has replaced or recovered its renderer.

## Public API

- `SOGLoader.loadAsync(url, options)` loads one bundled `.sog` v2 archive.
- `SOGResource` exposes immutable metadata, bounds, native images, SH bands,
  load diagnostics, cloning, and idempotent disposal.
- `SOGGaussianSplatMesh` is a normal Three.js mesh with explicit asynchronous
  `prepare()`, scene transforms, one full-resource active range, render
  diagnostics, and idempotent disposal.
- `SOGError` provides stable codes such as `ABORTED`, `INVALID_ARCHIVE`,
  `INVALID_METADATA`, `UNSUPPORTED_RENDERER`, and `RENDERER_MISMATCH`.
- Exported option, state, metadata, bounds, diagnostics, and disposal types are
  declared from the package root.

Load diagnostics include per-stage timings, downloaded bytes, archive entries,
decoded images, splat count, retained temporary bytes, and failed-stage identity.
Render diagnostics include backend, upload/compile/prepare/first-frame/sort
timings, sort/upload/readback counters, active count, estimated GPU allocation,
and state.

## MVP limits and non-goals

The enforced limit is 2,000,000 splats per bundled resource. The planning
estimate is 52 GPU bytes per splat (about 104 MB at the limit) before renderer,
decoded-image, framebuffer, and browser overhead. Validate production assets on
the target GPU; this is a memory guardrail, not a universal performance promise.

The MVP supports one full-resource active range, SOG v2 stored/deflated ZIP
bundles, no-SH and supported SH centroid widths. It does not include chunked or
LOD streaming, multi-resource aggregation, range requests, conversion/export,
other splat formats, classic `WebGLRenderer`, or order-independent transparency.
Zip64, encrypted archives, multi-disk archives, and unknown compression methods
are rejected explicitly.

See [performance and limits](./docs/performance-limits.md) for measurements and
methodology, [acceptance results](./docs/acceptance.md) for the release gate, and
[design and roadmap](./docs/design-and-roadmap.md) for architecture and future
streaming boundaries.

## Development

```bash
npm install
npm test
npm run test:browser
npm run test:package
npm run benchmark
npm run test:acceptance
```

Fixtures are synthetic CC0 assets. Browser image baselines use tolerant
comparisons for both backends and no-SH/SH variants.
