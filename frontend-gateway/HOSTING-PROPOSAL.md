# Proposed separate Audiobookshelf interface

Drake has prepared a fork of the existing Audiobookshelf web interface and a small gateway. The local demonstration signs in, shows a bookshelf, plays generated audio, and supports seeking and progress updates.

The proposal is to run **one separate frontend service on an unused loopback port**, with its own private HTTPS address. It would connect to your existing Audiobookshelf backend and use the same normal account, library, and listening progress. Your existing Audiobookshelf app keeps its current address and service. This package has no media storage, library scanner, or second database.

For future updates, reviewed changes in Drake's GitHub fork would produce a versioned bundle. A host-owned updater would pull it and check its health. A failed update rolls the frontend back to its previous version. GitHub would not get a host login or broad access to your machine.

Nothing has been installed or tested against your server yet. Before choosing the install steps, we need:

- Whether you are comfortable hosting this additional service, and where you would prefer it to run.
- The host OS/service manager and whether Node 24 is available.
- Your ABS version, whether it is served at `/` or `/audiobookshelf`, and whether login uses local accounts or OpenID.
- A preferred private HTTPS address/port and confirmation that it will not replace an existing route.
- Who would own enabling/disabling updates and the rollback procedure.

Please share **no passwords, tokens, keys, or screenshots containing secrets**. If you agree with the approach, the next step is a separately approved connectivity/account test and choosing the host-specific service/ingress setup. The first version intentionally keeps the stock Audiobookshelf interface; customization can follow once that baseline works with your backend.

The prepared Linux/systemd-user profile is optional pending your host details. It checks for updates every five minutes; installation and update activation require your approval. Detailed run/health/rollback steps are in [README.md](README.md).
