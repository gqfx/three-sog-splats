# Performance and MVP limits

## Guardrail

The loader rejects resources above 2,000,000 splats. The WebGPU sorter uses
exact-size bucket and order buffers plus two fixed 65,536-entry tables, totaling
16,524,288 bytes at that limit. The public planning constant remains 52 GPU
bytes per splat, or 104,000,000 bytes at the limit. This deliberately
overestimates the current compact no-SH layout and leaves room for the SH label,
sort storage, and alignment costs.

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

### Parallel-sort acceptance result

The optimized path maps ordered IEEE-754 camera depth to 65,536 buckets. GPU
workgroups reset the tables, decode centers and atomically build the histogram,
and scatter the complete order. Only the exclusive prefix over the fixed table
is serial. Source textures, buckets, and order remain GPU-resident during normal
rendering; the implementation does not reduce the active set.

The same full fixture was measured after the change in the same Codex in-app
browser environment:

| Backend / state | FPS | Frame p95 | Sort rate | Latest sort timing |
| --- | ---: | ---: | ---: | ---: |
| WebGPU idle | 60.0 | 18.6 ms | 0 sorts/s | 0.0 ms CPU submission |
| WebGPU sustained orbit, 5.3 s | 60.0 | 18.5 ms | 60 sorts/s | 0.2 ms CPU submission |
| WebGPU recovered, 3.2 s | 60.0 | 18.5 ms | 0 sorts/s | 0.1 ms CPU submission |
| forced WebGL idle | 60.0 | 18.7 ms | 0 sorts/s | 6.5 ms Worker execution |
| forced WebGL sustained orbit, 5.3 s | 60.0 | 17.9 ms | 60 sorts/s | 6.7 ms Worker execution |
| forced WebGL recovered, 3.2 s | 60.0 | 17.9 ms | 0 sorts/s | 6.7 ms Worker execution |

All WebGPU samples retained 116,374 active splats and zero readbacks. Forced
WebGL retained its single preparation-time center readback. The complete r184
and r185 nine-test browser matrices and existing full-fixture snapshots passed.
Relative order inside one 16-bit depth bucket is unspecified; complete
permutation, monotonic bucket order, and snapshot tolerances are the acceptance
criteria for that approximation.

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
is 59 MB, 4.54 times the planning estimate. At the 2,000,000-splat guardrail,
the planning estimate is 104 MB before the additional allocations listed above.
At that limit, the exact-size WebGPU counting-sort buffers retain 16,524,288
bytes of typed-array backing in addition to their GPU allocation.

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

Exact allocation is unit-tested at empty, full-fixture, and 2,000,000-splat
boundaries. Lifecycle tests cover repeated
load/dispose, abort during loading and preparation, renderer/device
initialization loss, and idempotent cleanup.
