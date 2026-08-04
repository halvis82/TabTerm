# ADR-0007 — Mint a permanent extension ID before any URL exists

**Status:** Accepted

## Context
Every terminal is addressed by `chrome-extension://<id>/terminal.html?workspace=<id>`. Unpacked
extension IDs derive from the load path. Change the path or reinstall from elsewhere and the ID
changes, which kills every stable session URL in Chrome's history and recently-closed stack. There is
no recovery after the fact.

## Decision
Generate a keypair and embed `"key"` in `manifest.json` in Phase 0, extension identity minting, before a single session
URL is ever created. The private key is stored outside the repository. The same ID goes into the
native messaging host's `allowed_origins`.

## Consequences
- The ID is fixed for the life of the project. Updates must never change it.
- Distribution is an unlisted Web Store listing or a managed-policy forcelist, both of which preserve
  the ID and auto-enable at Chrome start.
- Development loads unpacked, with the key already in place, so the dev ID equals the production ID.

## Alternatives rejected
- **Let the ID float during development, fix it later.** Every URL created before the fix dies, and
  the failure is silent and confusing.
