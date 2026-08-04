# ADR-0003 — Three connection classes, not one

**Status:** Accepted

## Context
MV3 service workers terminate after roughly 30 seconds idle. Chrome discards background tabs under
memory pressure, destroying their renderers and their sockets. Neither can hold a connection that
must always exist.

The concrete failure: with the connection in the service worker, a agent CLI permission prompt
arriving while every terminal tab is hidden produces no notification. The user waits on a tab that
looks idle. With the connection in a terminal page, the same happens the moment Chrome discards it.

## Decision
Three classes:
- **Control** — offscreen document, one per Chrome profile. State events, notifications,
  daemon-initiated tab actions. Must survive indefinitely.
- **Data** — terminal page, one per page, multiplexing that page's panes. High volume, lifetime
  matches the renderer that consumes it.
- **Dispatch** — service worker. Wakes for a command or context menu, forwards, dies. Holds nothing.

## Consequences
- Notifications and daemon-initiated tab creation originate only from the offscreen document.
- The control connection must be idempotent on reconnect: the daemon re-sends current state rather
  than a delta, so a missed window costs nothing.
- the service worker lifetime spike must measure real offscreen document lifetime before anything depends on it.

## Alternatives rejected
- **One connection in the service worker.** Dies. Documented above.
- **One connection in a designated terminal tab.** Dies on discard, and creates a special tab.
