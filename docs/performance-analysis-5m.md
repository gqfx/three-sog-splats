# 5M WebGPU bottleneck analysis

Date: 2026-08-16  
Three.js: 0.185.0  
Scene: `five-million.sog` (5,000,000 synthetic no-SH splats)  
Viewport: 1280×720 CSS pixels, DPR 2 (2560×1440 drawing buffer)  
Backend: WebGPU, Portable radix (20 bits, `unsupported-vendor` selection)

The Example's controlled profiler pauses the animation loop, warms up every
configuration, takes five GPU render samples per draw scenario, takes three
camera-change sort samples, then restores all scene and animation state. GPU
durations come from Three's public timestamp-query API; CPU submission excludes
timestamp readback latency.

## Results

| Probe | Instances | DPR | Model scale | Median GPU render | CPU submit | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Empty pass | 0 | 2 | 1 | 0.9 ms completion proxy | 0.2 ms | 1 |
| Instance ramp | 100,000 | 2 | 1 | 9.8 ms | 0.1 ms | 400,001 |
| Instance ramp | 500,000 | 2 | 1 | 48.2 ms | 0.4 ms | 2,000,001 |
| Instance ramp | 1,000,000 | 2 | 1 | 111.1 ms | 0.5 ms | 4,000,001 |
| Instance ramp | 2,000,000 | 2 | 1 | 245.3 ms | 0.7 ms | 8,000,001 |
| Full scene | 5,000,000 | 2 | 1 | 350.9 ms | 0.6 ms | 20,000,001 |
| Half DPR | 5,000,000 | 1 | 1 | 204.3 ms | 0.6 ms | 20,000,001 |
| Quarter DPR | 5,000,000 | 0.5 | 1 | 176.0 ms | 0.7 ms | 20,000,001 |
| Quarter model scale | 5,000,000 | 2 | 0.25 | 286.9 ms | 0.6 ms | 20,000,001 |

The live loop showed roughly 3–4 FPS. The renderer reported 244,626,060 bytes
of tracked memory, while the SOG render diagnostics accounted for 200,185,316
bytes of source textures and sorting resources.

The camera-change probe sorted all 5,000,000 entries while rendering one
instance. Portable radix took 7.1 ms median GPU compute (10.4 ms p95), with one
grouped compute submission. Stationary frames do not submit that sort.

## Attribution

A linear fit across full, half, and quarter DPR separates work that changes
with drawing-buffer pixel area from work that remains when the pixel count is
reduced:

1. **Fragment blending and overdraw: approximately 189.1 ms.** The full scene
   falls from 350.9 ms to 204.3 ms at half DPR and 176.0 ms at quarter DPR.
   Every splat is transparent, `depthWrite` is disabled, and the dense lattice
   causes many blended fragments to cover the same pixels.
2. **Per-instance vertex and attribute decoding: approximately 160.1 ms.** The
   full probe reports 20,000,001 triangles and approximately 60,000,003 vertex
   shader invocations. The no-SH vertex path reads the sort order, decodes the
   center, quaternion, scale, and color from textures/codebooks, and computes
   projected covariance for every quad corner. Quartering model scale still
   leaves 81.8% of full GPU render time, confirming a large footprint-insensitive
   component.
3. **Camera-motion radix sort: 7.1 ms, conditional.** This is roughly 2% of the
   full render duration and is absent while the camera is stationary. It is not
   the cause of the persistent low FPS.
4. **CPU command submission: 0.6 ms.** JavaScript and command encoding are not
   limiting the stationary frame.
5. **Fixed render overhead: about 0.9 ms.** This is negligible.

The unexpected 2× triangle count is directly explained by the material setup:
the splat material is transparent and `DoubleSide`, with `forceSinglePass` left
at its default. Three renders such a material in two geometry passes. The third
reported draw call and final triangle are the renderer's output conversion
pass. This double pass is unnecessary work for screen-aligned Gaussian quads.

## Recommended optimization order

1. Set `material.forceSinglePass = true` (or use one-sided rendering if visual
   verification confirms consistent winding). This targets the measured 2×
   splat draw/triangle expansion. Three explicitly recommends single-pass mode
   for flat transparent sprites where the second pass adds no quality.
2. Add projected-size/visibility culling and an LOD or per-tile splat budget.
   The current path submits every one of the 5,000,000 splats, including tiny or
   heavily occluded contributors.
3. Move per-splat decode and projected conic work to a once-per-instance compute
   stage or cached GPU buffer. The current vertex path repeats the same source
   texture/codebook decode for each quad corner and again in the second side
   pass.
4. Reduce overdraw with tile/cluster culling, small-alpha rejection before
   rasterization, and dynamic DPR. The measured half-DPR result is an immediate
   quality/performance tradeoff and a useful fallback while structural work is
   developed.
5. Do not prioritize another radix backend for stationary FPS. Revisit sorting
   only after the two render bottlenecks are reduced enough for its 7.1 ms
   motion-only cost to become material.

References:

- Three.js Material `forceSinglePass`: https://threejs.org/docs/pages/Material.html
- Three.js timestamp query backend API: https://threejs.org/docs/pages/Backend.html
