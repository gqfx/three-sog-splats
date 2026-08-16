English | [简体中文](./README.zh-CN.md)

# three-sog-splats

Native bundled SOG v2 Gaussian-splat loading and rendering for Three.js
r184-r185.
The package preserves SOG WebP attributes and codebooks instead of expanding a
complete CPU-side Gaussian representation.

## Compatibility

- The minimum supported release is `three@0.184.0`; r184 and r185 both pass the
  real-browser WebGPU and forced-WebGL suite. The peer range is
  `>=0.184.0 <0.186.0`.
- Development remains pinned to `three@0.185.0` so upstream changes are
  intentional and reproducible.
- Use `WebGPURenderer` from `three/webgpu`. The primary backend is WebGPU; the
  renderer's forced WebGL backend is the supported fallback.
- The classic `WebGLRenderer` API is deliberately rejected with a typed error.
- TypeScript consumers also need a matching `@types/three` release, because the
  Three.js runtime package does not ship those declarations.

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
attributes remain GPU-native. The WebGPU path builds a complete order with a
stable adaptive GPU radix sort, with no center, key, intermediate-buffer, or
order readback. A portable 4-bit backend is the universal path. An 8-bit
OneSweep backend is selected only for a correlated NVIDIA adapter with
advertised subgroup support and a compatible reported subgroup size; custom,
unknown, Apple, mobile, or otherwise ambiguous devices stay on Portable.
Equal-key splats retain source order.

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
  `prepare()`, scene transforms, optional pre-prepare translated batching via
  `setInstanceTransforms()`, one full-resource active range, render diagnostics,
  and idempotent disposal.
- `SOGError` provides stable codes such as `ABORTED`, `INVALID_ARCHIVE`,
  `INVALID_METADATA`, `UNSUPPORTED_RENDERER`, and `RENDERER_MISMATCH`.
- Exported option, state, metadata, bounds, diagnostics, and disposal types are
  declared from the package root.

Load diagnostics include per-stage timings, downloaded bytes, archive entries,
decoded images, splat count, retained temporary bytes, and failed-stage identity.
Render diagnostics include backend, upload/compile/prepare/first-frame/sort
timings, sort/upload/readback counters, active count, estimated GPU allocation,
state, selected radix backend, rounded radix bits, and selection reason.

## MVP limits and non-goals

The enforced limit is 5,000,000 splats per bundled resource. The planning
estimate is 52 GPU bytes per splat (about 260 MB at the limit) before renderer,
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

## Example

Run `npm run example`, then open
`http://127.0.0.1:4173/webgpu_sog.html`. The public example follows the Three.js
Gaussian Splatting example structure. Its real-model choices include the full
116,374-Gaussian Millipede for no-SH and the full
195,099-Gaussian Lion SH2 model from the Three.js example. Both are converted
without decimation or filtering, and Lion retains every SH band. The backend
control reloads with either WebGPU or forced WebGL.
**Start motion test** and **Stop motion test** provide repeatable full-resolution
performance sampling without changing the active count. The overlay and
structured state report frame percentiles, sort rate/count, viewport, DPR, and
backend-specific sort timing. See [example notes](./examples/README.md).
The source selector also includes a reproducible synthetic 5,000,000-splat
WebGPU stress scene. It uses about 200 MB of reported GPU resources on the
Portable path and automatically switches away from forced WebGL.
For a real-data comparison, Lion grid downloads the same 3.3 MB Lion SOG once
and batches 25 translated runtime copies into one draw (4,877,475 logical
splats). One-time static dequantization and camera-change projection/SH caches
replace per-frame texture decode; stationary frames run no compute. No expanded
25-copy source fixture is stored or uploaded.

## Development

```bash
npm install
npm test
npm run build:example
npm run test:browser
npm run test:package
npm run benchmark
npm run test:acceptance
```

Synthetic fixtures are internal CC0 test assets and are not exposed by the
public source selector. Browser image baselines use tolerant comparisons for
both backends and no-SH/SH variants. The browser suite also
loads a full-resolution 116,374-Gaussian SOG directly converted from Three.js's
CC BY 4.0 Millipede example through both backends. The public-example tests load
and snapshot both Millipede no-SH and the complete 195,099-Gaussian Lion SH2
asset on both backends.
See the [Millipede attribution](./tests/fixtures/millipede.license.txt),
[Lion attribution](./tests/fixtures/lion.license.txt), and the
[compatibility audit](./docs/three-compatibility.md).
