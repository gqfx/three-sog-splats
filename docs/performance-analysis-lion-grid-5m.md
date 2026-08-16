# 4.88M runtime Lion grid bottleneck analysis

Date: 2026-08-16  
Three.js: 0.185.0  
Source: one full 195,099-splat SH2 Lion, instanced 25 times at runtime  
Logical render count: 4,877,475 splats  
Viewport: 1280×720 CSS pixels, DPR 2 (2560×1440 drawing buffer)  
Backend: WebGPU, Portable radix (16 bits, `unsupported-vendor` selection)

This scene was added to distinguish the adversarial overdraw of the synthetic
5M lattice from costs that remain with real captured Gaussian data. The Example
downloads the existing 3,287,509-byte `lion.sog` once and prepares one set of
textures, SH2 palette, material, and sort resources. Twenty-four lightweight
draw meshes share those resources with the prepared SOG mesh and apply distinct
XY translations, forming a non-overlapping 5×5 Lion grid.

## Results

| Probe | Logical instances | DPR | Model scale | Median GPU render | CPU submit | Draw calls | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Empty pass | 0 | 2 | 1 | 1.0 ms completion proxy | 0.1 ms | 1 | 1 |
| Instance ramp | 100,000 | 2 | 1 | 9.3 ms | 0.2 ms | 3 | 400,001 |
| Instance ramp | 500,000 | 2 | 1 | 36.9 ms | 0.6 ms | 7 | 2,000,001 |
| Instance ramp | 1,000,000 | 2 | 1 | 71.4 ms | 0.7 ms | 13 | 4,000,001 |
| Instance ramp | 2,000,000 | 2 | 1 | 131.3 ms | 0.6 ms | 23 | 8,000,001 |
| Full Lion grid | 4,877,475 | 2 | 1 | 247.9 ms | 0.9 ms | 51 | 19,509,901 |
| Half DPR | 4,877,475 | 1 | 1 | 161.7 ms | 1.0 ms | 51 | 19,509,901 |
| Quarter DPR | 4,877,475 | 0.5 | 1 | 150.9 ms | 1.1 ms | 51 | 19,509,901 |
| Quarter model scale | 4,877,475 | 2 | 0.25 | 149.2 ms | 1.1 ms | 51 | 19,509,901 |

The live loop stabilized around 5 FPS. Library diagnostics account for only
10,698,036 bytes of source textures and sorting resources because the source is
prepared once. Three's total tracked renderer memory was 55,116,474 bytes,
including the renderer, pipelines, and the lightweight per-copy geometries.

## Attribution and lattice comparison

The controlled DPR fit attributes approximately 139.1 ms to resolution-
independent per-instance vertex/attribute/SH work and 106.7 ms to pixel-scaled
fragment blending and overdraw.

| Metric | Synthetic lattice 5M | Runtime Lion grid 4.88M | Difference |
| --- | ---: | ---: | ---: |
| Full GPU render | 350.9 ms | 247.9 ms | −103.0 ms (−29%) |
| Fragment/overdraw proxy | 189.1 ms | 106.7 ms | −82.4 ms (−44%) |
| Per-instance proxy | 160.1 ms | 139.1 ms | −21.0 ms (−13%) |
| CPU submission | 0.6 ms | 0.9 ms | +0.3 ms |

The lattice therefore does materially exaggerate overdraw, but it does not
create the entire performance problem. The real-data grid still submits about
58.5 million vertex shader invocations and 19.5 million triangles. Transparent
`DoubleSide` rendering produces two splat draws per Lion plus one output pass,
which explains the 51 draw calls. Removing the unnecessary second splat pass
and reducing per-vertex decode remain the first structural optimizations.

The grid's 0.3 ms camera-sort result is intentionally not comparable with the
lattice's 7.1 ms 5M sort: all translated copies share one 195,099-entry order
buffer, and translation adds the same view-space depth constant to every splat
inside a copy. The scene is valid for stationary render/overdraw comparison;
it is not a benchmark for sorting 4.88 million unique centers.
