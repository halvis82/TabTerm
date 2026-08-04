# ADR-0005 — Token bootstrap via native messaging host

**Status:** Accepted

## Context
The daemon writes a secret to a 0600 file. Chrome extensions cannot read files. Any local process can
connect to the loopback socket and can forge an `Origin` header, so origin checking is not a security
boundary. The token is the only control, and it has to reach the extension somehow.

## Decision
A native messaging host whose manifest `allowed_origins` lists only our permanent extension ID.
Chrome enforces that allowlist, so the host also authenticates the extension in a way the WebSocket
alone cannot. The host reads one file and returns one message. It spawns nothing and accepts no
commands.

Fallback: `tabterm pair` prints a one-time code the user pastes into the options page. This must work,
because it is the recovery path when the host breaks.

## Consequences
- One more install artifact and one more thing `tabterm doctor` checks.
- The extension caches the token in `chrome.storage.session`, never `local`, and never logs it.
- Rotation invalidates live connections and triggers re-bootstrap automatically.

## Alternatives rejected
- **Native messaging for all traffic.** Stdio, 1 MB message cap, awkward multi-tab lifecycle. Wrong
  shape for continuous high-volume terminal streaming.
- **Token in the extension's source.** Not a secret.
- **No token, origin check only.** Forgeable by any local process, and any website can open a
  WebSocket to loopback with no CORS preflight.
