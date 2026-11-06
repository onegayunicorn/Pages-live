# Pages-live · sandboxd portal

A GitHub Pages portal for the **sandboxd — daemon + bridge** project, paired with a separately hosted, authenticated Docker API. The repository contains both pieces, but they are **not yet wired together**: the Operations tab in `index.html` is a browser-only demo and does not control Docker. Its containers, quotas, network state, pipelines, and audit events are simulated. The API is a distinct service that talks to a dedicated **rootless Docker daemon** when explicitly configured.

GitHub Pages serves static files only. It cannot run the Node API, Docker, or persistent containers.

## Project layout

```text
.
├── index.html                     # self-contained portal/demo UI
├── cops/                           # compiled COPS simulator served at /cops/
├── bridge.jpg                     # JPEG with embedded SBX1 provenance claim
├── assets/bridge-source.jpg       # source artwork for the generated bridge image
├── claim.json                     # source + final artifact digests
├── verify.html                    # verifier for the public bridge bundle
├── portal/                        # favicon + web app manifest
├── sandbox/
│   ├── server.mjs                 # authenticated Docker-backed API + static server
│   ├── docker-engine.mjs          # Docker Engine client over a Unix socket
│   ├── config/policy.json         # image allowlist, limits, and fixed job commands
│   ├── openapi.yaml               # API contract
│   └── schemas/claim.schema.json  # bridge claim schema
├── Dockerfile, compose.yaml       # self-hosted API scaffolding
├── deploy/Caddyfile.example       # TLS reverse-proxy example
├── docs/                          # architecture, deployment, status, roadmap
├── scripts/                       # bridge generator and Pages build/check tools
├── tests/                         # fake-engine, Docker protocol, portal, bridge tests
└── .github/workflows/             # Pages deploy + API image workflows
```

## Requirements and local checks

Node.js 20 or newer; no npm runtime dependencies are required.

```sh
npm run check          # tests, static checks, and static Pages build
npm run bridge:build   # regenerate bridge.jpg and claim.json from source artwork
```

The checks use a fake Docker Engine and a local Unix-socket protocol fixture. They do **not** establish that a real Docker daemon accepts the requests or enforces isolation/resource limits. See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## Run the separate Docker API

Use only a dedicated Linux host running **rootless Docker**. Do not use `/var/run/docker.sock` or expose the API directly to the public internet. The service requires a random bearer token and refuses to operate with a rootful daemon.

For local development on a host with a rootless Docker daemon:

```sh
export DOCKER_SOCKET="/run/user/$(id -u)/docker.sock"
export SANDBOX_API_TOKEN="$(openssl rand -hex 32)"
export SANDBOX_API_HOST=127.0.0.1
export SANDBOX_API_PORT=8787
npm run dev
```

The portal can be opened at `http://127.0.0.1:8787/`; its Operations UI remains demo-only. The API itself can be exercised with authenticated requests, for example:

```sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS -H "Authorization: Bearer $SANDBOX_API_TOKEN" \
  http://127.0.0.1:8787/api/v1/status
```

See [`sandbox/README.md`](sandbox/README.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), and [`SECURITY.md`](SECURITY.md) before deploying. The control plane can control the containers available to its rootless Docker daemon; it is intended for a trusted single operator, not untrusted users or multi-tenant workloads.

## GitHub Pages and API image

The Pages workflow validates and builds an explicit static allowlist, then deploys `dist/` on pushes to `main`. Enable **Settings → Pages → Build and deployment → Source → GitHub Actions**. The API image workflow can publish a container image to GHCR, but does not deploy or start the API service.

The portal's Hosting tab can publish its self-contained page to another Pages repository. The checked-in verifier and bridge image form a hash-checked bundle; a matching SHA-256 confirms byte integrity, **not authorship or identity**. The image/claim is unsigned. The offline Bridge builder sets `chain` to `unavailable`; the browser Bridge tool's optional audit reference is user-supplied and is not verified against the API.

## COPS simulator and installers

The compiled COPS Control Lab simulator is served independently at [`/cops/`](https://onegayunicorn.github.io/Pages-live/cops/); the existing sandboxd portal remains at `/`. Only the compiled browser output is checked into this repository. The COPS source repository remains private. Four prebuilt desktop installers are published as assets in the [`cops-v3.0.0` release](https://github.com/onegayunicorn/Pages-live/releases/tag/cops-v3.0.0); the Pages workflow downloads them into `/cops/downloads/` and verifies them against `cops/SHA256SUMS` before deployment. The large installer binaries are deliberately not stored in Git history.

The current installers are from a validated COPS build. The private source repository and its build logs are not mirrored here. Publishing future builds requires updating the public release assets and matching checksum manifest; this repository's Pages workflow then deploys the verified files along with the microsite.

## Current gaps

- The browser Operations UI is still a local simulation; portal-to-API connection and live dashboard rendering are not implemented.
- A real rootless-Docker integration, isolation, resource-limit, failure-recovery, and end-to-end deployment test remains outstanding.
- Workspace `.sbx` export/import and non-image Bridge carriers (PDF/HTML/ZIP/DOCX/video) are roadmap work, not current features.
- The API reports Docker writable-layer size but does not enforce a disk quota. Its hash-chained audit log is tamper-evident, not immutable against the host administrator.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for prioritized next steps and [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for the tested scope and open validation checklist.
