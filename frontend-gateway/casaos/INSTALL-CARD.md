Drake's Audiobookshelf in CasaOS

The public amd64/arm64 image is published and verified. The operator fills the existing backend address and approved private HTTPS address in `compose.yaml` before forwarding it, and confirms the backend is version 2.37.1.

1. In CasaOS, open App Store → Custom Install → Import → Docker Compose.
2. Paste the supplied `compose.yaml` and confirm the existing Audiobookshelf address.
3. Click Install. Open “Drake's Audiobookshelf” and use your existing account.

No books, accounts, or library folders need to be copied. The reserved host port is 13379.

Automatic updates need a separate, one-time host updater installation by the operator. They are not enabled by importing the app. The checked-in file contains example addresses; the operator must fill them before Jesse receives it.

Image/package: https://github.com/ProgrammingDrak/audiobookshelf/pkgs/container/audiobookshelf-frontend
