# Examples

`webgpu_sog.html` is the public-facing example. Its layout and interaction
structure follow the Three.js `webgpu_gaussian_splatting.html` example: a
full-screen renderer, compact information and license overlays, source
selection, camera fitting, resize handling, and deterministic replacement and
disposal of the current asset.

The implementation is original to this package and uses `SOGLoader` plus
`SOGGaussianSplatMesh` directly. It loads the full 116,374-Gaussian Millipede
SOG by default and can switch between the WebGPU and forced WebGL backends.

Design reference:

- https://github.com/mrdoob/three.js/blob/07abea59aa700eed861f23ede39eaf3d892c93a4/examples/webgpu_gaussian_splatting.html

`index.html` remains the instrumented browser-test harness used for diagnostics,
controlled sort verification, cancellation, and snapshot regression tests.
