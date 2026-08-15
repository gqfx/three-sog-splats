# Design, Scope, and Implementation Roadmap

## Status

This document records the initial technical direction for `three-sog-splats`.
It is a design baseline, not a claim that every item described here has already
been implemented.

The first milestone is intentionally limited to loading and rendering one
bundled SOG v2 asset. Chunked and LOD-streamed SOG support is a future direction,
not part of the first release.

## Decision summary

`three-sog-splats` will be an externally maintained Three.js integration for
native SOG Gaussian splat data. It will contain more than a file parser:

- SOG bundle loading and validation;
- optimized WebP and codebook preparation;
- a GPU resource lifecycle for the native SOG layout;
- a Three.js scene object and rendering path;
- depth sorting for WebGPU and a WebGL backend fallback;
- explicit preparation, cancellation, cleanup, and diagnostics.

The project will use public Three.js APIs and remain outside the Three.js core
repository. A community example can be proposed once the implementation is
stable.

## Reference implementation baseline

This project is a Three.js integration, not a direct port of another engine.
Its design is nevertheless grounded in two implementation references:

1. the current PlayCanvas Engine SOG and unified Gaussian-splat renderer, which
   defines the primary runtime and WebGPU reference;
2. the existing local `potree-engine` SOG implementation, which records
   Three.js-specific loading and WebGL performance lessons.

Neither project is a runtime dependency. We adopt observable behavior,
resource boundaries, and proven optimization principles, then implement them
through public Three.js, TSL, and NodeMaterial APIs.

### PlayCanvas Engine: primary SOG and WebGPU reference

The reproducible upstream snapshot reviewed for this roadmap is PlayCanvas
Engine `main` at
[`070709b` (2026-08-15, `2.22.0-beta.15`)](https://github.com/playcanvas/engine/tree/070709b0256e6bd2484e4c21e908a1b6b9fc73b9).
Before implementing a milestone, its corresponding files on the latest
[PlayCanvas `main` branch](https://github.com/playcanvas/engine) should be
checked again for lifecycle, layout, and algorithm changes.

The relevant upstream architecture is:

| Area | Current PlayCanvas source | Guidance for this project |
| --- | --- | --- |
| SOG bundle and metadata loading | [`sog-bundle.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/framework/parsers/sog-bundle.js), [`sog.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/framework/parsers/sog.js) | Preserve SOG textures and codebooks, load independent textures concurrently, handle unload during asynchronous work, and release bundle-backed encoded bytes after upload. |
| Native SOG GPU resource | [`gsplat-sog-data.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat/gsplat-sog-data.js), [`gsplat-sog-resource.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat/gsplat-sog-resource.js) | Keep `means_l`, `means_u`, quaternions, scales, SH data, and the v2 codebook in their native GPU representation. Generate CPU centers only for a CPU-sort backend. |
| Canonical active work buffer | [`gsplat-work-buffer.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat-unified/gsplat-work-buffer.js), [`gsplat-work-buffer-render-pass.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat-unified/gsplat-work-buffer-render-pass.js) | Decode or copy active source ranges into one renderer-owned layout only when resource, transform, or active-range state changes. Keep sort order in a WebGPU storage buffer; use a texture only for the WebGL backend. |
| WebGPU cull, project, and key generation | [`gsplat-hybrid-renderer.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat-unified/gsplat-hybrid-renderer.js), [`gsplat-projector.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat-unified/gsplat-projector.js) | Follow the GPU-driven sequence: interval cull and compaction, projection and screen-space culling, depth-key generation, global sort, then indirect drawing. Do not read centers or sort keys back to the CPU. |
| WebGPU radix sort | [`compute-radix-sort.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/graphics/radix-sort/compute-radix-sort.js), [`compute-radix-sort-multipass.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/graphics/radix-sort/compute-radix-sort-multipass.js), [`compute-radix-sort-onesweep.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/graphics/radix-sort/compute-radix-sort-onesweep.js) | Start with a portable radix implementation. Treat subgroup/OneSweep paths as later, capability-gated optimizations because upstream currently restricts its automatically selected OneSweep path to validated NVIDIA hardware. |
| CPU-sort fallback | [`gsplat-manager.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat-unified/gsplat-manager.js), [`gsplat-unified-sorter.js`](https://github.com/playcanvas/engine/blob/070709b0256e6bd2484e4c21e908a1b6b9fc73b9/src/scene/gsplat-unified/gsplat-unified-sorter.js) | Keep only centers in CPU memory, sort asynchronously in a worker, and upload the resulting order. Other Gaussian attributes remain GPU-native. |

The PlayCanvas hybrid renderer is the most important WebGPU reference. Its
architecture, rather than engine-specific class names or shader plumbing, is
the target: a GPU-resident active set, GPU-generated visible count and sort
keys, one global radix sort, and a draw that consumes GPU-produced order data.

### `potree-engine`: Three.js and WebGL optimization reference

The second reference is the local `potree-engine` checkout used during this
project's design. Paths below are relative to that checkout. These optimizations
are adapted where they remain applicable; its renderer architecture is not
copied wholesale.

| Proven optimization | Local reference | Guidance for this project |
| --- | --- | --- |
| Decode embedded WebP bytes without object URLs and upload during loading | `src/plugins/gsplat/loaders/SOGBundleLoader.ts` | Use `createImageBitmap()` with data-preserving options, create the texture from the decoded bitmap, and explicitly initialize it during `prepare()` so the first visible render does not pay the upload cost. |
| Keep raw SOG textures; prepare only codebooks and CPU centers when required | `src/plugins/gsplat/core/GSplatSogsData.ts`, `src/plugins/gsplat/loaders/GSplatSogsResource.ts` | Do not generate redundant packed copies for the normal SOG path. Cache reusable preparation resources, prefer asynchronous center readback for the fallback, and bind raw SOG plus codebook textures directly. |
| Move LOD remapping out of a per-splat texture | `src/plugins/gsplat/lod/GSplatWorkBufferRenderPass.ts` | Describe active ranges as row-aligned copy segments carrying `sourceBase` and count. Avoid uploading a large interval-remap texture when the active set changes. |
| Prevent first-use shader and texture work during camera movement | `src/plugins/gsplat/lod/GSplatWorkBuffer.ts`, `src/plugins/gsplat/utils/syncTextureUploadVersion.ts` | Prewarm the exact work-buffer/material variants and keep their cache keys stable. Explicit uploads must be reflected in Three.js's texture lifecycle so they are not repeated on first bind. |
| Avoid WebGL stalls for full order replacement | `src/plugins/gsplat/utils/UploadStream.ts` | For the WebGL backend, retain the measured single-buffer full `texImage2D` strategy and use partial/PBO uploads only where safe. This is a backend-specific fallback rule, not a WebGPU design. |
| Cancellation-aware resource finalization | `src/plugins/gsplat/lod/GSplatAssetLoader.ts` | Deduplicate in-flight loads, reject stale generations, dispose resources completed after cancellation, and never cache a cancelled result. |

The local performance investigation in
`openspec/changes/2026-05-15-optimize-lod-sog-load-finalization/` is the
benchmark rationale for these rules. In particular, it showed that camera-time
hitches came from deferred texture upload, redundant SOG packing, interval
remap uploads, order texture uploads, and shader first use—not from the SOG
format itself.

### How the references are combined

- WebGPU follows the current PlayCanvas GPU-driven architecture and uses
  storage buffers, compute passes, global radix sorting, and indirect drawing.
- The WebGL backend follows the centers-only CPU worker model and incorporates
  the measured `potree-engine` upload and prewarm fixes.
- Both backends share bundle parsing, metadata validation, native SOG resource
  ownership, active-range contracts, cancellation, and diagnostics.
- Three.js integration remains independent: upstream concepts are re-expressed
  with public `three`, `three/webgpu`, and `three/tsl` APIs and verified by
  adapter tests.
- In phase one, interval culling and compaction may be an identity operation
  over the single full-resource range. The boundary remains explicit so the
  streamed implementation can add real active-range compaction later.

## Phase-one goals

### 1. Load one bundled SOG v2 asset

`SOGLoader` will:

- fetch a single `.sog` bundle;
- parse the archive once and index its files in memory;
- validate and normalize `meta.json` for the supported SOG v2 contract;
- decode the referenced WebP attribute images;
- prepare scale, color, and spherical-harmonic codebooks;
- expose cancellation and deterministic cleanup;
- return a resource object rather than directly binding file lifetime to a
  mesh.

Unbundled SOG directories and `lod-meta.json` are not required for the first
milestone.

### 2. Preserve the native SOG source layout

The loader must not expand all splats into conventional CPU-side position,
covariance, color, and spherical-harmonic arrays merely to construct a
`BufferGeometry`.

The WebP images and SOG codebooks remain the source representation. A renderer
adapter may decode or copy active data into a canonical GPU work buffer, but
that work happens on the GPU and only when the resource or active set changes.

This is the key distinction from a loader that converts SOG into the input
layout expected by Three.js's built-in `GaussianSplatMesh`.

### 3. Integrate as a normal Three.js scene object

The package will expose a `SOGGaussianSplatMesh` (name subject to API review)
that can be added to a scene and uses Three.js transforms, camera state, render
ordering, and resource disposal conventions.

The intended usage is:

```ts
const resource = await new SOGLoader().load('/scene.sog');
const splats = new SOGGaussianSplatMesh(resource);

await splats.prepare(renderer);
scene.add(splats);
```

`prepare(renderer)` is explicit so image decoding, texture upload, codebook
creation, shader compilation, and other one-time work can finish before the
asset becomes visible.

The material should use normal depth testing with depth writes disabled. This
allows opaque Three.js meshes to occlude splats correctly while avoiding splats
writing an approximate surface into the depth buffer.

### 4. Provide two sorting paths

#### WebGPU path

The primary path will:

1. keep SOG attributes in their compact source representation;
2. decode positions and other required values with TSL compute work;
3. generate depth keys on the GPU;
4. use a GPU radix sort for the complete active splat set;
5. render the sorted indices with one `SOGGaussianSplatMesh`.

No GPU-to-CPU center readback is required on this path.

#### WebGL backend fallback

The initial fallback target is the WebGL backend used by `WebGPURenderer`, not
the classic `WebGLRenderer` API.

When CPU/worker sorting is used, the fallback will:

1. decode the centers from `means_l` and `means_u`;
2. read back only `center.xyz` once during resource preparation;
3. cache those centers in a compact CPU array;
4. run camera-dependent sorting in a worker;
5. upload only the resulting order when it changes.

Rotation, scale, color, opacity, and spherical-harmonic data stay in the native
GPU representation. There must be no per-frame GPU readback.

## Loading and first-frame optimizations

The implementation should adapt the proven optimizations from the existing
`potree-engine` SOG loading path rather than copying its renderer architecture
unchanged.

Required optimization principles are:

- parse the archive once and avoid repeated filename scans;
- decode independent attribute images in parallel;
- use `createImageBitmap()` with `colorSpaceConversion: 'none'` and
  `premultiplyAlpha: 'none'` where supported;
- configure data textures without mipmaps, color conversion, interpolation, or
  vertical flipping;
- transfer `ArrayBuffer` and `ImageBitmap` objects between workers rather than
  cloning large payloads;
- release archive bytes and temporary image objects after successful GPU
  preparation;
- upload textures during `prepare()` instead of delaying uploads until the
  first visible frame;
- prepare codebooks and prewarm shader/compute variants before interaction;
- deduplicate in-flight requests and propagate `AbortSignal`;
- clean up partially created CPU and GPU resources after cancellation or
  failure;
- avoid full CPU decompression of Gaussian attributes;
- record stage timings for download, archive parsing, image decode, GPU upload,
  preparation, and sorting.

Work that must execute on the renderer/device stays on the main thread. Archive
processing, image decoding where supported, and CPU sorting can run in workers.

## Proposed internal boundaries

```text
SOGLoader
  fetch + archive + metadata + image decode
        |
        v
SOGResource
  native images + metadata + codebooks + bounds + lifetime
        |
        v
SOGRenderStore
  backend-specific GPU preparation + active ranges + work buffers
        |
        v
SOGSortBackend
  WebGPU radix sort | WebGL worker/CPU sort
        |
        v
SOGGaussianSplatMesh
  Three.js scene integration + material + draw
```

The public API should keep loading, GPU preparation, sorting, and scene-object
lifetime separate even though the package provides a convenient end-to-end
path.

A provisional resource boundary is:

```ts
interface SOGResource {
  readonly count: number;
  readonly bounds: SOGBounds;
  readonly meta: SOGMetaV2;
  dispose(): void;
}

interface SOGActiveRange {
  readonly resource: SOGResource;
  readonly offset: number;
  readonly count: number;
  readonly matrix: Matrix4;
}
```

Phase one will always have one resource and one full-range `SOGActiveRange`.
Keeping this boundary now prevents the later streamed implementation from
requiring a new renderer contract.

## Three.js integration boundary

- `three` is a peer dependency, not a bundled runtime dependency.
- The implementation uses public exports from `three`, `three/webgpu`, and
  `three/tsl`.
- It must not patch Three.js renderer internals or depend on private helper
  functions from the addon `GaussianSplatMesh` implementation.
- The first compatibility baseline is Three.js r185. Support for earlier or
  later releases is expanded only after adapter tests confirm the required TSL,
  storage-buffer, compute, and backend behavior.
- Backend-specific code belongs behind small adapters so Three.js API changes do
  not affect archive parsing or SOG metadata handling.
- The mesh must participate in the normal Three.js render loop. Applications
  should not need a second canvas or an unrelated renderer.

## Explicit non-goals for the first release

The following features are deliberately outside the initial milestone:

- chunked or streamed SOG loading;
- `lod-meta.json` parsing and octree traversal;
- LOD selection, prefetching, cache budgets, or cooldown eviction;
- aggregation and global sorting of multiple active SOG resources;
- HTTP range access inside compressed SOG archives;
- SOG encoding, conversion, editing, or export;
- support for PLY, SPLAT, KSPLAT, SPZ, or unrelated splat formats;
- classic `WebGLRenderer` integration;
- order-independent transparency or a guarantee of perfect per-pixel Gaussian
  compositing;
- changes to Three.js core solely for this package.

These exclusions keep the first implementation testable without closing the
door to future work.

## Future chunked and LOD SOG direction

Future streaming support can be added above the same `SOGResource` and
`SOGActiveRange` contracts:

```text
lod-meta.json
  -> manifest and octree source
  -> visibility and LOD selection
  -> request scheduler and resource cache
  -> active SOG ranges
  -> global GPU work buffer
  -> one global sort
  -> one aggregated splat draw
```

The important correctness rule is that active splats from different chunks
must be sorted together. Sorting and drawing each chunk independently cannot
guarantee correct alpha composition when chunk depths overlap.

The future subsystem will also need request generations, cancellation, retry,
reference counting, delayed eviction, memory budgets, and an underfill policy
that keeps a coarser LOD visible until its replacement is ready. None of this is
required to complete the single-SOG milestone.

## Implementation roadmap

### Step 1: Project and compatibility scaffold

- configure TypeScript, ESM exports, linting, tests, and build output;
- declare Three.js as a peer dependency;
- establish an r185 compatibility test application;
- add small licensed SOG v2 fixtures and expected metadata;
- define load, abort, error, and dispose contracts.

### Step 2: SOG bundle and resource layer

- implement ZIP bundle parsing and file indexing;
- validate SOG v2 metadata and referenced files;
- implement WebP decoding and codebook preparation;
- add worker messaging and transferable ownership rules;
- implement `SOGResource` and deterministic cleanup;
- test malformed bundles, missing files, cancellation, and repeated loads.

### Step 3: GPU preparation

- create native SOG data textures with exact data-preserving settings;
- implement `prepare(renderer)` and texture pre-upload;
- create the canonical render/work-buffer layout;
- prewarm required material and compute variants;
- release temporary archive and decode memory after preparation.

### Step 4: WebGPU rendering and radix sorting

- implement SOG position, covariance, color, opacity, and SH decoding in TSL;
- implement depth-key generation;
- implement and test GPU radix sorting;
- build `SOGGaussianSplatMesh` and its NodeMaterial;
- integrate camera and object-transform change detection;
- verify depth interaction with ordinary opaque Three.js meshes.

### Step 5: WebGL backend fallback

- implement the backend-compatible SOG texture/render path;
- generate and read back centers once during preparation;
- implement worker sorting and sorted-order uploads;
- verify that camera movement performs no further center readbacks;
- document browser and backend limitations.

### Step 6: Performance hardening

- move archive and CPU sorting work off the main thread;
- add request deduplication, cancellation, and failure cleanup;
- add load-stage timing and memory diagnostics;
- verify that texture upload and pipeline compilation do not move into the
  first interactive frame;
- compare load time, peak CPU memory, GPU memory, and sort time against a
  conventional expanded-geometry path.

### Step 7: Public example and initial release

- provide a minimal loading example and a realistic benchmark scene;
- document renderer creation, resource preparation, disposal, and fallback
  behavior;
- publish the initial package;
- link the repository from the upstream Three.js feature discussion;
- propose a Three.js community example after the API and behavior stabilize.

## Phase-one acceptance criteria

The first milestone is complete when:

- one valid bundled SOG v2 asset loads and renders correctly;
- the complete Gaussian attribute set is not expanded into CPU arrays;
- WebGPU sorting and rendering stay on the GPU;
- the WebGL backend reads back centers at most once per resource and performs no
  per-frame readback;
- `prepare()` moves one-time decode, upload, and pipeline work out of the first
  visible interaction frame;
- splats have the expected depth relationship with opaque Three.js meshes;
- abort, failure, and disposal release temporary and persistent resources;
- automated tests cover parsing, metadata validation, lifecycle, and sort
  correctness;
- the public example requires no modification to Three.js core.

## References

- [Three.js issue #34252: GaussianSplat: Add support for bundled SOG v2](https://github.com/mrdoob/three.js/issues/34252)
- [PlayCanvas Engine SOG/WebGPU reference snapshot (`070709b`)](https://github.com/playcanvas/engine/tree/070709b0256e6bd2484e4c21e908a1b6b9fc73b9)
- [PlayCanvas SOG format documentation](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/)
- [PlayCanvas SOG v2 format proposal](https://github.com/playcanvas/splat-transform/issues/38)
- [Three.js `GaussianSplatMesh`](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/GaussianSplatMesh.js)
