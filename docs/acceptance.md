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
| WebGPU path | Parallel 16-bit depth-bucket counting sort, GPU order consumption, camera invalidation, static suppression, zero production readbacks, and a controlled test-only readback proving complete permutation and monotonic bucket order | Pass |
| forced WebGL fallback | One center readback with framebuffer-row normalization, Worker sort and pooled result transfer, instanced order upload, static suppression, stale-result disposal | Pass |
| Scene/depth integration | Tolerant browser baselines include object transform and an opaque foreground occluder; depth test on and depth writes off | Pass |
| Real assets | All 116,374 Millipede Gaussians and all 195,099 Lion Gaussians with SH2 from Three.js converted directly to SOG without decimation; WebGPU and forced WebGL snapshots | Pass |
| Public example | Three.js-style standalone page, real SH model selection, source replacement, camera fitting, attribution, deterministic motion/recovery control, structured performance diagnostics, WebGPU/WebGL selection, and production build | Pass |
| First visible frame | Diagnostics and integration checks report zero deferred required uploads/compiles after `prepare()` | Pass |
| External package | `npm pack`, temporary TypeScript consumer at the r184 lower bound, peer resolution, declarations, Vite build/startup, external imports, forbidden-code scan | Pass |
| Limits and performance | Full-resolution before/after browser timings, 60 FPS WebGPU motion at 1280x720 DPR 2, CPU stress comparison, exact sort allocation, and the 2,000,000-splat guardrail | Pass |

Release validation is run with `npm run test:acceptance`, which includes the
browser and external-consumer gates. The final command record is updated
whenever the compatibility baseline or fixture output changes.

Final run: typecheck, lint, declaration and example builds, 55 unit/integration
tests, 9 real-browser tests on both r184 and r185, and the external
package-consumer check all passed. The browser run exercised WebGPU and forced
WebGL for synthetic no-SH/SH fixtures and the full-resolution
116,374-Gaussian Millipede fixture without decimation. The two public-example
cases also loaded and visually compared the complete 195,099-Gaussian Lion SH2
fixture without decimation, filtering, or SH-band reduction.

The real SH regression also verifies that `shN.count` and `shN.bands` drive the
centroid-palette geometry, object transforms evaluate SH in local space, and
the WebGL framebuffer readback is restored to the SOG texture's top-to-bottom
index order before Worker sorting.
