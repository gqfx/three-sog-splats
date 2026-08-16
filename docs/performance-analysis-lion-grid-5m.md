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
7. Camera/model/viewport changes classify the sorted logical stream using
   center alpha, camera/frustum visibility, and opacity-weighted projected
   covariance area. Workgroup counts are hierarchically scanned and survivors
   are scattered as a stable subsequence.
8. A five-word indexed-indirect command draws only the GPU-produced survivor
   count. Stationary frames run neither projection nor culling compute.
9. Cached RGBA quantization uses an explicit `uvec4` conversion before bit
   packing, preserving independent red, green, blue, and alpha channels.

## Controlled result

| Probe | Logical | GPU-visible | Median GPU render | P95 | Actual splat triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Empty | 0 | 0 | 1.1 ms proxy | — | 0 |
| Ramp | 100,000 | 8,018 | 2.0 ms | 4.6 ms | 16,036 |
| Ramp | 500,000 | 30,283 | 3.4 ms | 3.9 ms | 60,566 |
| Ramp | 1,000,000 | 55,654 | 4.7 ms | 8.5 ms | 111,308 |
| Ramp | 2,000,000 | 107,466 | 9.5 ms | 18.1 ms | 214,932 |
| Full grid, threshold 1 | 4,877,475 | 243,357 | 18.9 ms | 26.1 ms | 486,714 |
| Full grid, culling disabled | 4,877,475 | 4,877,475 | 147.7 ms | 166.2 ms | 9,754,950 |
| Half DPR, area-scaled threshold | 4,877,475 | 243,357 | 18.0 ms | 27.1 ms | 486,714 |
| Quarter DPR, area-scaled threshold | 4,877,475 | 243,357 | 11.3 ms | 12.3 ms | 486,714 |
| Quarter scale, area-scaled threshold | 4,877,475 | 234,275 | 12.5 ms | 14.7 ms | 468,550 |

The live loop reached the page's 60 FPS display ceiling (59.7 FPS sampled).
Three reported about 227.8 MB of tracked renderer memory; library diagnostics
accounted for 183,354,404 bytes. The additional roughly 19.8 MB over the prior
cache is the visible-index and compact block/scan storage, not decompressed
source copies.

At the conservative default threshold of 1, explicit telemetry reported
243,357 visible splats, 31,100 camera/alpha rejections, zero off-screen
rejections for the fitted grid, and 4,603,018 low-contribution rejections. The
categories sum exactly to 4,877,475. The same-view profiler measured 18.9 ms
with culling and 147.7 ms with culling disabled, a 128.8 ms median GPU saving.

The camera-change probe measured 11.8 ms median GPU compute across the shared
radix sort, 4,877,475-entry projection/SH refresh, classification, scan, and
stable scatter. Stationary frames
reported zero compute passes. Preparation-time static dequantization took about
4.2 ms and projection-pipeline warmup about 31.8 ms in the sampled run; archive
and WebP decode remain one-time loader work.

## Before/after

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Live FPS | about 5.1 | 59.7 (display ceiling) | about 11.7× |
| Full GPU render | 247.9–252.0 ms | 18.9 ms | about −92.4% |
| Draw calls | 51 | 2 | −96% |
| Actual splat triangles | 19,509,900 | 486,714 | −97.5% |
| Estimated splat vertex invocations | 58,529,700 | 973,428 | −98.3% |
| Resolution-independent proxy | 139.1 ms | 12.3 ms | −91.2% |
| Fragment/overdraw proxy | 106.7 ms | 6.1 ms | −94.3% |
| Camera-change compute | 0.3 ms sort only | 11.8 ms sort + projection/SH + cull/compact | conditional tradeoff |
| Tracked renderer memory | 55.1 MB | 227.8 MB | +172.7 MB caches/compaction |

This confirms the original diagnosis: decompression was never a per-frame
cost. Static decode, projection, and stable compaction occur only when their
inputs change; the stationary indexed-indirect draw now avoids low-contribution
vertex and fragment work. The largest remaining measured cost is cached
screen-space fetch/quad expansion (12.3 ms proxy), followed by
fragment/blending work (6.1 ms proxy).
