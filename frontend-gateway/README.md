# Separate Audiobookshelf frontend

This package serves the fork's existing Vue/Nuxt interface and forwards its backend traffic to **one existing Audiobookshelf server**. It has no database, media directories, scanner, admin token, account provisioning, or copy of a library. A user logs in with the existing server's account; that server owns sessions and progress. Browser storage belongs to the separate origin, while listening progress belongs to the same backend account.

Status: locally built and tested with synthetic data. **No live backend connection, host installation, Tailscale configuration, credentials, release publishing, or automatic host updates have been performed.**

## Local demonstration

Node 24.13.1 was used. From the repository root:

```sh
CYPRESS_INSTALL_BINARY=0 npm ci --prefix client --ignore-scripts
npm run generate --prefix client
node --test frontend-gateway/test/*.test.mjs
node frontend-gateway/demo.mjs
```

Open `http://127.0.0.1:13379/audiobookshelf/login`, username `demo`, password `demo`. The library is labeled LOCAL SYNTHETIC DEMO and contains a generated 60-second tone. Play, seek, and reopen it; mock progress is held only in memory and resets on restart. Backend port 13380 is also loopback-only. These are throwaway demonstration credentials, not a real account. Stop with Ctrl-C. Alternate demo ports can be set with `DEMO_PORT` and `DEMO_BACKEND_PORT`.

Optional visual check on this Mac: `node frontend-gateway/browser-smoke.mjs`. It uses a separate temporary headless Chrome profile, signs in, captures the bookshelf/player, and verifies actual audio decoding/playback/seek. Screenshots and browser evidence go to ignored `frontend-gateway/out/screenshots/`.

## Runtime contract

```text
Private HTTPS origin -> loopback frontend gateway :13379
                        ├── /audiobookshelf/* UI/assets from this fork
                        └── API/auth/public audio/HLS/feed/socket.io -> fixed existing ABS
```

The built client retains its upstream `/audiobookshelf` base path. Set `ABS_UPSTREAM` to the approved backend origin with either `/` or `/audiobookshelf`; the gateway maps paths for both. Direct audio ranges, streaming responses, HLS relative segment URLs, headers, request bodies, query strings, and WebSocket bytes pass through. No API JSON or media is rewritten/cached. Only host-only cookie domains and backend-origin redirects are adapted. GET `/login` serves the fork's UI; POST `/login` uses the backend. `/init` is blocked to prevent initializing a backend through this package.

`PUBLIC_ORIGIN` is the exact browser origin, including any nonstandard port. The gateway accepts that Host and same-origin browser requests; it rejects foreign Origins, cross-site browser requests, absolute proxy targets, ambiguous paths, and unrelated routes. It accepts no client-selectable upstream. Forwarding headers are replaced with configured origin and local peer information; client-supplied forwarding headers cannot claim HTTPS. The gateway binds only to loopback, so an approved private HTTPS reverse proxy/Tailscale Serve is required for remote use. **Do not expose it using Funnel or a public unrestricted reverse proxy.** Backend permissions still apply to all proxied API operations, including the stock administrative UI; use an ordinary ABS account for this frontend.

Host-local configuration (see `deployment/runtime.env.example`):

| Variable | Meaning |
| --- | --- |
| `ABS_UPSTREAM` | Fixed approved ABS HTTP(S) URL; no embedded credentials |
| `PUBLIC_ORIGIN` | Exact private HTTPS browser origin |
| `HOST`, `PORT` | Loopback bind (default `127.0.0.1:13379`) |
| `EXPECTED_BACKEND_VERSION` | Confirmed compatible backend version; never guess this |
| `CLIENT_DIST` | Optional static directory; normally inferred from bundle layout |
| `ABS_FRONTEND_HOME` | Host release directory used by the optional Linux adapter |

`GET /healthz` checks the gateway process and returns its exact source revision. `GET /readyz` additionally requires generated client files, an initialized backend with auth enabled, and the confirmed expected backend version. Without that version it answers 503. Health requests must use the configured `PUBLIC_ORIGIN` Host, even when targeting loopback. The exact release SHA is read from bundled `release.json`.

## Build and update pipeline

The added `.github/workflows/frontend-gateway.yml` uses GitHub-hosted runners, read-only checkout/build permissions, pinned action revisions, the committed client lockfile, mock integration tests, and the existing static generator. It never joins a tailnet or logs in to a host. PRs and master pushes produce a reviewable artifact.

After the repository owner explicitly approves release publication and enables Actions, setting repository variable `FRONTEND_RELEASES_ENABLED=true` permits **successful master pushes** (or a manual master workflow run) to publish `frontend-<full commit SHA>` releases. Only that small release job has `contents: write` via GitHub's ephemeral `GITHUB_TOKEN`. No SSH secret, long-lived deploy credential, or self-hosted runner is needed. Release assets are never replaced on reruns.

Each bundle includes the generated client, dependency-free Node gateway, full GPL license, source URL/revision metadata, and `source.tar.gz` containing the complete corresponding Git source. `SHA256SUMS` validates the downloaded tarball. This checksum detects corruption; it is **not an independent signature against compromise of the trusted repository/release channel**. Protect the master branch and review code before merging. The host trusts code released from that repository.

Build locally after committing reviewed source:

```sh
node frontend-gateway/bundle.mjs
cd frontend-gateway/out
shasum -a 256 -c SHA256SUMS
```

This is automatic delivery of **reviewed commits pushed to this fork's master branch**. It does not automatically merge upstream ABS changes. Upstream updates need a reviewed merge and backend/client compatibility check, especially while the upstream frontend is transitioning to React.

## Host pull adapter (prepared, not installed)

`deployment/update.mjs` and the three user-systemd unit templates are an optional **Linux with systemd-user and Node 24** profile. They do not claim compatibility with an unknown host. If the chosen host uses Docker, macOS, Windows, NAS service management, or another init system, adapt the supervisor after identifying it; no Docker daemon was available on this Mac and no container was built.

The updater lives outside the downloaded release, is reviewed/installed by the host owner, and only restarts the dedicated `abs-frontend.service`. It polls the fixed public GitHub release channel every five minutes, downloads the known asset URLs, checks SHA256, rejects traversal/symlinks/special files, stages a new SHA directory, checks metadata, atomically changes `current`, restarts that user service, and requires `/readyz` to report **the new SHA**. A failed restart or health check restores the previous symlink, restarts the old service, and reports whether rollback health passed. Release files for earlier versions are retained. No backend service, library, or database participates in rollout/rollback.

The first known-good release is installed manually; automatic pulling requires a valid existing `current -> releases/<SHA>` link. A failed candidate is retained for inspection and is not retried automatically over an existing directory. Pause the timer before diagnosing a failure or manually rolling back; remove only that rejected frontend release after inspection if retrying it. A stale `.update-lock` after a hard kill must be inspected/removed by the host owner.

## Exact installation sequence after approval

1. Confirm hosting consent, OS/supervisor, Node 24 path, the existing ABS version/auth method/base path, the proposed unused loopback port and private browser origin, and whether backend access is local or requires an approved network route. Do not modify existing listeners, grants, or backend settings during discovery.
2. With separate account/network permission, verify a normal ABS account can log in through the separate origin, browse the same library, stream, seek, refresh after token expiry, and synchronize progress with the existing client. A version string alone is not proof of compatibility. If the existing backend differs from this client's `2.37.1`, choose/test a matching source baseline before deployment. OpenID provider callbacks and Chromecast require additional origin/network setup and remain untested; ordinary local username/password login is the baseline.
3. Download the exact reviewed release plus checksum, verify it, extract into the host-owned `releases/<SHA>/` directory, and inspect `release.json`. Never install from a PR artifact automatically. No credentials are needed to download this public fork's release.
4. Create a host-local mode-0600 runtime env file using the confirmed values. For the systemd-user profile use `~/.local/share/abs-frontend/` as the release root and `~/.config/abs-frontend/runtime.env`. Fill the literal absolute `ABS_FRONTEND_HOME`; systemd env files do not expand shell variables. Verify `/usr/bin/node` is Node 24 or edit both unit templates to its actual path.
5. Establish `current -> releases/<SHA>`, copy the reviewed updater to the release root, and put the unit templates in `~/.config/systemd/user/`. As that user, run `systemctl --user daemon-reload` and `systemctl --user start abs-frontend.service`. Confirm readiness and the exact SHA. Any enable/linger/service-account creation is a separate host-owner action; templates request no sudo or Docker group membership.
6. Only with approval, configure a distinct private HTTPS ingress to `http://127.0.0.1:13379`, preserving the `/audiobookshelf` path and WebSockets. Tailscale Serve proxies to a loopback service; choose a separate HTTPS listener/origin after checking the host's current Serve config so the existing app's route is not replaced. Tailnet authorization/grants are a separate decision. Do not copy the backend's private address into commits.
7. Once the live smoke checks pass, explicitly approve enabling `FRONTEND_RELEASES_ENABLED` and the host's user service/timer. Start the update service once and verify no-op behavior before enabling `abs-frontend-update.timer`. Future master pushes then build, release, and get pulled after the next timer check. There is a short interruption of this separate frontend during restart; its sockets reconnect afterward.

Manual rollback in the confirmed Linux profile: stop `abs-frontend-update.timer`, create a temporary symlink to the chosen **retained** `releases/<old-SHA>` beside `current`, atomically rename it over `current`, restart `abs-frontend.service`, and verify `/readyz` reports `<old-SHA>`. Keep the timer paused until the release channel is corrected; otherwise it will attempt the latest candidate again. Existing ABS data requires no rollback because this package owns none.

## Evidence and limits

Local validation covers the actual stock Axios refresh plugin/user refresh action, socket reauthentication, two-client progress broadcasts applied with the real Vuex progress mutation, direct-play track URLs from the real `AudioTrack` class, byte-exact range seeks/HEAD/416 behavior, HLS forwarding, secure multi-cookie preservation, redirects, API errors, gateway request guards, backend/version readiness, and update/rollback behavior with a throwaway filesystem. The headless demo additionally verifies actual stock UI login, bookshelf rendering, decoding/playback, and a seek beyond 23 seconds.

Live ABS compatibility, actual OpenID callbacks, public-share URL generation, Chromecast, TLS/Serve configuration, systemd installation, and real GitHub release-to-host delivery remain unverified. Upstream Vue/Nuxt dependencies include legacy/EOL packages and the existing lockfile reports audit findings; this change preserves the faithful baseline rather than silently rewriting dependencies. The gateway adds no runtime npm dependencies. Never infer production readiness from the synthetic demo.

Sources: [ABS reverse proxy documentation](https://www.audiobookshelf.org/guides/reverse-proxy/), [stock client socket initialization](https://github.com/ProgrammingDrak/audiobookshelf/blob/743d9152208507a1dbf7c95c94290071338f44bd/client/layouts/default.vue), [stock token refresh](https://github.com/ProgrammingDrak/audiobookshelf/blob/743d9152208507a1dbf7c95c94290071338f44bd/client/plugins/axios.js), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), [GitHub workflow token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).
