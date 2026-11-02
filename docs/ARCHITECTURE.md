# Architecture

```text
Browser
  └─ GitHub Pages: static index.html, claim.json, verify.html, bridge.jpg, portal assets
       └─ Operations pane is currently a browser-side demo; it does not call the API

Trusted operator / API client
  └─ HTTPS reverse proxy (recommended; not included as a running service)
       └─ sandbox/server.mjs: bearer-authenticated Docker API
            └─ Unix socket → dedicated rootless Docker daemon
                 ├─ policy-limited managed containers
                 └─ fixed build/test jobs with a read-only workspace mount
```

## Portal

The root `index.html` is intentionally self-contained because the Hosting tab can publish it as a single-page site. Its Operations widgets currently simulate containers, quotas, network state, pipelines, lifecycle events, and a demo audit chain in the browser. The displayed daemon state is not live telemetry. The portal does **not** currently connect to `sandbox/server.mjs`, and its own GitHub/Bridge features remain separate from the Docker API.

GitHub Pages only hosts the static portal and public bridge bundle. It does not host the API or Docker runtime.

## API and runtime

`sandbox/server.mjs` exposes authenticated `/api/v1/*` routes and uses `sandbox/docker-engine.mjs` to speak the Docker Engine HTTP API over a Unix socket. The API requires a random bearer token, checks the exact browser-origin allowlist when an `Origin` header is supplied, refuses a rootful daemon, and fails closed when Docker is unavailable. Health is deliberately public and reports connection/rootless state; other API routes require the token.

Managed workload containers use only exact allowlisted, pre-pulled images; no on-demand image pulls are permitted. Containers are non-root, have no network or host mounts, use a read-only root filesystem, drop Linux capabilities, enable `no-new-privileges`, and receive fixed memory/CPU/PID limits. User commands are executed **inside** a managed container with time and output caps, not in a host shell. Build/test are fixed jobs in isolated containers and mount the configured repository checkout read-only.

The API service itself mounts the rootless Docker socket and can control that user's daemon. Run it on a dedicated host, behind TLS and a restrictive firewall/reverse proxy. This design is not a multi-tenant security boundary. The configured disk quota is not enforced; writable-layer size is observational.

## Audit

The API appends JSONL events and links each event to the previous one with SHA-256. It verifies the chain at startup and exposes an audit verification route. This is tamper-evident against accidental changes, not a signature or protection from an administrator able to rewrite the log and recompute the chain. Back up or forward important logs to a separately protected system.

## Bridge

`assets/bridge-source.jpg` is the source artwork. `bridge.jpg` carries an SBX1 JSON claim in a JPEG APP15 segment, including the source-image hash. The public `claim.json` records the SHA-256 of the final encoded JPEG; that digest is external because embedding the image's own final hash would be self-referential. `verify.html` checks delivered bytes against this external digest. The offline builder sets `chain` to `unavailable`; it does not fabricate an API audit root. The browser tool's optional audit-reference field is user-supplied and unverified. A digest match demonstrates byte equality, not authorship; the bundle is not signed.
