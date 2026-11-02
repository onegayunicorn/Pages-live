# Security notes

## Deployment model

GitHub Pages hosts only the static portal and public bridge bundle. The Operations
tab is currently a browser-side demonstration and does not connect to the Docker
API. The real API is a separate service on a dedicated host with a rootless Docker
daemon. API clients must send a bearer token; CORS restricts browser origins but
is not authentication. Anyone who obtains the token can invoke every operation
permitted by the API.

The API enforces a fixed image allowlist, refuses on-demand image pulls, creates
managed containers with no network or host mounts, and applies non-root,
read-only-rootfs, capability, PID, memory, and CPU limits. Commands run through
`docker exec` inside a managed container, never as a host shell command. The
fixed build/test jobs mount the configured checkout read-only. These are defense
in depth, not a guarantee against kernel, runtime, daemon, API, or image
vulnerabilities.

The control plane itself mounts the rootless Docker socket and can control that
user's daemon. A compromise of the API service can therefore compromise every
container and host resource available to that rootless daemon. Run it on a
separate, dedicated Linux host; never mount the Docker socket into workload
containers; keep images and host packages patched; and restrict who can reach the
API. Do not expose it to untrusted users or treat it as a multi-tenant boundary.

The API does not currently provide a complete enterprise authorization system,
per-user roles, or general-purpose rate limiting. Use a strong, unique token,
TLS, a restrictive reverse proxy/firewall, and operator-only access. Keep the
API port bound to loopback behind the proxy. Set the CORS allowlist to exact
origins; CORS alone does not prevent non-browser clients from making requests.

Docker was unavailable in the preparation environment; fake Engine tests do not
replace integration tests on the target rootless-Docker host. Validate policy,
resource limits, failure behavior, proxy headers, backups, and upgrades before
production use.

## Browser credentials

- The portal currently has no Docker API connection flow. Never put an API token
  in the public HTML, `localStorage`, or any Pages artifact.
- The portal's GitHub token flow stores a token in this browser's local storage;
  use least privilege, sign out, and remove stored credentials when done.
- The Facebook Page token is entered in the browser by the bridge UI. Do not use
  that flow on a shared or untrusted device. Prefer a short-lived server-side
  relay for real deployments.
- Never commit `.env`, API/GitHub/Facebook access tokens, or private keys. Do not
  put secrets in `claim.json`, `verify.html`, or any Pages artifact; those files
  are public.

## Audit and bridge integrity

The audit log is append-only through the API and hash-chained, but it is not
immutable against a host administrator who can rewrite the file and recompute the
chain. Back it up or forward it to a protected logging service if tamper evidence
matters.

The bridge claim embeds the source image digest and publishes the final encoded
artifact digest externally. A matching SHA-256 detects file mismatch; it is not a
digital signature, proof of identity, or protection if the publisher replaces
both the image and manifest.
