# 06 — Chrome Integration

Everything here is constrained by what Chrome actually permits. Read `10-limitations.md` alongside it.

---

## 1. Extension identity

The extension ID is **permanent**. It was minted before any session URL existed, and it is:

```
mcchodnlokiofihbecdeicicfhmgpadb
```

It is derived by Chrome from the `"key"` field in `manifest.json`, which holds the base64 DER
public key of a keypair generated once. The private half is never in this repository.

Without an explicit `key`, an unpacked extension's ID derives from its load path. Change the path or
reinstall from elsewhere and the ID changes, which kills **every stable session URL in Chrome's
history and recently-closed stack**. Unrecoverable after the fact. This is why the key is fixed before anything else.

The ID also appears in the native messaging host manifest's `allowed_origins`, which is what makes
the host authenticate the extension.

Distribution is either an unlisted Web Store listing or a macOS managed-policy forcelist. Both give
a stable ID and auto-enable at Chrome start.

---

## 2. The three-connection model

Forced by two Chrome behaviors, neither optional.

**MV3 service workers terminate after roughly 30 seconds idle.** Recent Chrome resets that timer on
WebSocket activity, but an idle terminal sends nothing, so it still dies. the service worker lifetime spike measures the real
numbers.

**Chrome discards background tabs under memory pressure.** The renderer is destroyed. The tab
remains in the strip with its title and favicon **frozen at discard time**. The socket is gone.

| Class | Host | Carries |
|---|---|---|
| **Control** | Offscreen document, one per profile | Session state, notification triggers, daemon-initiated tab actions |
| **Data** | Terminal page, one per page | Terminal streams for every pane in that page |
| **Dispatch** | Service worker | `chrome.commands`, context menus, action clicks. Wakes, forwards, dies |

**The failure this prevents:** with the connection in the service worker, a agent CLI permission
prompt arriving while all terminal tabs are hidden produces no notification. The user waits on a tab
that looks idle. With the connection in a terminal page, the same happens the moment Chrome discards
that tab.

Notifications and daemon-initiated tab creation therefore originate **only** from the offscreen
document. Never from a terminal page.

---

## 3. Tabs

### Opening

Via `chrome.commands`. **`Command+Alt` combinations are rejected outright** by manifest validation
on macOS, so the originally planned `Cmd+Option+T` is not available. See `10-limitations.md` tier 1.8.
Accepted patterns include `Command+Shift+<key>`, `Alt+Shift+<key>`, and `MacCtrl+Shift+<key>`, and at
most **four** commands may carry a suggested key. All are rebindable at `chrome://extensions/shortcuts`.

Extension commands are routed by Chrome and are not subject to the page-level interception limits in §6.

New tabs open at `currentIndex + 1` and inherit the current tab's group when one exists.

### Stable URL

```
chrome-extension://mcchodnlokiofihbecdeicicfhmgpadb/terminal.html?workspace=<workspace-id>
```

Always a workspace ID, never a session ID, because a standalone terminal **is** a one-pane
workspace (`03-data-model.md` §2). That is what makes merge and detach symmetric rather than
special cases.

### Duplicate

`chrome.tabs.duplicate` produces a second tab with the same URL. Per ADR-0011 this **mirrors** the
session rather than forking a new one. Both views are live, resize arbitration applies
(`04-session-lifecycle.md` §2).

### Restore

Chrome restores the URL. The page attaches lazily on `visibilitychange`. See
`04-session-lifecycle.md` §5.

`Cmd+Shift+T` cannot be intercepted or filtered. Restoring an expired session's URL is normal and
handled by the recovery page. Chrome offers no API to remove one entry from the recently-closed
stack (`10-limitations.md` tier 0.2).

---

## 4. Tab groups

`chrome.tabGroups` is used, not worked around.

- A new terminal inherits the current tab's group
- Optional auto-grouping by git repository root
- Group title is arbitrary. **Group color is a fixed enum** (grey, blue, red, yellow, green, pink,
  purple, cyan, orange). Arbitrary hex is not supported. Template `color` fields are validated
  against the enum
- A merged workspace keeps the **receiving** tab's group. Merging never moves the receiving tab

---

## 5. Titles and favicons

### Titles

The page sets `document.title`. The daemon supplies **structured fields**
(`TitleFields` in `03-data-model.md`), never a display string, so hostile OSC title output cannot
inject formatting. The frontend composes.

```
agent — eeg-analysis
nvim — filter.py
zsh — ~/Projects/TabTerm
ssh — production
tests — failed
```

Updates are rate-limited. Chrome truncates long titles; the format puts the distinguishing token
first.

**A pinned Chrome tab renders only the favicon, no title text.** So for pinned sessions the favicon
carries everything. See `10-limitations.md` tier 1.6.

### Favicons

Canvas-generated data URLs assigned to `<link rel="icon">`. States:

```
idle · running · waiting · approval · success · failure · disconnected
```

Multi-pane priority, highest wins, because a tab has exactly one favicon:

```
approval > failure > waiting > running > idle
```

**Animation policy, from the background-tab status spike:**

| Tab state | Behavior |
|---|---|
| Visible | Animate freely, capped at 5 fps |
| Hidden | **Discrete state icons only.** No animation |
| Discarded | Frozen at discard time. Nothing we can do |

Measured on Chrome 150: in a hidden tab `requestAnimationFrame` is fully paused and
`setInterval(1000)` drops to 0.53/s, so a self-driven spinner cannot animate. But **WebSocket
delivery to a hidden tab is completely unthrottled** (60 of 60 at 10 Hz), title and favicon writes
still apply, and a hidden tab repainted its favicon 25 out of 25 times at 5 fps under push.

So push-driven animation in a background tab is possible. We decline it because it wakes a renderer
several times a second per hidden tab for little benefit, not because it fails.

**Consequence:** the favicon is not a reliable status channel for a tab you are not looking at.
Anything that must reach the user while the tab is hidden or discarded goes through a notification
from the offscreen document.

---

## 6. Keyboard

### What a page cannot receive

These are consumed by Chrome or macOS and never reach the page in a cancelable form:

```
Cmd+W   Cmd+T   Cmd+N   Cmd+Q   Cmd+Shift+T   Cmd+L   Cmd+1..9   Cmd+Opt+←/→
```

This is mostly desirable. It is what makes terminal tabs behave like tabs.

**The cost:** in a multi-pane workspace, `Cmd+W` closes the whole tab and detaches every pane. It
cannot be remapped to "close the focused pane." Per-pane actions use `chrome.commands` bindings or
the command palette instead. The full reachability matrix is produced by the keyboard reachability spike.

### Keyboard lock

`navigator.keyboard.lock()` captures browser and system shortcuts including `Cmd+W`, but **only in
fullscreen**. Focus mode (focus mode) uses it. The lock is released on exit, always, including on crash
paths.

### Option as Meta

`macOptionIsMeta` makes Option send Meta to the PTY, which terminal users expect. The cost is that
Option+letter no longer types accented characters. Default chosen in the keyboard reachability spike and configurable.

This also conflicts with Option-click for file opening (the editor-open work) and with Option-drag for
rectangular selection. The resolution is documented there.

### Terminal keys

`Ctrl+C`, `Ctrl+U`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+A`, `Ctrl+E`, arrows, tab completion, and history all
pass to the PTY untouched. `Cmd+C` copies the selection without sending an interrupt. `Cmd+V` pastes
with bracketed paste.

---

## 7. Notifications

`chrome.notifications`, fired from the offscreen document so they work with every terminal tab
hidden or discarded.

### Suppression

Suppressed when the relevant pane is visible and focused, when the command completed faster than the
configured threshold, when the session is muted, or when the same status is already obvious.

**macOS Do Not Disturb is not queryable.** macOS honors Focus modes and will swallow the
notification, and the extension cannot know it happened. See `10-limitations.md` tier 1.4.

### Priority

| Tier | Events | Channel |
|---|---|---|
| Critical | Permission required, process failed, SSH disconnected, server crashed | Desktop notification |
| Important | agent waiting for input, long command completed, deployment finished | Desktop notification, threshold-gated |
| Low | Short successful command, shell idle, routine output | Favicon and title only |

### Click behavior

Focus the window, focus or open the tab, focus the correct pane. The target is carried in the
`notify` message's `target` field so no lookup is needed at click time.

---

## 8. Renderer policy

From the WebGL context spike.

Measured on Chrome 150: the cap is **exactly 16 contexts per page**, and the 17th evicts the oldest.
But it is per page, not global. Twenty separate tabs each holding a context showed **zero loss**,
which is the shape TabTerm actually renders in.

Only a single tab holding 17 or more simultaneously rendering panes can hit the cap, which no
realistic layout reaches. Handle `webglcontextlost` as correctness insurance rather than an expected
steady state.

| Pane state | Renderer |
|---|---|
| Visible and focused | WebGL |
| Visible, unfocused | WebGL, falling back to canvas past 16 panes in one tab |
| Hidden pane in a visible tab | Suspended, no renderer |
| Tab hidden | Suspended after a configured delay, state retained, redraw from daemon snapshot on reactivation |

`webglcontextlost` is handled everywhere a WebGL renderer exists. Losing a context degrades to
canvas, it never breaks the pane.

---

## 9. Manifest sketch

```json
{
  "manifest_version": 3,
  "name": "TabTerm",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...",
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "permissions": [
    "tabs", "tabGroups", "offscreen", "storage",
    "notifications", "nativeMessaging", "contextMenus",
    "clipboardRead", "commands"
  ],
  "commands": {
    "new-terminal":    { "suggested_key": { "mac": "Command+Shift+E" } },
    "open-agent":      { "suggested_key": { "mac": "Command+Shift+J" } },
    "command-palette": { "suggested_key": { "mac": "Command+Shift+K" } },
    "history-search":  { "suggested_key": { "mac": "Command+Shift+Y" } }
  }
}
```

Every permission is justified line by line in `05-security.md` §8. No `<all_urls>`. No broad content
scripts.

`Command+Alt` combinations are rejected by Chrome on macOS, and only **four** commands may carry a
suggested key, so these four are the entire budget. Everything else reaches the command palette.
All four are user-rebindable at `chrome://extensions/shortcuts`, and whether Chrome actually binds a
given key at runtime still needs one manual confirmation.
