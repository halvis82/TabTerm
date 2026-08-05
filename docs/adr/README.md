# Architecture Decision Records

Append-only. A decision is never edited to say something different; it is **superseded** by a new
ADR that references it. The old one stays with status `superseded by ADR-NNNN`.

Every ADR uses this shape: Context, Decision, Consequences, Alternatives rejected, Status.

File a new ADR whenever a change makes a choice that a future reader would otherwise have to
reverse-engineer from the code. This is part of the definition of done.

## Index

| ID | Title | Status |
|---|---|---|
| [0001](0001-daemon-owns-processes.md) | The daemon owns processes, not the page | Accepted |
| [0002](0002-node-and-vanilla-typescript.md) | Node + node-pty daemon, vanilla TypeScript extension | Accepted |
| [0003](0003-three-connection-classes.md) | Three connection classes, not one | Accepted |
| [0004](0004-server-side-vt-state.md) | Server-side headless VT state for reattach fidelity | Accepted |
| [0005](0005-token-bootstrap-via-native-host.md) | Token bootstrap via native messaging host | Accepted |
| [0006](0006-signed-app-bundle-for-tcc.md) | Daemon ships as a signed app bundle | Accepted |
| [0007](0007-permanent-extension-id.md) | Mint a permanent extension ID before any URL exists | Accepted |
| [0008](0008-osc7-osc133-over-bespoke.md) | OSC 7 and OSC 133 instead of a bespoke shell protocol | Accepted |
| [0009](0009-agent-hooks-not-parsing.md) | Agent CLI hooks, never output parsing | Accepted |
| [0010](0010-own-the-pty-not-tmux.md) | Own the PTY rather than wrapping tmux | Accepted |
| [0011](0011-duplicate-tab-mirrors.md) | Duplicating a tab mirrors the session | Accepted |
| [0012](0012-workspaces-pinned-by-default.md) | Workspaces are pinned by default | Accepted |
| [0013](0013-defer-plugin-api.md) | Defer the plugin API until the seams are known | Accepted |
| [0014](0014-cut-finder-drag.md) | Cut drag-from-Finder path insertion | Accepted |
| [0015](0015-node-sqlite-over-native.md) | Node's built-in SQLite, and Node 22 or newer | Accepted |
