# Agreed Docker hosting: remaining handoff

Jesse has agreed to host Drake's separate Audiobookshelf interface, with Docker required. The package preserves the stock ABS interface and connects to Jesse's existing backend using the same normal account, library, and listening progress. It runs one separate frontend container; it has no library mount, scanner, or second database.

The container runs as UID 1000 with a read-only filesystem, dropped capabilities, no-new-privileges, bounded memory/processes/logs, and no Docker socket. Its host port is loopback-only behind a separately approved private HTTPS ingress.

Automatic updates are part of the handoff: reviewed GitHub master changes produce architecture-specific versioned images. A host-owned updater checks the release channel every five minutes, validates exact image IDs/checksums, waits for backend-compatible health, and rolls the frontend back if a replacement fails. It does not change or restart the original ABS backend.

We still need these **non-secret facts** before installing:

- Host OS, Docker/Compose versions, actual Docker daemon architecture, and who will perform the approved install.
- Existing ABS version and local-account versus OpenID login, plus / versus /audiobookshelf base path.
- An existing approved backend address/network route reachable from the new container. A container's 127.0.0.1 is not the host.
- An unused frontend host port and approved private HTTPS origin/ingress arrangement.
- Python 3.9+ and the host owner's preferred scheduler for the updater; Linux user-systemd templates are supplied, and other hosts can schedule the same command.

Do not share passwords, tokens, keys, or secret-containing screenshots. Host permission is already confirmed; persistent credential creation, new grants, and network-security changes still require their own action-time approval if needed. The next step is verified host access and approved live normal-account login/stream/seek/progress tests, then installation and activation of the release channel/updater. Nothing has been installed on Jesse's host or published as a release yet.

The practical Docker run/update/rollback sequence is in [docker/DOCKER-HANDOFF.md](docker/DOCKER-HANDOFF.md). The tested frontend baseline is ABS 2.37.1; a different backend version requires a matching source build and compatibility test.
