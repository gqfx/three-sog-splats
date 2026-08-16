# Three.js compatibility audit

## Result

The minimum supported Three.js release is r184 (`three@0.184.0`). The tested
peer window is `>=0.184.0 <0.186.0`: r184 is the lower-bound compatibility run,
and r185 is the pinned development and current acceptance version.

The package integrates directly with public `three`, `three/webgpu`, and
`three/tsl` exports. It has no renderer adapter and does not import
`three/src/*`, `three/build/*`, or private renderer modules.

## Public-source audit

| Release | Public capability relevant to this package | Conclusion |
| --- | --- | --- |
| r167 | Introduced the separately consumable WebGPU/TSL build used through `three/webgpu` | Necessary foundation, but insufficient |
| r180 | Exposes `floatBitsToUint`, used to generate sortable IEEE-754 depth keys without GPU readback | Necessary for the WebGPU sorter, but insufficient |
| r183 | Exposes explicit render-target initialization used by the WebGL preparation readback | Rendering starts, but deterministic storage-buffer disposal and program-memory diagnostics are absent |
| r184 | Public TSL storage atomics and `modelWorldMatrixInverse`, plus `BufferAttribute.dispose()` and renderer program-memory diagnostics | First release satisfying parallel sorting, transformed SH rendering, diagnostics, and deterministic cleanup |
| r185 | Current pinned development version | Fully accepted |

Primary sources:

- [Three.js r167 release](https://github.com/mrdoob/three.js/releases/tag/r167)
- [Three.js r180 TSL bitcast implementation](https://github.com/mrdoob/three.js/blob/r180/src/nodes/utils/BitcastNode.js)
- [Three.js r183 common renderer API](https://github.com/mrdoob/three.js/blob/r183/src/renderers/common/Renderer.js)
- [Three.js r184 BufferAttribute lifecycle API](https://github.com/mrdoob/three.js/blob/r184/src/core/BufferAttribute.js)
- [Three.js r184 renderer information API](https://github.com/mrdoob/three.js/blob/r184/src/renderers/common/Info.js)
- [Three.js r184 model matrix node exports](https://github.com/mrdoob/three.js/blob/r184/src/nodes/accessors/ModelNode.js)

## Runtime verification

The same nine Playwright cases were run against the official r184 and r185 npm
artifacts in Headless Chrome with WebGPU enabled. Both runs passed:

- internal synthetic no-SH and SH SOG rendering on WebGPU;
- internal synthetic no-SH and SH rendering on the forced WebGL backend;
- the full-resolution 116,374-Gaussian Three.js Millipede SOG on both backends;
- the public example's stationary suppression, deterministic motion/recovery,
  backend switching, structured telemetry, and full-resolution Millipede no-SH
  and 195,099-Gaussian Lion SH2 snapshots on both backends;
- local-space SH evaluation for a rotated object and top-to-bottom WebGL center
  indexing before Worker sorting;
- known-value WebP data decoding.

The r183 audit was intentionally treated as a negative boundary test. The scene
could render, but storage attributes lacked the public disposal event API and
the program-memory counter was unavailable. Claiming r183 support would violate
the MVP's deterministic cleanup and first-visible-frame diagnostics contracts.

For a local lower-bound browser run, point the example Vite config at an
unpacked official Three.js package:

```bash
THREE_COMPAT_ROOT=/path/to/three-r184 npm run test:browser
```
