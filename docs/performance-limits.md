# Performance and MVP limits

## Guardrail

The loader rejects resources above 5,000,000 splats. Including adaptive keys,
the exact Portable radix storage is 100,156,900 bytes at that limit; the
24-bit OneSweep layout is 104,005,900 bytes. These figures cover key/value
ping-pong and exact scratch buffers, but not source textures or renderer-owned
uniform storage. The public planning constant remains 52 GPU bytes per splat,
or 260,000,000 bytes at the limit.

The limit does not reserve memory. Decoded browser images, framebuffer targets,
Three.js renderer state, driver allocations, and other scene content add to the
number. Applications should use a lower limit on memory-constrained devices and
benchmark their actual asset, camera motion, SH band, output size, and backend.

## Recorded baseline

### Full-resolution WebGPU interaction baseline

Before replacing the serial WebGPU radix passes, the full 116,374-splat
Millipede fixture was measured in the Codex in-app browser at a 1280x720 CSS
viewport and DPR 2 on 2026-08-16. No splats were removed or decimated.

| State | FPS | Frame p95 | Sort rate | Observation |
| --- | ---: | ---: | ---: | --- |
| Clean untouched idle, 14 s | 60.0 | 17.4 ms | 0 sorts/s | Two preparation sorts, then stable |
| Sustained orbit, 8 s | 19.1 | about 150 ms | 6.8 sorts/s | Serial GPU radix passes dominate |
| Pointer released, 12 s | 13.8 | about 150 ms | 6.9 sorts/s | Frame-dependent damping keeps scheduling sorts |

The control run with only four splats sustained 60 FPS while moving, which
isolates the regression to the scale-dependent sort path. Forced WebGL also
sustained 60 FPS on the full fixture; its Worker sort took about 6.9 ms. These
numbers are the before-optimization reference for the acceptance measurements
below, not general hardware guarantees.

### Dual-radix acceptance result

The WebGPU path generates weighted adaptive camera-depth keys and applies a
stable radix sort. Portable uses 4-bit digits, 2,048 keys per workgroup,
hierarchical Blelloch scans, and stable ranked scatter. OneSweep uses 8-bit
digits, an all-pass histogram, subgroup ranking, chained lookback, and
coalesced scatter, but is never dispatched unless the conservative NVIDIA
subgroup policy admits the active renderer.

The following 180-frame windows were recorded on 2026-08-16 in Headless Chrome
151 at 960x640, DPR 1. `sort timing` is CPU command-submission time for WebGPU
and Worker execution time for forced WebGL, not GPU elapsed time.

| Backend / full model / state | FPS | Frame p95 | Sort rate | Sort timing |
| --- | ---: | ---: | ---: | ---: |
| WebGPU Portable / Millipede / idle | 69.3 | 26.1 ms | 0/s | 0.2 ms |
| WebGPU Portable / Millipede / orbit | 69.0 | 26.1 ms | 68.4/s | 0.1 ms |
| WebGPU Portable / Millipede / recovered | 69.6 | 26.1 ms | 0/s | 0.1 ms |
| WebGPU Portable / Lion SH2 / idle | 69.7 | 26.1 ms | 0/s | 0.1 ms |
| WebGPU Portable / Lion SH2 / orbit | 70.0 | 26.1 ms | 70.0/s | 0.0 ms |
| WebGPU Portable / Lion SH2 / recovered | 69.2 | 26.1 ms | 0/s | 0.0 ms |
| forced WebGL / Millipede / idle | 69.8 | 26.1 ms | 0/s | 7.2 ms |
| forced WebGL / Millipede / orbit | 68.1 | 26.1 ms | 63.0/s | 5.5 ms |
| forced WebGL / Millipede / recovered | 70.9 | 26.1 ms | 0/s | 5.6 ms |
| forced WebGL / Lion SH2 / idle | 67.0 | 27.0 ms | 0/s | 10.2 ms |
| forced WebGL / Lion SH2 / orbit | 67.6 | 27.1 ms | 59.5/s | 8.6 ms |
| forced WebGL / Lion SH2 / recovered | 68.3 | 27.1 ms | 0/s | 8.4 ms |

Portable reported 16 rounded radix bits for both full models. It retained
116,374 and 195,099 active splats, zero readbacks, and zero CPU sort allocation;
estimated total GPU allocations were 4,674,440 and 10,698,036 bytes. Forced
WebGL retained one preparation-time center readback and reported no radix
backend. The local adapter selected Portable with `unsupported-vendor`, so
OneSweep execution remains a compatible-NVIDIA hardware-conditioned result;
r184-r185 compilation and safety-policy coverage passed locally.

Sorting is suppressed on an unchanged view. Consequently this change does not
improve stationary Lion SH2 shading cost: idle frames perform no radix work,
and projection/SH caching remains outside this scope.

### Five-million-splat stress scene

The synthetic CC0 lattice contains exactly 5,000,000 addressable Gaussians in
4096x1221 attribute textures. On the local WebGPU Portable path it prepared in
about 156 ms, selected 20 radix bits, retained zero CPU sort allocation and zero
readbacks, and reported 200,185,316 estimated GPU bytes. At 960x640 DPR 1 the
stationary shading workload measured about 5.6 FPS (178.2 ms average frame,
422.3 ms p95). This is intentionally a memory and overdraw stress case; forced
WebGL automatically redirects it to WebGPU.

The baseline was recorded on 2026-08-15 using macOS arm64, Node v24.14.0, and
Headless Chrome 151 with Three.js 0.185.0. The bundled CC0 fixtures contain four
synthetic splats, so their measurements represent fixed pipeline and loading
cost rather than scalable throughput.

| Backend / fixture | Download | Archive | Decode | Prepare | First visible frame | GPU allocation | Fallback CPU | Readbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| WebGPU / no-SH | 2.4 ms | 12.0 ms | 8.4 ms | 22.0 ms | 4.9 ms | 5,344 B | 1,088 B | 0 |
| WebGPU / SH1 | 2.0 ms | 10.4 ms | 8.6 ms | 23.6 ms | 6.3 ms | 8,448 B | 1,088 B | 0 |
| forced WebGL / no-SH | 1.7 ms | 10.2 ms | 6.1 ms | 94.3 ms | 5.8 ms | 4,272 B | 128 B | 1 |
| forced WebGL / SH1 | 1.9 ms | 10.3 ms | 7.8 ms | 93.9 ms | 8.5 ms | 7,376 B | 128 B | 1 |

All four first-frame runs reported zero deferred source/codebook uploads and zero
deferred required-pipeline compilations. WebGPU reported no center/key/order
readback. The forced WebGL backend reported its single preparation-time center
readback and no readback on camera movement. The largest sampled browser JS heap
after preparation was 14,897,323 bytes; decoded-image and driver allocations may
live outside that heap counter.

A deterministic 250,000-center CPU stress case had a median key-generation plus
stable 32-bit radix-sort time of 14.39 ms across five runs. Compact centers plus
order use 4 MB. The 52-byte native planning estimate is 13 MB, while a simple
fully expanded SH3 layout (position, quaternion, scale, RGBA, and 45 SH floats)
is 59 MB, 4.54 times the planning estimate. At the 5,000,000-splat guardrail,
the planning estimate is 260 MB before the additional allocations listed above.
At that limit, the dual-radix allocation figures at the start of this document
apply in addition to source textures and renderer allocations.

## Methodology

Run `npm run benchmark`. It builds the package, starts the real example, loads
no-SH and SH fixtures through both r185 backends, waits for the first visible
frame, reads structured diagnostics, and runs the deterministic CPU stress
case. Results vary with the browser, driver, GPU, thermal state, and local I/O;
the checked-in baseline is a regression reference, not a cross-device target.

For interaction sampling, open `webgpu_sog.html`, leave the full fixture idle,
then use **Start motion test** for at least five seconds and **Stop motion test**
for a three-second recovery window. Structured state and the on-page JSON record
the backend, active count, viewport, DPR, frame distribution, total sort count,
sort rate, and whether the displayed sort duration is CPU submission or Worker
execution time.

Exact allocation is unit-tested at empty, full-fixture, two-million, and
5,000,000-splat boundaries. Lifecycle tests cover repeated
load/dispose, abort during loading and preparation, renderer/device
initialization loss, and idempotent cleanup.
