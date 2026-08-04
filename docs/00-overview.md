# 00 — Overview

## What TabTerm is

A macOS terminal system where local PTY sessions behave like native Chrome tabs.

A background daemon owns the processes. Chrome owns only the views. A terminal is a normal Chrome
extension page at a stable URL, so Chrome's own tab machinery (reorder, pin, move between windows,
group, close, restore) works on terminals for free.

## The one-sentence differentiator

> A persistent, programmable terminal system whose sessions behave like native Chrome tabs and can
> merge into or detach from terminal-only split workspaces.

Not "a terminal in a webpage." The value is that terminals live among ordinary tabs and inherit
Chrome's tab model, while the processes behind them outlive every view.

## Primary requirement

Close a Chrome tab containing a three-pane terminal workspace. Reopen it. The layout, the running
processes, and the exact screen contents of all three panes are intact, including a pane in the
middle of a `vim` edit with unsaved changes.

Everything else in the design exists to make that correct.

## Non-goals

- **Not an Electron app.** The entire premise is native Chrome tabs. If it becomes a standalone
  window with its own tab bar, it has no reason to exist.
- **Not a cross-platform terminal.** macOS only. Linux and Windows are not considered in any design.
- **Not a tmux replacement.** We own the PTY rather than wrapping tmux (ADR-0010), but we are not
  competing on multiplexer features.
- **Not a general remote terminal.** Loopback only. Never exposed off the machine.
- **Not an iTerm clone.** Some iTerm behavior is deliberately not recreated. See `10-limitations.md`.

## Design principles

1. **Native Chrome tabs first.** Preserve Chrome's tab model rather than replacing it with an
   internal tab bar.
2. **Processes belong to the daemon, not the page.** Closing or moving UI never kills a terminal.
3. **Stable session identity.** Every session and workspace has a durable, URL-addressable ID.
4. **Frontend views are disposable.** A renderer can disconnect and reappear without touching the PTY.
5. **Keyboard-first.** Every major action has a command and a shortcut.
6. **Mouse-friendly where it earns it.** Splits, pane movement, links, and paths.
7. **Safe by default.** Terminal output and project config are untrusted input, always.
8. **Lightweight.** No framework, no polling, no duplicated buffers, no permanent hidden renderers.
9. **Graceful expiration.** Survive accidental closes, then clean up on purpose.
10. **Standards over bespoke.** OSC 7, OSC 133, and agent CLI hooks instead of inventing protocols
    or scraping screens.

## System shape

```
Chrome extension  ──┬── service worker      (dispatch only, dies at ~30s idle)
                    ├── offscreen document  (control connection, notifications, tab actions)
                    └── terminal pages      (one data connection each, per-pane streams)
                              │
                     authenticated loopback WebSocket
                              │
                    macOS daemon  ── PTY sessions ── zsh / agent CLI / nvim / ssh / servers
                              │
                    launchd LaunchAgent (starts at login)
```

Full detail in `01-architecture.md`. The three-connection split is not optional; it is forced by
MV3 service worker lifetime and Chrome's tab discarding. See `06-chrome-integration.md`.

## Prior art worth reading

| Project | Why |
|---|---|
| **Google Werm** | Closest conceptual reference. Terminals in browser tabs, stable session URLs, persistent shells, reopen via browser history. Linux-focused server, no Chrome extension integration, no merge/detach model. |
| **Chrome Secure Shell / hterm** | Google's own extension that has rendered terminals in Chrome tabs for over a decade. The deepest existing source of scar tissue on browser terminal keyboard handling, IME, and macOS copy and paste. |
| **tmux** | Read `grid.c` and the control-mode protocol. It solved server-side VT state and reattach before us. We do not wrap it (ADR-0010) but we borrow its model. |
| **iTerm2** | Its tmux control-mode integration is the reference for attach and detach UX. Its shell integration defined OSC 133 in practice. |
| **xterm.js** | The renderer. Also the source for the headless emulator we run daemon-side. |
| **node-pty** | The PTY layer for v1. |

## Document map

| File | Contents |
|---|---|
| `00-overview.md` | This file. Product definition, principles, non-goals. |
| `01-architecture.md` | Components, process model, connection classes. |
| `02-protocol.md` | Wire protocol, framing, auth handshake, flow control. |
| `03-data-model.md` | SQLite schema and shared TypeScript types. |
| `04-session-lifecycle.md` | Session state machine, attach, detach, expiry, merge, restore. |
| `05-security.md` | Threat model, token bootstrap, TCC, untrusted input handling. |
| `06-chrome-integration.md` | MV3 shape, tabs, groups, titles, favicons, notifications, keyboard. |
| `07-terminal-fidelity.md` | VT state, serialization, renderers, resize arbitration. |
| `08-shell-integration.md` | OSC 7 and OSC 133. |
| `09-agent-integration.md` | Agent CLI hook bridge and state surfacing. |
| `10-limitations.md` | Tiered inventory of what Chrome and macOS will not permit. |
| `11-performance.md` | Memory budgets, flow control, throttling, latency targets. |
| `12-testing.md` | Fixtures, round-trip tests, manual verification protocol. |
| `13-packaging.md` | App bundle, launchd, extension distribution, install and upgrade. |
| `adr/` | Decision log. Append-only. Superseded, never deleted. |
