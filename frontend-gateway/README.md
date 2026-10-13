# Separate Audiobookshelf frontend

This package serves the fork's existing Vue/Nuxt interface and forwards login/API/audio/HLS/WebSocket traffic to **one existing ABS backend**. It owns no database, scanner, media directory, or administrator token. The existing server owns accounts, sessions, and listening progress.

Jesse's permission to host is confirmed, with **Docker required**. The Docker run and automatic-update path is in [docker/DOCKER-HANDOFF.md](docker/DOCKER-HANDOFF.md). Host administration access, architecture, ABS version/auth method, container-to-backend route, and private HTTPS ingress still need verification. No real host was accessed, credential created, security grant changed, release published, or server service installed.

## Local synthetic demo

Node 24.13.1 was used for the stock frontend build. From the repository root:

```sh
CYPRESS_INSTALL_BINARY=0 npm ci --prefix client --ignore-scripts
npm run generate --prefix client
node --test frontend-gateway/test/*.test.mjs
python3 frontend-gateway/test/docker-updater-test.py
node frontend-gateway/demo.mjs
```

Open http://127.0.0.1:13379/audiobookshelf/login, username demo, password demo. The synthetic library contains a generated 60-second tone and memory-only progress. Neither the backend on loopback port 13380 nor this demo contacts Jesse. Stop with Ctrl-C; alternate ports use DEMO_PORT and DEMO_BACKEND_PORT.

Optional headless UI verification: node frontend-gateway/browser-smoke.mjs. Generated browser screenshots remain local and are excluded from distributed packages.

## Runtime contract

Private HTTPS ingress -> host loopback :13379 -> Docker bridge port :8080 -> fixed existing ABS backend.

The built client retains /audiobookshelf. ABS_UPSTREAM accepts the approved HTTP(S) backend URL at / or /audiobookshelf, without credentials. Container loopback is the container itself, so do not copy a host-loopback backend URL without verifying the network route.

Range requests, streaming bodies, query strings, Socket.IO upgrades, auth errors, login/refresh/logout, and progress writes pass through. The gateway adapts backend-origin redirects and removes cookie Domain attributes while retaining HttpOnly/Secure/SameSite. API failures never become SPA HTML. /init is blocked. Stock backend account permissions still apply, including any administrative capabilities of that account.

PUBLIC_ORIGIN is the exact browser origin, including its HTTPS port. Foreign Hosts/Origins, cross-site browser requests, absolute proxy targets, ambiguous paths, and unrelated routes are rejected. Client forwarding headers are replaced from configured origin/local peer information. Outside Docker the gateway accepts only loopback binding. Inside a detected Docker container, explicit CONTAINER_MODE=1 permits the bridge listener; Compose publishes only host loopback. Do not publish it publicly with Funnel or unrestricted ingress.

GET /healthz returns gateway liveness and exact source revision. GET /readyz additionally requires generated files, an initialized/auth-enabled backend, the configured confirmed backend version, and **that same bundled client version**. This conservative gate prevents automatically rolling a newer ABS client onto an older backend. An actual normal-account login/playback/progress check is still required; equal version strings alone are insufficient proof. The current client baseline is 2.37.1. If Jesse's version differs, build/test a matching frontend baseline before installation; do not upgrade his existing backend implicitly.

OpenID callbacks, Chromecast, public-share URL generation, actual private HTTPS ingress, and live Jesse integration require separate verification. Local username/password login is the tested baseline.

## Versioned builds and automatic Docker updates

The workflow in .github/workflows/frontend-gateway.yml uses GitHub-hosted standard Linux amd64/arm64 runners, pinned actions, read-only build permissions, the committed client lockfile, mock tests, actual Docker/Compose smoke and rollback tests, and complete GPL source.

A reviewed master commit produces a source/runtime bundle plus one Docker image archive per architecture, exact image IDs, and SHA256 checksums. Publishing is disabled until the repository owner explicitly approves release distribution and sets FRONTEND_RELEASES_ENABLED=true. PR artifacts do not deploy or publish. Master release tags are frontend-<full SHA>; assets are not replaced on rerun. No registry credentials, SSH secret, tailnet access, or self-hosted runner is used.

The **host-owned** Python 3.9+ standard-library updater is a required part of the deployment handoff. Once initial installation and update activation are approved, its five-minute schedule downloads the fixed release channel, chooses the actual Docker daemon architecture, verifies the archive and immutable image identity, replaces only the dedicated frontend Compose service, and requires exact-image readiness. Failed updates restore the retained previous image and block that candidate from repeated automatic attempts. The app has no Docker socket. The host updater uses only the host owner's already-authorized Docker access and never prunes images or operates on the existing ABS project.

Checksums detect transport corruption; they are not independent signatures against compromise of the trusted repository/release channel. Protect/review master. Upstream ABS changes still require reviewed merges and version compatibility checks; this automation delivers changes pushed to this fork, not unattended upstream merges.

To produce the source/runtime bundle after committing reviewed source:

```sh
node frontend-gateway/bundle.mjs
cd frontend-gateway/out
shasum -a 256 -c SHA256SUMS
```

The bundle includes the generated client, dependency-free gateway, Docker/Compose/update files, full GPL license, source URL/revision, and source.tar.gz with the complete corresponding Git source. The Docker image also embeds the GPL license and corresponding source.

The earlier deployment/ Node/systemd gateway profile is retained as a legacy standalone profile for existing tests; it is **not the selected Jesse installation path**. Use docker/ exclusively for the agreed container deployment.

## Validation boundaries

Gateway tests execute the real stock Axios/Vuex refresh code, socket reauthentication, Vuex progress mutation, AudioTrack URLs, audio range/HEAD/416 behavior, HLS, cookies, redirects, request guards, readiness and rollback. Docker checks exercise actual non-root/read-only/capability/socket protections, compiled UI serving, login/refresh, stream/seek, socket/progress, Compose bootstrap/healthy upgrade/no-op, and failed-image rollback against synthetic data.

Upstream Vue/Nuxt dependencies remain a faithful baseline; legacy/EOL packages and existing audit findings were not silently upgraded. The runtime gateway adds no npm dependency, and its container removes npm/Yarn/Corepack. Runtime images use a verified pinned official Node 24 multi-architecture base. Actual image scan results and local/CI run evidence are recorded separately; do not infer live compatibility from mock tests.

Sources: [ABS source baseline](https://github.com/ProgrammingDrak/audiobookshelf/tree/743d9152208507a1dbf7c95c94290071338f44bd), [Docker Compose services](https://docs.docker.com/reference/compose-file/services/), [Docker image loading](https://docs.docker.com/reference/cli/docker/image/load/), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), [GitHub standard runner platforms](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
