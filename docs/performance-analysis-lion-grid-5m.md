# 4.88M runtime Lion grid optimization result

Date: 2026-08-16

Three.js: 0.185.0

Source: one full 195,099-splat SH2 Lion, batched into 25 translated copies

Logical render count: 4,877,475 splats

Viewport: 1280×720 CSS pixels, DPR 2 (2560×1440 drawing buffer)

Backend: WebGPU, Portable radix (16 bits, `unsupported-vendor` selection)

The Example downloads and decodes the existing 3,287,509-byte `lion.sog`
once. It now submits the 5×5 grid as one batched splat draw. All copies share
one source payload, one static dequantization cache, and one 195,099-entry depth
order; only their camera-dependent projected centers, ellipses, and SH colors
have per-copy cache entries.

## Implemented hot-path changes

1. Transparent `DoubleSide` sprites set `forceSinglePass = true`.
2. The quad uses four indexed corners instead of six duplicated vertices.
3. A preparation compute pass dequantizes center, quaternion, scale, base color,
   SH labels, and the SH palette once into compact GPU storage.
4. Camera/model changes run two compute stages: the existing shared radix sort
   and a projection/SH refresh. Unchanged frames run zero compute passes.
5. The vertex shader reads cached clip center, packed ellipse, and packed color;
   it no longer samples SOG textures, runs exponentials, reconstructs
   quaternions, evaluates SH2, or calculates covariance every frame.
6. Projected caching is adaptive. It is enabled for batched copies and resources
   up to one million unique splats. A single larger unique resource keeps the
   indexed single-pass path to avoid hundreds of megabytes of unhelpful cache.

## Controlled result

| Probe | Instances | DPR | Scale | Median GPU render | CPU submit | Draw calls | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Empty | 0 | 2 | 1 | 1.4 ms proxy | 0.1 ms | 1 | 1 |
| Ramp | 100,000 | 2 | 1 | 6.9 ms | 0.1 ms | 2 | 200,001 |
| Ramp | 500,000 | 2 | 1 | 35.8 ms | 0.4 ms | 2 | 1,000,001 |
| Ramp | 1,000,000 | 2 | 1 | 47.4 ms | 0.4 ms | 2 | 2,000,001 |
| Ramp | 2,000,000 | 2 | 1 | 107.2 ms | 0.5 ms | 2 | 4,000,001 |
| Full grid | 4,877,475 | 2 | 1 | 138.3 ms | 0.6 ms | 2 | 9,754,951 |
| Half DPR | 4,877,475 | 1 | 1 | 125.0 ms | 0.5 ms | 2 | 9,754,951 |
| Quarter DPR | 4,877,475 | 0.5 | 1 | 50.9 ms | 0.4 ms | 2 | 9,754,951 |
| Quarter scale | 4,877,475 | 2 | 0.25 | 52.4 ms | 0.3 ms | 2 | 9,754,951 |

The live loop stabilized around 9 FPS. Three reported about 207.9 MB of tracked
renderer memory; library diagnostics accounted for about 163.5 MB. The extra
memory is the deliberate projected cache, not 25 decompressed source copies.

The camera-change probe measured 12.4 ms median GPU compute across the shared
radix sort and the 4,877,475-entry projection/SH refresh. Stationary frames
reported zero compute passes. Preparation-time static dequantization took about
4.4 ms and projection-pipeline warmup about 19.5 ms in the sampled run; archive
and WebP decode remain one-time loader work.

## Before/after

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Live FPS | about 5.1 | about 9.2 | about +80% |
| Full GPU render | 247.9–252.0 ms | 137–138 ms | about −45% |
| Draw calls | 51 | 2 | −96% |
| Triangles | 19,509,901 | 9,754,951 | −50% |
| Estimated splat vertex invocations | 58,529,700 | 19,509,900 | −67% |
| Resolution-independent proxy | 139.1 ms | 72.0 ms | −48% |
| Fragment/overdraw proxy | 106.7 ms | 71.7 ms | −33% |
| Camera-change compute | 0.3 ms sort only | 12.4 ms sort + projection/SH | conditional tradeoff |
| Tracked renderer memory | 55.1 MB | 207.9 MB | +152.8 MB cache |

This confirms the original diagnosis: decompression was never a per-frame
cost. The optimization moves shader dequantization and projection out of the
stationary frame in exchange for a bounded cache and more work only when the
view changes. The remaining roughly equal bottlenecks are cached per-instance
fetch/quad expansion and fragment blending/overdraw.
