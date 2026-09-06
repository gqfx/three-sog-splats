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
order readback. A portable 4-bit backend is the universal production path. The
8-bit OneSweep implementation is admitted only when adapter identity is
correlated and NVIDIA reports a fixed 32-lane subgroup. WebGPU does not
currently expose that correlation through Three.js, so default production
selection stays on Portable instead of inferring identity from a second
`requestAdapter()` call. Equal-key splats retain source order.

Cached WebGPU meshes also classify projected splats before rasterization using
an opacity-weighted screen-area metric derived from PlayCanvas. Behind-camera,
zero-alpha, off-screen, and low-contribution splats are stably compacted into a
GPU visible-index buffer, and a GPU-written indexed-indirect command draws only
the survivors. The full source remains resident and can reappear after a view
change. The conservative default contribution threshold is `1`.

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
  configurable contribution culling via `setContributionCullingEnabled()` and
  `setContributionCullThreshold()`, explicit opt-in culling telemetry via
  `readContributionCullingStatsAsync()`, and idempotent disposal.
- `SOGError` provides stable codes such as `ABORTED`, `INVALID_ARCHIVE`,
  `INVALID_METADATA`, `UNSUPPORTED_RENDERER`, and `RENDERER_MISMATCH`.
- Exported option, state, metadata, bounds, diagnostics, and disposal types are
  declared from the package root.

Load diagnostics include per-stage timings, downloaded bytes, archive entries,
decoded images, splat count, retained temporary bytes, and failed-stage identity.
Render diagnostics include backend, upload/compile/prepare/first-frame/sort
timings, sort/upload/readback counters, active count, estimated GPU allocation,
retained CPU backing-array allocation, state, selected radix backend, rounded
radix bits, and selection reason.
Contribution telemetry reports submitted/visible counts plus camera-or-alpha,
off-screen, and low-contribution rejection counts. Reading it is explicit and
increments the readback diagnostics; the normal stationary path performs no
GPU readback.

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
SOG metadata requesting antialiased Gaussian or 2DGS equations is also rejected
until those distinct render paths are implemented.

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
backend-specific sort timing. See [example notes](https://github.com/gqfx/three-sog-splats/blob/main/examples/README.md).
The source selector also includes a reproducible synthetic 5,000,000-splat
WebGPU stress scene. It uses about 200 MB of reported GPU resources on the
Portable path and automatically switches away from forced WebGL.
For a real-data comparison, Lion grid downloads the same 3.3 MB Lion SOG once
and batches 25 translated runtime copies into one draw (4,877,475 logical
splats). Its depth sort covers the complete logical stream, so copies can
interleave correctly. One-time static dequantization and camera-change
projection/SH caches replace per-frame texture decode; stationary frames run no
compute. No expanded 25-copy source fixture is stored or uploaded.
The WebGPU Example exposes contribution-culling enable/threshold controls and
an explicit telemetry button. Its controlled profiler includes a same-view
culling on/off A/B and corrects Three.js's CPU-side triangle estimate with the
GPU survivor count.

## Development

```bash
npm ci --ignore-scripts
npm run fixtures:fetch
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
asset on both backends. The WebGPU source selector also includes Three.js's
full-resolution 445,409-Gaussian Tomatoes SPZ v4 example with all three SH
bands and Nicolas Diolez's full-resolution Moon SOG v2 scene with 4,929,011
unique Gaussians and all three SH bands. Both are single unique meshes without
runtime copies.
See the [Millipede attribution](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/millipede.license.txt),
[Lion attribution](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/lion.license.txt),
[Tomatoes attribution](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/tomatoes.license.txt),
[Moon attribution](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/moon.license.txt), and the
[compatibility audit](./docs/three-compatibility.md).

## Resource budgets and release status

The 0.1.x API is experimental. The measured/browser-tested platform is Chrome
on macOS with the documented Three.js releases; mobile, Firefox/Safari, WebXR
and global sorting across overlapping independent meshes are not certified.
The 5M splat limit is not a frame-rate guarantee. Streaming and LOD remain future
features; large models must download fully before display.

Default loading limits are 128 MiB downloaded, 128 MiB per ZIP entry, 256 MiB
actual total ZIP output, 8192 pixels per image dimension, 8,388,608 pixels per
image, 256 MiB total decoded RGBA and two concurrent image decodes. Configure
`maxDownloadBytes`, `maxArchiveEntryBytes`, `maxArchiveBytes`,
`maxImageDimension`, `maxImagePixels`, `maxDecodedBytes` and `decodeConcurrency`
on loadAsync. Native PNG/WebP headers are checked before allocation; custom
image decoders own their pre-allocation safety and may implement getDimensions.

prepare accepts `maxGpuBytes` (default 512 MiB tracked SOG allocations) and
`maxProjectedCacheBytes` (default 256 MiB; zero disables caching). Cache admission
uses estimated bytes including SH and logical instances. A translated batch
requires enough cache budget. Device texture/storage limits are checked before
upload; browser images, framebuffers and driver overhead still need headroom.

For a fresh checkout, run `npm run fixtures:fetch` before using Moon. Its native
files and canonical archive are verified against committed hashes. The large
archive is not tracked in Git. See
[contribution and release instructions](https://github.com/gqfx/three-sog-splats/blob/main/CONTRIBUTING.md)
and [security reporting](./SECURITY.md).
