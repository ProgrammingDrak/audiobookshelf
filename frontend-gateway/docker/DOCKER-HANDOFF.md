# Docker handoff for Jesse's existing ABS

Hosting permission is confirmed. This runs **one separate frontend/gateway container** connecting to the existing ABS backend. It does not create or mount a database/library and does not modify the original ABS service. No real installation, account test, network change, credential creation, or release publication has happened yet.

## Required non-secret host settings

Confirm Docker Engine/Compose v2 with `up --wait`, the daemon's Linux architecture (amd64/x86_64 or arm64/aarch64), Python 3.9+, and the host scheduler/owner. Other architectures and Windows containers are unsupported. Docker Desktop/OrbStack can run the Linux images, but a NAS/Windows/macOS scheduler needs its own host-owner integration; the supplied timer is Linux user-systemd only.

Confirm the existing ABS version/auth/base path, unused loopback host port, private HTTPS origin, and an approved backend route **from the container**. This client is 2.37.1; readiness requires a matching confirmed backend version. If Jesse's version differs, select/test matching source first. Do not upgrade Jesse's backend as part of this install. Local username/password login is the tested path; OpenID callbacks and Chromecast remain separate compatibility checks.

Container 127.0.0.1 points to the new container. If ABS is already reachable on an approved host/LAN address, use that address in the host-local env file. If a shared external Docker network or a host-gateway mapping is required, have the host owner explicitly approve and configure only the needed route after inspecting the existing setup. No network/grant change is assumed in the template.

## Image and host layout

The release has `abs-frontend-amd64.docker.tar.gz`, `abs-frontend-arm64.docker.tar.gz`, and `docker-release.json`. The manifest names each platform's exact Docker image ID and archive SHA256. The matching source/runtime bundle includes the full GPL license and complete corresponding source; each image embeds those files under /app. The base is pinned to an official Node 24 multi-architecture manifest. No tokens, private host settings, browser screenshots, or library data are included.

Extract the handoff into a host-owner directory, for example `~/.local/share/abs-frontend-docker/`. Place `compose.yaml` and the reviewed `update.py` there. Copy `runtime.env.example` to `runtime.env`, set mode 0600, and fill the confirmed values. The updater substitutes the verified image ID, so the template's image placeholder is only for manual inspection; all other settings must be real before install.

The Compose app uses UID 1000, read-only root filesystem, no volumes, no Docker socket, dropped ALL capabilities, no-new-privileges, 128 processes, 256 MB memory, one CPU, bounded logs, and host loopback publication. The host updater's already-approved Docker access remains with the host owner and is never passed into the app.

## Initial installation after verified access

1. Verify a permitted host administration route and current Docker context. Do not create persistent credentials or grant new privileges implicitly. Check that the dedicated `abs-frontend-drake` Compose project is unused; the updater refuses to adopt existing containers without its own deployment state.
2. Review the manifest and source revision. Download/load only the architecture matching the actual Docker daemon. The local handoff includes both architectures; published release assets become available only after release-distribution approval. Do not use PR artifacts for unattended installation.
3. From the reviewed host directory, install with the explicit local release manifest and directory containing the archives:

```sh
python3 update.py --home "$PWD" --install /path/to/docker-release.json --archive-directory /path/to/release-assets
```

This checks the archive SHA256, loads it, verifies platform/non-root identity/revision, validates the one-service Compose configuration, starts only the frontend with `--no-deps --pull never --wait`, and checks exact-image readiness. Initial failure stops the failed frontend; an update failure restores the retained previous image. It neither prunes Docker state nor touches the existing ABS project.

4. Inspect `docker compose --project-name abs-frontend-drake --env-file runtime.env -f compose.yaml ps`. With the confirmed origin Host header, loopback `/readyz` must report the exact revision and compatible backend. Verify live login, browsing the same library, playback, range seeking, token expiry/refresh, sockets, and progress visible in the existing client using a separately authorized normal account.
5. Through the approved private HTTPS ingress, map the chosen origin to host loopback port 13379 (or the confirmed unused port), preserving `/audiobookshelf` and WebSockets. Check existing ingress/Serve configuration before adding a distinct route/listener. Never replace Jesse's existing route, use public Funnel, or create new tailnet grants without explicit approval.

## Automatic updates are part of deployment

After reviewed master changes pass gateway/unit/real-container/Compose rollback checks on native GitHub amd64 and arm64 runners, the workflow is ready to publish immutable `frontend-<full SHA>` releases. **It is currently disabled.** The repository owner must explicitly approve publishing these public fork-derived Docker archives/source and set `FRONTEND_RELEASES_ENABLED=true`. No container registry, long-lived GitHub token, SSH key, remote runner, or tailnet credential is required. No new public release has been created in preparation.

After initial health/live compatibility pass, run one `python3 update.py --home "$PWD" --check` and approve enabling its five-minute host schedule. On confirmed Linux user-systemd, copy the supplied update service/timer into `~/.config/systemd/user/`, place the files at the matching path in ExecStart, verify `/usr/bin/python3` is 3.9+, then as that already-authorized host owner:

```sh
systemctl --user daemon-reload
systemctl --user start abs-frontend-docker-update.service
systemctl --user enable --now abs-frontend-docker-update.timer
```

Other hosts should schedule exactly the same `update.py --home <host-owned-directory> --check` command every five minutes through their existing approved scheduler; choose that adapter only after the actual host is known. Creating a service account, adding Docker-group membership, enabling lingering, or changing network policy are separate owner-approved actions, not implied setup commands.

The updater selects the daemon architecture, downloads only the fixed fork/release assets, verifies checksum and exact image ID/revision, and activates only this Compose service. It records `current.json` and retains `previous.json`; Docker images are not pruned. The app's healthcheck reads bundled source revision and requires the matching backend/client version. A broken candidate is rolled back and marked in `blocked/` so subsequent checks do not repeatedly disrupt service. A short frontend interruption/reconnecting sockets occurs during replacement. Existing server data needs no rollback because the frontend owns none.

Checksums detect corruption; they do not independently authenticate a compromised trusted repository. Protect/review master. This automates deployment of commits pushed to the fork, while upstream updates still require reviewed merges and backend compatibility checks.

## Pause, rollback, and recovery

```sh
python3 update.py --home "$PWD" --pause
python3 update.py --home "$PWD" --rollback
```

Rollback validates/reuses the retained previous exact image and verifies health; updates remain paused. Inspect the release channel/candidate before resuming with `--resume`. Never prune the retained image before verifying a replacement. A failed candidate's block file is removed only after inspection and an explicit retry decision. Inspect a stale `.docker-update-lock` after a hard kill before removing it. If rollback health also fails, the updater reports the failure and preserves the deployment state for the host owner to diagnose.

No host details, credentials, or existing ABS version/architecture are guessed by this handoff. Real-server compatibility, host ingress, scheduler installation, and the published-release-to-host path remain unverified until performed through an approved host connection.
