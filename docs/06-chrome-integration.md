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

Notifications and daemon-initiated tab actions are **triggered** by the offscreen document, which
is the only context that survives both a hidden tab and a discarded one. They are **fired** by the
service worker, which is the only context with the APIs.

The offscreen document relays over `chrome.runtime.sendMessage`, and that message also wakes the
worker, which by then has died. Verified: with the worker confirmed dead after idling out, a relay
from the offscreen document woke it and it fired a notification.

This is a three-step path rather than a two-step one, and the reason is worth stating plainly. The
context that can always hear from the daemon cannot act, and the context that can act cannot always
be listening. Neither alone is sufficient.

### What an offscreen document is actually given

Measured on Chrome 150, and it constrains the design:

| API | Offscreen document | Service worker | Extension page |
|---|---|---|---|
| `chrome.runtime` | ✅ | ✅ | ✅ |
| `chrome.storage` | ❌ **undefined** | ✅ | ✅ |
| `chrome.runtime.sendNativeMessage` | ❌ **undefined** | ✅ | ✅ |
| `chrome.notifications` | ❌ **undefined** | ✅ | ✅ |
| `chrome.tabs` / `chrome.tabGroups` | ❌ **undefined** | ✅ | ✅ |
| `chrome.windows` | ❌ **undefined** | ✅ | ✅ |
| `WebSocket` | ✅ | ✅ | ✅ |

Measured on Chrome 150: an offscreen document is given **only `chrome.runtime`**. Everything else
is undefined there, not merely restricted.

An offscreen document therefore **cannot fetch the daemon token itself**. It has no storage to
cache it in and no native messaging to obtain it. It asks the service worker, which has the full
surface, over `chrome.runtime` messaging. Sending that message also wakes the worker if it has
already died, which it will have.

Only **one** offscreen document may exist per extension, and `getContexts` can report zero while a
creation is still in flight. Two callers racing both try to create and the second throws
`Only a single offscreen document may be created`. Memoize the creation promise.

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

Canvas-generated data URLs assigned to `<link rel="icon">`.

| State | Icon | Means |
|---|---|---|
| `idle` | Caret | Nothing to report |
| `running` | Caret, sweeping underline | A command is in flight |
| `done` | Grey bar | Finished, with no exit code to say how. See ADR-0016 |
| `success` | Green tick | Exited zero |
| `failed` | Red cross | Exited non-zero |
| `waiting` | Amber dot | An agent is waiting for a person |
| `approval` | Amber dot, ringed | An agent needs approval |
| `disconnected` | Grey caret | No session |

**Shape carries the state as well as color.** At 16 pixels in a strip of twenty tabs, hue is the
first thing read and the first thing lost. Roughly one man in twelve cannot separate the red from
the green, so success is a tick and failure is a cross, and the color agrees with the shape rather
than carrying it alone.

Multi-pane priority, highest wins, because a tab has exactly one favicon:

```
approval > waiting > failed > success > done > running > idle
```

Waiting outranks failed deliberately: one of them can still be acted on.

### Outcomes wait to be seen

`success`, `failed` and `done` persist **until the tab is actually looked at**, and are cleared by
the look rather than by a timer. This is the whole point of the indicator. A command that finished
while you were in another tab is exactly the thing you left to find out, and a state that expires
on a timer expires while nobody is there to read it.

Conditions do not work this way. `running` describes the present and speaks for itself, and
`approval` clears when the approval is answered rather than when it is noticed.

**Animation policy, from the background-tab status spike:**

| Tab state | Behavior |
|---|---|
| Visible | Animate freely, capped at 5 fps |
| Hidden | **Discrete state icons only.** No animation |
| Discarded | Frozen at discard time. Nothing we can do |

The hidden row is not a preference. Measured over eight minutes, a hidden tab's `setInterval(1000)`
delivers 59 ticks in the first minute and **one per minute after that**, so a self-driven pulse
there is a still image that occasionally jumps. A pane needing input gets a distinct static icon,
and the thing that actually reaches somebody looking elsewhere is the notification. See
`10-limitations.md` tier 1.1.

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

### What raises one

| Event | Priority | Gated by |
|---|---|---|
| Agent needs approval | Critical | Nothing. It is the case this exists for |
| Agent waiting for input | Important | Nothing |
| Agent turn finished | Important | Duration threshold |
| Shell command finished | Important | Duration threshold |
| Shell command failed | Critical | Duration threshold |

**The threshold is enforced in the daemon**, not in the page. The duration is authoritative there,
and a discarded tab has nothing left to make the decision with. Default 60 seconds, clamped to
between 5 seconds and 10 minutes so a stored value cannot make it notify about `ls` or about
nothing. Set from the settings pane, persisted, and read back from the daemon rather than assumed.

A failure passes the same threshold as a success. A command that fails instantly is a typo, and
being told about typos is how people turn notifications off.

**An agent turn is the event a command boundary cannot see.** The shell command is the agent CLI
itself and it runs for an hour, so `command-end` fires when it is quit rather than when it finished
thinking. Turns are bounded by the hooks that report their ends, which is why
`09-agent-integration.md` treats hook installation as part of the product rather than as a
footnote in the installer.

### Suppression

Suppressed when the relevant pane is visible and focused, when the command completed faster than the
configured threshold, when the session is muted, or when the same status is already obvious.

Visibility is decided by the **extension**, because only it can see which tab is active in which
focused window. The daemon knows what happened, not who is watching, so it marks the notification
`suppressIfVisible` and the service worker resolves it. A tab counts as being looked at only when
it is the active tab of a focused window, so a terminal sitting in a background window still
notifies.

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
    "new-terminal":    { "suggested_key": { "mac": "Command+Shift+O" } },
    "open-agent":      { "suggested_key": { "mac": "Command+Shift+J" } },
    "command-palette": { "suggested_key": { "mac": "Command+Shift+K" } },
    "history-search":  { "suggested_key": { "mac": "Command+Shift+Y" } }
  }
}
```

Every permission is justified line by line in `05-security.md` §8. No `<all_urls>`. No broad content
scripts.

`Command+Alt` combinations are rejected by Chrome on macOS, and only **four** commands may carry a
suggested key, so these are the entire budget. Everything else reaches the command palette.

**Verified bound at runtime**, Chrome 150: `Command+Shift+O`, `Alt+Shift+T`, and
`MacCtrl+Shift+T`. Manifest acceptance is not binding, so this was read back with
`chrome.commands.getAll()` rather than assumed. See `10-limitations.md` tier 1.8. All are
rebindable at `chrome://extensions/shortcuts`.

### You never focus the terminal

A terminal has no other controls, so nobody expects to click into one before typing. This page
*does* have other controls, and clicking any of them used to take the keyboard away with no way
back except clicking the terminal again.

The rule: **if you are not deliberately typing into a text field, you are typing into the
terminal.** Focus moves during the capture phase of `keydown`, so the keystroke that triggered
it lands in the terminal rather than being spent getting there. Clicking a button does its job
and hands the keyboard straight back.

The exception is a real text field — the palette's search box, the launcher's folder box, the
placeholder inputs — where the user deliberately put the cursor and typing means something else.
Modified keys are left alone too: a browser shortcut is not typing, and moving the cursor for
one that never reaches the page would be a side effect of nothing.

### The panel belongs to a new tab only

A page that opens with a workspace id in its URL is reattaching to a session somebody already
has, most often because they reloaded. It is not a new tab, so it gets no panel and the terminal
takes the whole window immediately.

Without that, a reload put the panel back over a session that already had output, and the output
was crammed into the strip the panel leaves for the prompt. The flag is read **once at load**,
because the URL gains a workspace id as soon as a session is created and would otherwise stop
telling the two cases apart within the same page.

### The launcher is drawn over the terminal, not instead of it

There is a live shell behind the panel from the moment the tab opens, already able to receive
input. What is on top is there only because there is no output yet.

So it **survives typing and goes when a command is sent**. Dismissing on the first keystroke
made a half-typed command the moment everything vanished, which is both startling and exactly
when the list might still be wanted. A carriage return is what a shell treats as "run it", and
that is the moment someone has stopped choosing and started working.

### Selecting and acting are separate

Arrow keys, `Home`, `End`, or a click move the highlight. **Nothing acts on a row until you say
so**, which is the whole reason the distinction exists: a list that pastes into a live terminal
the instant you click gives you no chance to read a command before choosing it, and the row
under the pointer when a list re-renders is not necessarily the row you meant.

| Key | Does |
|---|---|
| Arrows, `Home`, `End`, click | Select only |
| `Enter` | Paste the selected row at the prompt |
| `Shift+Enter` | Run it |
| `Command+Enter` | Copy it |
| `Command+S` | Save it |
| `Escape` | Close |

Clicking returns focus to the input, so `Enter` works immediately afterwards rather than
requiring the pointer and the keyboard to agree on where focus is.

Selection carries an accent bar as well as a background, and hover is deliberately weaker than
selection, because the two now mean different things.

Enter and the row buttons share one activation path. When clicking and Enter had separate
copies they drifted, and the same row behaved differently depending on how you reached it.

For an action row, `Command+Enter` does nothing: an action is a thing to do, not text, and
copying it has no meaning worth inventing.

### The command palette is the primary surface

`Shift+Command+P`. Every pane, workspace, and session action is in it, filtered by the same
subsequence match the history search uses, so `sp` finds "Split right" the way `gco` finds
`git checkout`.

This replaces a control bar rather than duplicating one, per design principle 9. A
thirteen-button strip is something you have to remember the layout of; a searchable list is
something you can describe. Actions head the list, ahead of saved items and history, because
they are the only rows that *do* something rather than being text.

Two details that matter more than they look:

- **Actions that cannot apply are omitted, not disabled.** "Close this pane" does not appear in
  a one-pane tab. A palette offering something that does nothing is worse than a shorter one.
- **Each action shows its keystroke where one exists.** The palette teaches the shortcut instead
  of becoming the only way to reach it.
