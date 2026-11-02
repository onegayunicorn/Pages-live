# sandboxd roadmap (re-based)

This roadmap condenses the supplied **“sandboxd — Full Analysis & Roadmap”** and re-bases its priorities on the files that are actually present in this checkout. The source report describes a Docker-backed system as already implemented, but this repository snapshot has a key gap: a Docker-backed API is present, while the browser Operations interface remains simulated and is not connected to it. The Docker runtime also has not been exercised against a real rootless host. Do not treat those two items as completed validation.

## Current baseline

- **Static portal and Bridge:** present. The Bridge JPEG/claim/verifier bundle is generated and its external artifact digest is checked by tests. SHA-256 establishes byte integrity, not identity or authorship.
- **Docker API:** present as a separate Node service with bearer-token checks, a rootless-Docker requirement, exact image allowlisting, container isolation/resource policy, fixed build/test jobs, and a durable hash-chained JSONL audit file.
- **Portal-to-API integration:** not implemented. The Operations view continues to show browser-side simulated state and is now labeled as a demo.
- **Automated validation:** `npm run check` passes 12 tests, static checks, and a Pages bundle build. Docker tests use fakes/a local socket fixture, not a real daemon.
- **Not yet available:** `.sbx` workspace archive import/export, Bridge carriers beyond JPEG/PNG, user-defined pipelines, live telemetry, ecosystem integration, chain anchoring, and browser WASM execution.

## Priority 0 — Make the product contract explicit (now)

1. Keep the demo-only warning visible anywhere simulated status is shown. Do not label mock values as live Docker telemetry or signed audit evidence.
2. Keep the static Pages frontend and self-hosted runtime separate; Pages must never be described as the Docker host.
3. Before adding a browser API client, define operator-only access, token entry/storage/clearing, API-origin validation, reconnect behavior, and offline/error states. Keep secrets out of HTML, localStorage, generated claims, and the public Pages artifact.

**Acceptance:** portal copy, docs, API behavior, and tests agree on which actions are real. The current checkout meets the warning/documentation part; it does not yet meet portal integration.

## Priority 1 — Validate and secure the real runtime (critical)

Run on a dedicated Linux host with a non-root operator and a rootless Docker daemon. Start with read-only verification; do not expose the service to untrusted users. Validate API authentication, socket permissions, approved image availability, container create/inspect/exec/stop/restart/remove, quota admission under concurrency, audit persistence, and recovery after API/Docker restarts.

Exercise adversarial cases from the supplied plan: reject non-allowlisted images, privileged requests, host/socket mounts, root user, added capabilities, network access, writable system paths, CPU/memory/PID abuse, timeout/output abuse, and malformed requests. Verify that build/test mounts are read-only, have no network, clean up reliably, and remain bounded after failures. Capture success/failure, resource use, latency, and audit results. Use immutable image digests for production policy; the current configuration still uses mutable tags.

**Acceptance:** documented real-host test report; no claim of production readiness until isolation, quotas, recovery, and audit persistence pass on the intended host. The current sandbox has not been live-tested.

## Priority 2 — Connect the portal to the API

Add an explicit operator-controlled API connection flow, initially read-only: health/rootless status, containers and real resource stats, policy, pipelines, and audit events. Add bearer-token handling with least exposure, explicit disconnect/clear, timeouts, and a visible offline state. Then expose create/exec/start/stop/remove and fixed build/test actions only after review of confirmation, error handling, and audit visibility. Keep the demo mode distinct and never silently fall back from the real API to fabricated data.

**Acceptance:** browser end-to-end tests against a test API; no stale/simulated metrics presented as real; tokens not persisted in public or long-lived storage; origin allowlist and TLS verified.

## Priority 3 — Workspace portability (`.sbx`)

Implement versioned export/import for workspace settings, repository references, claims, audit snapshots, terminal history, and publishing history. Specify schema versioning, archive size limits, path/ZIP-bomb defenses, secret redaction, and backwards compatibility. Validate checksums and reject malformed or oversized archives.

**Acceptance:** round-trip tests, migration tests, corruption/size-limit tests, and clear warnings before importing untrusted archives.

## Priority 4 — Expand Bridge carriers

Adopt one versioned claim schema and verifier contract before adding formats. The supplied report recommends PDF and HTML first, then ZIP, DOCX, and video. Prefer deterministic metadata/manifest carriers and detached manifests where embedding can alter artifact hashes. Explain that unsigned hashes prove integrity only. Add a common CLI/API verification path after carrier formats are stable.

**Acceptance:** each carrier has encode/extract/verify tests, artifact-hash semantics, tamper tests, size limits, and documented format-preservation behavior.

## Priority 5 — Pipelines and operations telemetry

After runtime validation, move from fixed server-defined build/test jobs to reviewed, version-controlled pipeline definitions. Do not permit arbitrary host shell commands; validate each job against image, mount, network, resource, timeout, output, and approval policy. Then stream real logs, statistics, audit events, and job state via SSE or WebSocket with reconnect and back-pressure handling.

**Acceptance:** schema validation, concurrency/recovery tests, audit of each step, resource ceilings, and real-host integration tests.

## Priority 6 — Ecosystem, then optional research features

Standardize artifact, claim, audit, and verification IDs before integrating Forge, Bridge, TeleOS, LUMEN, or COPS. Treat chain anchoring as an optional later provenance timestamp—not a substitute for signatures or operational security. Evaluate browser WASM only after the API model and threat boundaries are clear.

## Recommended next milestone

**sandboxd v2.1:** real rootless-Docker integration/security validation + a read-only portal/API connection + `.sbx` export/import + PDF/HTML Bridge design. If the target host is not available, continue with test harnesses and docs, but mark live-runtime validation as blocked rather than complete.
