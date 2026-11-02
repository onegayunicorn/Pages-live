# sandboxd Docker API

`sandbox/server.mjs` is a separately hosted, bearer-authenticated API that controls a dedicated **rootless Docker daemon** through its Unix socket. It is not the runtime for GitHub Pages. The portal's Operations UI is currently a separate browser simulation and does not call this API.

## Local development

Requirements: Node.js 20+, a running rootless Docker daemon, and the exact pre-pulled images listed in [`config/policy.json`](config/policy.json). Do not point the service at a rootful daemon or `/var/run/docker.sock`.

```sh
export DOCKER_SOCKET="/run/user/$(id -u)/docker.sock"
export SANDBOX_API_TOKEN="$(openssl rand -hex 32)"
export SANDBOX_API_HOST=127.0.0.1
export SANDBOX_API_PORT=8787
npm run dev
```

The API refuses startup if the token is missing or shorter than 32 characters. It refuses runtime operations unless the Docker daemon reports rootless mode. Health is public; all other API routes require `Authorization: Bearer $SANDBOX_API_TOKEN`.

```sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS -H "Authorization: Bearer $SANDBOX_API_TOKEN" \
  http://127.0.0.1:8787/api/v1/status
curl -fsS -H "Authorization: Bearer $SANDBOX_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"image":"alpine:latest"}' \
  http://127.0.0.1:8787/api/v1/containers
```

See [`openapi.yaml`](openapi.yaml) for the route contract. The default `npm run check` does not require Docker; tests inject a fake Engine and a local Unix-socket protocol fixture.

## Controls and limitations

- Image references must exactly match the server allowlist and must already exist on the rootless daemon. For production, pin approved images to immutable digests and manage updates deliberately; mutable tags such as `latest` can change.
- Containers are non-root, network-isolated, have no host mounts, use a read-only root, drop all capabilities, set `no-new-privileges`, and receive fixed CPU, memory, PID, execution-time, and output limits.
- The API executes requested shell text only inside an allowlisted managed container. Fixed build/test jobs run in a separate job container with a read-only repository mount, `network=none`, resource limits, timeout, output cap, and cleanup.
- The API control plane has access to the rootless Docker socket. Anyone holding its bearer token can perform every operation that token permits. Use only for a trusted single operator; it is not designed for untrusted users or multi-tenancy.
- CORS is an origin restriction for browsers, not authentication; non-browser clients still need the bearer token. Use TLS, a private API port, a strong unique token, and firewall/reverse-proxy restrictions.
- Writable-layer size is reported but there is no enforced disk quota. The hash-chained audit log is not immutable against a host administrator.
- Fake Engine tests do not replace live rootless-Docker validation. See [`../docs/PROJECT_STATUS.md`](../docs/PROJECT_STATUS.md) and [`../SECURITY.md`](../SECURITY.md).
