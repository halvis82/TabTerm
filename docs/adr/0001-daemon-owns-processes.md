# ADR-0001 — The daemon owns processes, not the page

**Status:** Accepted

## Context
Chrome destroys renderers without warning: tab close, tab discard under memory pressure, renderer
crash, Chrome quit. If a PTY's lifetime were tied to a page, any of those would kill a running build,
a agent session, or an unsaved vim buffer.

## Decision
A background daemon owns every PTY. No PTY is ever a child of a Chrome page's lifetime. Frontends are
disposable caches of daemon state.

## Consequences
- Closing, moving, merging, or detaching a view never touches a process. This is the product.
- The daemon must know what each screen looks like, which forces ADR-0004.
- The daemon must always drain the PTY, because a paused read blocks the child on write().
- Session expiry becomes a deliberate policy decision rather than a side effect of UI, see ADR-0012.

## Alternatives rejected
- **PTY per page.** Would make every Chrome tab-management action destructive. Defeats the premise.
- **Page holds the PTY, daemon holds a backup.** Two authorities, guaranteed divergence.
