# Project status and handoff

**Updated:** 2 November 2026
**Project:** Pages-live / sandboxd portal

## Completed

- **Portal scope:** the self-contained Operations UI is still a browser-side demo. It is visibly marked as simulated and is not connected to the Docker API; its displayed container, quota, lifecycle, pipeline, and audit values are not runtime evidence.
- **Separate Docker API:** bearer-token authentication, exact image allowlisting, rootless-daemon requirement, CORS allowlist, real container create/exec/stop/start/remove routes, durable hash-chained JSONL audit log, and policy-checked restart. Workloads are non-root, network-isolated, read-only-rootfs, capability-dropped, and limited by CPU, memory, and PIDs. Fixed pipelines are single-concurrency and use a read-only checkout mount.
- **Quota and pipeline admission:** container create/restart quota checks are serialized; fixed pipelines are limited to one at a time and active jobs are detected from Docker labels after API restart.
- **Fixed build/test jobs:** run the repository's predefined scripts in a `node:20-alpine` job with a read-only checkout mount, no workload network, resource limits, output cap, timeout, and cleanup. The API does not execute arbitrary shell commands on its host.
- **GitHub and bridge functionality retained:** repository browsing, GitHub Pages publishing, workflow dispatch, the bridge image encoder/verifier, and the claim bundle remain in the portal. The Operations `sync` card only animates placeholder steps; no source synchronization or API endpoint runs.
- **Deployment and project documentation:** Pages and GHCR workflows, Compose/Dockerfile, reverse-proxy example, API contract, security notes, architecture, and deployment instructions are in the repository.

## What has been tested

The latest full local check completed successfully:

- `npm run check` — **12 tests passed, 0 failed**; static portal checks passed; Pages bundle built to `dist/`.
- Tests cover bridge claim/artifact integrity, Docker Engine Unix-socket protocol and rootless detection, container security configuration, exec stream handling, portal syntax/assets and demo disclosure, API authentication/CORS/image allowlisting, container operations, pipeline concurrency, audit verification, and static-route restrictions.
- `node --check` passed for the API, Docker Engine client, and build scripts.
- The portal's inline JavaScript parsed successfully with `vm.Script`.
- `git diff --check` passed.
- `compose.yaml` and both GitHub Actions workflow files parsed as YAML.
- The generated `bridge.jpg` bytes match `claim.json`'s artifact SHA-256: `93b8c9592e4f82ff3a248504602e1635eb2d5c357a52e8c2b458921c718ba303`.

**Test limitation:** API and Docker behavior tests use a fake Engine. They validate the API contract and policy logic, but they do not prove that a real Docker daemon will accept every Engine request or enforce the configured limits on a target host.

## Remaining work / not yet verified

1. **Run a real rootless-Docker integration test on the intended Linux host.** Confirm the daemon's rootless status and socket permissions; pull the allowlisted images; create, inspect, exec in, stop, restart, and remove a managed container; verify isolation and resource limits; and inspect live resource statistics and audit persistence.
2. **Exercise build and test pipelines on that host.** Verify the read-only workspace bind, `network=none`, actual build/test output, timeout/output handling, cleanup after success/failure, and behavior if the API restarts while a job is running.
3. **Deploy and secure the API.** Configure `.env`, the API UID/GID, Docker socket, checkout path, and writable `sandbox/data`; start Compose on a dedicated host; put TLS/reverse proxy and firewall controls in front; and set the exact browser origin in `SANDBOX_ALLOWED_ORIGINS`. Keep the API port private and restrict bearer-token access.
4. **Validate GitHub-hosted flows with the owner's account/settings.** Confirm Pages is configured for GitHub Actions, run the Pages deployment and GHCR image workflow, set package visibility or pull credentials as required, and test publishing/dispatch from the portal with an appropriately scoped GitHub token.
5. **Implement and then browser-test portal/API integration.** Current tests validate portal markup/scripts/assets; they do not exercise a connected or visually rendered dashboard or GitHub integrations.

## Known boundaries

- GitHub Pages serves only static files; it does not host the API, Docker daemon, or persistent containers.
- Writable-layer `SizeRw` is observational; there is **no enforced disk quota**.
- The audit chain is tamper-evident, not a signed log immune to a host administrator. Rootless Docker is defense in depth, not a multi-tenant security boundary. See [`../SECURITY.md`](../SECURITY.md).
- Docker CLI/socket access was unavailable in the preparation workspace, so the live integration items above remain open.

## Useful commands and references

```sh
npm run check          # tests, static checks, and Pages build
npm run bridge:build   # regenerate bridge.jpg and claim.json after changing source artwork
```

- API setup: [`DEPLOYMENT.md`](DEPLOYMENT.md) and [`../sandbox/README.md`](../sandbox/README.md)
- Prioritized roadmap: [`ROADMAP.md`](ROADMAP.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Security: [`../SECURITY.md`](../SECURITY.md)
