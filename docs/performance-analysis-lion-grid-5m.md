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

## Controlled result

| Probe | Logical | GPU-visible | Median GPU render | P95 | Actual splat triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Empty | 0 | 0 | 1.0 ms proxy | — | 0 |
| Ramp | 100,000 | 11,629 | 2.1 ms | 4.7 ms | 23,258 |
| Ramp | 500,000 | 45,495 | 4.8 ms | 7.7 ms | 90,990 |
| Ramp | 1,000,000 | 86,668 | 8.7 ms | 9.6 ms | 173,336 |
| Ramp | 2,000,000 | 168,830 | 10.7 ms | 17.8 ms | 337,660 |
| Full grid, threshold 1 | 4,877,475 | 370,180 | 21.7 ms | 26.4 ms | 740,360 |
| Full grid, culling disabled | 4,877,475 | 4,877,475 | 130.9 ms | 166.8 ms | 9,754,950 |
| Half DPR, area-scaled threshold | 4,877,475 | 370,180 | 18.5 ms | 29.2 ms | 740,360 |
| Quarter DPR, area-scaled threshold | 4,877,475 | 370,180 | 9.6 ms | 10.0 ms | 740,360 |
| Quarter scale, area-scaled threshold | 4,877,475 | 350,673 | 11.9 ms | 14.2 ms | 701,346 |

The live loop reached the page's 60 FPS display ceiling (59.7 FPS sampled).
Three reported about 227.8 MB of tracked renderer memory; library diagnostics
accounted for 183,354,404 bytes. The additional roughly 19.8 MB over the prior
cache is the visible-index and compact block/scan storage, not decompressed
source copies.

At the conservative default threshold of 1, explicit telemetry reported
370,180 visible splats, 497,483 camera/alpha rejections, zero off-screen
rejections for the fitted grid, and 4,009,812 low-contribution rejections. The
categories sum exactly to 4,877,475. The same-view profiler measured 21.7 ms
with culling and 130.9 ms with culling disabled, a 109.2 ms median GPU saving.

The camera-change probe measured 11.7 ms median GPU compute across the shared
radix sort, 4,877,475-entry projection/SH refresh, classification, scan, and
stable scatter. Stationary frames
reported zero compute passes. Preparation-time static dequantization took about
4.4 ms and projection-pipeline warmup about 19.5 ms in the sampled run; archive
and WebP decode remain one-time loader work.

## Before/after

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Live FPS | about 5.1 | 59.7 (display ceiling) | about 11.7× |
| Full GPU render | 247.9–252.0 ms | 21.7 ms | about −91% |
| Draw calls | 51 | 2 | −96% |
| Actual splat triangles | 19,509,900 | 740,360 | −96.2% |
| Estimated splat vertex invocations | 58,529,700 | 1,480,720 | −97.5% |
| Resolution-independent proxy | 139.1 ms | 11.0 ms | −92.1% |
| Fragment/overdraw proxy | 106.7 ms | 10.4 ms | −90.3% |
| Camera-change compute | 0.3 ms sort only | 11.7 ms sort + projection/SH + cull/compact | conditional tradeoff |
| Tracked renderer memory | 55.1 MB | 227.8 MB | +172.7 MB caches/compaction |

This confirms the original diagnosis: decompression was never a per-frame
cost. Static decode, projection, and stable compaction occur only when their
inputs change; the stationary indexed-indirect draw now avoids low-contribution
vertex and fragment work. The remaining measured costs are roughly balanced
between cached screen-space fetch/quad expansion (11.0 ms proxy) and
fragment/blending work (10.4 ms proxy).
