# Phase-one acceptance record

Date: 2026-08-16

Compatibility window: Three.js 0.184.0-0.185.0

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Bundled SOG v2 loading and validation | Stored/deflated fixtures; invalid ZIP, encryption, Zip64, metadata, file, codebook, SH-pair, count, band, palette-count, and full-height SH texture dimension tests | Pass |
| Native representation | Resource tests assert no expanded position/covariance/color/SH arrays; WebP and codebooks remain native | Pass |
| Cancellation and ownership | In-flight dedupe, per-caller detach, final-consumer abort, reverse cleanup, repeated idempotent disposal | Pass |
| Direct Three.js API boundary | No renderer adapter; contract scan over every source file; clean official r184/r185 builds used in browser tests | Pass |
| Explicit preparation | Texture/codebook initialization, initial sort, material/compute compilation, visibility gate, abort/failure cleanup | Pass |
| WebGPU path | Weighted adaptive keys, stable 4-bit Portable radix, guarded 8-bit OneSweep, GPU order consumption, one-time static dequantization, camera-change projection/SH cache, stable contribution/frustum compaction, indexed indirect drawing, stationary compute suppression, zero production readbacks, and explicit sort/culling verification | Pass |
| Radix safety policy | Deterministic admission tests reject missing subgroup signals, non-NVIDIA/ambiguous adapters, custom devices, and unsafe subgroup sizes; local browser reports Portable with `unsupported-vendor` | Pass |
| forced WebGL fallback | One center readback with framebuffer-row normalization, Worker sort and pooled result transfer, instanced order upload, static suppression, stale-result disposal | Pass |
| Scene/depth integration | Tolerant browser baselines include object transform and an opaque foreground occluder; depth test on and depth writes off | Pass |
| Real assets | All 116,374 Millipede Gaussians and all 195,099 Lion Gaussians with SH2 from Three.js converted directly to SOG without decimation; WebGPU and forced WebGL snapshots | Pass |
| Public example | Three.js-style standalone page, real no-SH and SH model selection, one-download/one-draw 25-copy Lion grid, source replacement, camera fitting, attribution, dual-backend snapshots, deterministic motion/recovery control, structured GPU bottleneck profiling, WebGPU/WebGL selection, and production build | Pass |
| First visible frame | Diagnostics and integration checks report zero deferred required uploads/compiles after `prepare()` | Pass |
| External package | `npm pack`, temporary TypeScript consumer at the r184 lower bound, peer resolution, declarations, Vite build/startup, external imports, forbidden-code scan | Pass |
| Limits and performance | Full-resolution idle/orbit/recovery timings for Millipede and Lion on both backends, a real 5,000,000-splat WebGPU stress scene, a 4,877,475-splat runtime Lion grid sharing one 195,099-splat payload, controlled GPU render/compute attribution, exact dual-radix allocation, zero-readback checks, and the 5,000,000-splat guardrail | Pass |

Release validation is run with `npm run test:acceptance`, which includes the
browser and external-consumer gates. The final command record is updated
whenever the compatibility baseline or fixture output changes.

Final run: typecheck, lint, declaration and example builds, 110 unit/integration
tests, 13 real-browser tests on both r184 and r185, and the external
package-consumer check all passed. The browser run exercised WebGPU and forced
WebGL for internal synthetic no-SH/SH fixtures and the full-resolution
116,374-Gaussian Millipede fixture without decimation. The two public-example
cases loaded and visually compared both real public choices: Millipede no-SH
and the complete 195,099-Gaussian Lion SH2 fixture without decimation,
filtering, or SH-band reduction.

The WebGPU browser run also constructed a 5×5 Lion grid with 4,877,475 logical
splats from one `/lion.sog` request and one prepared GPU payload. It verified 25
runtime copies batched into one splat draw, 2 full-frame draw calls, 9,754,951
triangles, zero stationary compute passes, no expanded grid fixture request,
and successful controlled full/half/quarter-DPR plus contribution-culling on/off
profiling. Default threshold 1 submitted 370,180 survivors; explicit counters
partitioned all 4,877,475 logical splats. The full-view A/B measured 21.7 ms
with stable compaction and 130.9 ms with culling disabled.

The local Chrome adapter was not an admitted NVIDIA target. Its OneSweep
result is therefore explicitly hardware-conditioned: source/API compilation
and deterministic policy coverage passed on r184-r185, while execution was
skipped with `unsupported-vendor`; Portable executed the full browser matrix.

The real SH regression also verifies that `shN.count` and `shN.bands` drive the
centroid-palette geometry, object transforms evaluate SH in local space, and
the WebGL framebuffer readback is restored to the SOG texture's top-to-bottom
index order before Worker sorting.
