# Examples

`webgpu_sog.html` is the public-facing example. Its layout and interaction
structure follow the Three.js `webgpu_gaussian_splatting.html` example: a
full-screen renderer, compact information and license overlays, source
selection, camera fitting, resize handling, and deterministic replacement and
disposal of the current asset.

The implementation is original to this package and uses `SOGLoader` plus
`SOGGaussianSplatMesh` directly. Its no-SH source is the full
116,374-Gaussian Millipede SOG. Its SH source is the complete
195,099-Gaussian, two-band SH Lion model from the Three.js example, transcoded
directly from SPZ v3 without decimation, filtering, or SH-band reduction. The
small synthetic no-SH and SH1 fixtures remain in `index.html` for deterministic
tests and are not presented as public models. The example can switch between
the WebGPU and forced WebGL backends. The legacy `source=millipede` query is
accepted as an alias for `source=no-sh`.

The source selector also exposes a reproducible 5,000,000-splat colored
lattice for WebGPU memory, sorting, and overdraw stress. Generate it with
`npm run generate:5m`; forced WebGL redirects this source to WebGPU.

The Lion fixture also exercises the production SOG v2 SH layout: its metadata
declares a 65,536-entry, two-band palette and its centroid texture is
512×1024. The loader derives this geometry from `shN.count` and `shN.bands`;
the four-row synthetic fixture is not treated as a format-wide height rule.

The overlay reports FPS, average and p95 frame time, CPU submission time, long
frames, total sorts, and sorts per second. **Start motion test** applies a
time-based orbit without changing the active splat count; **Stop motion test**
ends it immediately because the example deliberately disables frame-dependent
damping. A structured snapshot is logged every five seconds and exposed on
`window.__THREE_SOG_EXAMPLE__`, including backend, active count, viewport, DPR,
frame distribution, and an explicit CPU-submission versus Worker-execution sort
timing label.

Design reference:

- https://github.com/mrdoob/three.js/blob/07abea59aa700eed861f23ede39eaf3d892c93a4/examples/webgpu_gaussian_splatting.html
- https://github.com/mrdoob/three.js/blob/6987fe81fb3f5c3f46648eee40c248406e846c3c/examples/models/spz/lion.v3.spz

`index.html` remains the instrumented browser-test harness used for diagnostics,
controlled sort verification, cancellation, and snapshot regression tests.
