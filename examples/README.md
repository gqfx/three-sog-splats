# Examples

`webgpu_sog.html` is the public-facing example. Its layout and interaction
structure follow the Three.js `webgpu_gaussian_splatting.html` example: a
full-screen renderer, compact information and license overlays, source
selection, camera fitting, resize handling, and deterministic replacement and
disposal of the current asset.

The implementation is original to this package and uses `SOGLoader` plus
`SOGGaussianSplatMesh` directly. It loads the full 116,374-Gaussian Millipede
SOG by default and can switch between the WebGPU and forced WebGL backends.
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

`index.html` remains the instrumented browser-test harness used for diagnostics,
controlled sort verification, cancellation, and snapshot regression tests.
