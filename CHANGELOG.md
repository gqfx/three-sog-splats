# Changelog

## Unreleased

- Reject actual DEFLATE output exceeding declared sizes; bound streaming inflate
  work and replace bitwise CRC with table-driven CRC-32.
- Check PNG/WebP dimensions before browser allocation, reject animated images,
  enforce per-image and total decoded budgets, and bound concurrent decodes.
- Reuse loader-scoped image workers; avoid eagerly copying fallback Blobs and
  close bitmaps that arrive after cancellation.
- Apply monotonically newer completed WebGL orders during continuous motion;
  reuse radix scratch arrays and remove Three.js from the sort worker runtime.
- Preserve native DC/scale labels in the WebGPU cache and clamp colors after SH;
  store projected ellipses in Float32 to avoid Float16 overflow/underflow.
- Restore application render targets before asynchronous center readback and use
  the current render-target/viewport dimensions for contribution culling.
- Reject numeric decode overflow and incompatible device/buffer limits. Replace
  the fixed unique-count cache cutoff with configurable GPU/cache byte budgets.
- Build and check clean npm packs, include mapping sources, and exercise real
  published workers and rendering in production consumers on r184/r185.
- Add CI, dependency updates, security/contribution guidance and reproducible
  hash-verified Moon downloads without committing the large archive to Git.
