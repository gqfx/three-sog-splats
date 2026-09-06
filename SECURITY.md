# Security policy

The current 0.1.x series is experimental. Security fixes target the latest
0.1.x release and the documented Three.js peer range.

For a suspected vulnerability, use GitHub's private reporting form when it is
available: https://github.com/gqfx/three-sog-splats/security/advisories/new.
If the form is unavailable, open an issue asking the maintainer for a private
contact, without including exploit details or sensitive models. Private
vulnerability reporting is a repository setting that the maintainer must enable.

Include the affected version, browser/backend, a minimal synthetic input,
reproduction steps and the expected versus observed behavior. Do not include
credentials, private customer assets, or destructive payloads.

The loader limits download bytes, actual ZIP output, encoded image dimensions,
decoded image bytes and decode concurrency. Prepare checks texture/device limits
and tracked GPU budgets. Lower these limits for constrained devices. A custom
fetch or decoder is trusted application code; custom decoders must enforce their
own allocation limits before returning an image. Their returned dimensions are
also checked by the loader.

These budgets do not measure total browser/driver memory. Workers reduce main
thread work but do not isolate CPU or memory exhaustion. Do not disable resource
limits for arbitrary uploads. No model executes scripts as part of SOG parsing.
