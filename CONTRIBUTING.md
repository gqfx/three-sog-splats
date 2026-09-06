# Contributing

Use Node.js 24 (see .nvmrc); the minimum development version is 22.12.0.

```sh
npm ci --ignore-scripts
npm run fixtures:fetch
npm run fixtures:verify
npm run test:acceptance
```

Small fixtures are tracked. Moon is reconstructed from pinned upstream native
files by fixtures:fetch and is ignored by Git. Every input and the final archive
must match tests/fixtures/manifest.json. The downloader never silently replaces
a changed local fixture. Synthetic fixture changes require updating their
manifest hashes and reviewing expected values; do not update image baselines to
hide a rendering regression.

The browser suite uses system Chrome on macOS and Playwright Chromium elsewhere.
Install Chromium with `npx playwright install --with-deps chromium` on Linux, or
set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Set SOG_REQUIRE_WEBGPU=1 to fail if a
WebGPU adapter is unavailable. A skipped GPU test is not GPU validation.
OneSweep execution requires admitted NVIDIA hardware and is not certified by
Portable results.

Keep tests focused on behavior: malformed input budgets, ownership on failure,
continuous slow-worker updates, independently expected GPU pixels and a real
consumer of the packed production build. The supported renderer is
WebGPURenderer, including its forceWebGL backend. WebXR, overlapping independent
splat meshes with global transparency ordering and arbitrary mobile hardware are
not currently certified.

Before a release, run `SOG_REQUIRE_WEBGPU=1 npm run test:acceptance` on a supported
GPU, review dependency audit results, and record the source commit/worktree hash,
environment, executed cases and any hardware-conditioned skips. GitHub Actions
validate the supported Node and Three.js matrix. Remote workflow execution and
branch protection are repository settings, not established by local tests.

`npm pack` builds and checks entry points, workers and source maps automatically.
`npm run test:package` starts production consumers of the tarball on both r184
and r185, loads an SH model, verifies worker startup, renders and disposes it.
`npm publish` invokes the full acceptance gate; publishing still requires an
explicit maintainer action. Retain THIRD_PARTY_NOTICES and model attributions.

Use `npm run benchmark:release` for repeatable local production measurements;
`SOG_BENCH_NETWORK=1 npm run benchmark:release` also samples a 50 Mbps / 40 ms
network profile. Report viewport, DPR, hardware, sample length and cache state.
