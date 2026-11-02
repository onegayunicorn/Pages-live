# Deployment

GitHub Pages hosts the static frontend only. It cannot host the Node API, provide a Docker socket, or run containers. The Docker API must run separately on a Linux host with a dedicated **rootless Docker** daemon. The browser Operations dashboard remains a demo and is not connected to the API in this checkout.

## Static GitHub Pages site

1. Push `main` to GitHub.
2. In **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**.
3. `.github/workflows/pages.yml` runs the complete `npm run check`, builds the static allowlist, and deploys `dist/` on pushes to `main` (or via **Run workflow**).
4. The API image workflow is separate; it publishes an image but does not deploy or start the API.
5. For a custom domain, configure it in Pages and at DNS. Do not treat the example domain in `claim.json` as a configured domain.

The Pages build includes only `index.html`, `claim.json`, `verify.html`, `portal/` assets, and a generated bridge image if present. It excludes API source, tests, `.env`, and local configuration.

## Rootless Docker API host

1. Provision a dedicated Linux host and install rootless Docker for a non-root operator account. Confirm the daemon and socket path (commonly `/run/user/<uid>/docker.sock`). Do not use `/var/run/docker.sock` or a rootful daemon.
2. Clone this repository on that host and install Docker Compose v2. The API image contains Node and application source; fixed build/test jobs also require the local repository checkout to be mounted read-only.
3. Prepare configuration:

   ```sh
   cp .env.example .env
   # Edit DOCKER_SOCKET_PATH, SANDBOX_UID, SANDBOX_GID,
   # SANDBOX_API_TOKEN, SANDBOX_ALLOWED_ORIGINS,
   # SANDBOX_WORKSPACE_HOST_PATH
   set -a; . ./.env; set +a
   mkdir -p sandbox/data
   chown "$SANDBOX_UID:$SANDBOX_GID" sandbox/data
   ```

   Generate a unique token with `openssl rand -hex 32`. Configure an exact browser origin such as `https://onegayunicorn.github.io` (origin only; no `/Pages-live` path). Set the workspace variable to the host's absolute repository checkout. Protect `.env` and ensure `sandbox/data` is writable by the API UID/GID.
4. Pull the fixed job image and only the approved workload images through the rootless daemon:

   ```sh
   docker --host "unix://$DOCKER_SOCKET_PATH" pull node:20-alpine
   docker --host "unix://$DOCKER_SOCKET_PATH" pull alpine:latest
   ```

   The policy currently uses mutable tags; pin/review image digests before production use.
5. Start the API and inspect its logs:

   ```sh
   docker compose up -d --build
   docker compose logs -f api
   ```

   Compose binds the API to `127.0.0.1:8787`, uses a read-only service filesystem, and mounts the configured rootless socket into the trusted control plane. Place Caddy or an equivalent TLS reverse proxy/firewall in front; never expose port `8787` directly to the public internet.
6. Verify the service from the host. Health is public; all other routes require the token:

   ```sh
   curl -fsS https://sandbox-api.example.com/api/v1/health
   curl -fsS -H "Authorization: Bearer $SANDBOX_API_TOKEN" \
     https://sandbox-api.example.com/api/v1/status
   ```

   The existing portal does not provide a connection UI, so these checks do not populate its Operations dashboard. Use only trusted API clients until the portal/API integration milestone is implemented.

## GHCR API image

On qualifying pushes to `main`, `.github/workflows/api-image.yml` builds and pushes:

```text
ghcr.io/onegayunicorn/pages-live-sandboxd-api:latest
ghcr.io/onegayunicorn/pages-live-sandboxd-api:<commit-sha>
```

The first package may be private by default. Set package visibility or authenticate the host before pulling. Keep the matching source checkout for read-only pipeline jobs; pin a commit tag rather than `latest` for controlled upgrades. Publishing the image does not deploy it or expose the service.

## Development and validation

Without Docker, `npm run check` runs the tests, static checks, and Pages build using fake/local Engine fixtures. It does not establish live Docker behavior. For local API development, set `DOCKER_SOCKET`, `SANDBOX_API_TOKEN`, `SANDBOX_API_HOST`, and `SANDBOX_API_PORT`, then run `npm run dev` on a host with rootless Docker. Never put the API token in the GitHub Pages source or commit `.env`.
