# 07 — Terminal Fidelity

TabTerm must behave like a modern terminal emulator. Anything less and it is a toy.

---

## 1. The byte path

```
process → PTY → daemon → VT state machine + scrollback → coalesce → WebSocket → xterm.js
```

The PTY byte stream is forwarded **essentially unchanged**. It is never re-encoded, never
base64-wrapped, never parsed for content on the forwarding path. The daemon's VT state machine is a
parallel consumer, not a filter.

This preserves ANSI colors, 256-color, truecolor, bold, dim, italic, underline, inverse, cursor
movement, alternate screen, box drawing, progress indicators, menus, mouse events, terminal titles,
OSC 8 hyperlinks, and the full Vim and agent CLI interfaces.

Environment:

```
TERM=xterm-256color
COLORTERM=truecolor
```

---

## 2. Server-side VT state

**The single most load-bearing decision in the project** (ADR-0004). Validated by the VT fidelity spike before any
production code depends on it.

### Why it is required

When a tab closes and reopens, the new renderer needs to know what the screen looks like. Replaying
a raw byte log does not work: the moment an application used the alternate screen, replay produces
garbage, because the log contains a sequence of screens rather than the current one.

So the daemon runs a **headless terminal emulator per session**, fed by the same byte stream, and
serializes its state on attach.

### Why the same emulator as the renderer

We use the headless build of the same emulator that renders in the page. Any parsing difference
between daemon and renderer would produce a snapshot that restores into a subtly different screen,
and that class of bug is close to undebuggable. Using one implementation makes the mismatch
impossible by construction.

### What the snapshot must carry

- Grid dimensions
- Every cell: codepoint(s), foreground, background, and attribute flags
- Cursor position, visibility, shape
- Saved cursor state
- Alternate screen flag, and the preserved primary screen when it is active
- Scroll region bounds
- Character set state, pending mode state
- Bracketed paste, application cursor, and mouse reporting modes
- Scrollback up to the cap
- The sequence number the live stream resumes from

Anything the chosen library does not round-trip is a **known fidelity gap** and gets recorded in §7
of this document by the VT fidelity spike.

### Costs, measured in the VT fidelity spike

- Resident memory per session at 1k, 10k, and 50k scrollback lines
- Serialization time and size at those caps

Measured: **around 30 MB per session** of live emulator at the 10,000-line default cap, and 32 ms
to serialize. The *serialized snapshot* is far smaller, 0.3 to 3.6 MB depending on how
compressible the screen content is, and is not a proxy for the live cost. See
`11-performance.md` §1.
`11-performance.md` carries the full table.

The implementation is `@xterm/headless` with `@xterm/addon-serialize`, verified against seven
recorded PTY fixtures including three captured inside the alternate screen. All seven round-trip
cell for cell, and the preserved primary buffer survives a snapshot taken while a full-screen
application is running, so reattaching mid-edit does not destroy shell history.

---

## 3. The drain invariant

> The daemon always reads the PTY. It never applies backpressure toward the child process.

If reads stop, the PTY buffer fills and the child blocks on `write()`. To a user that looks like a
hung terminal, with no indication why. So output is always consumed, always fed to the VT state
machine, always appended to scrollback.

Memory is bounded by **evicting old scrollback**, never by pausing. A detached session with no
frontends drains exactly as fast as an attached one.

When a client falls more than one credit window behind, the daemon stops sending to that client,
keeps draining, and on catch-up sends a **fresh snapshot** rather than replaying the backlog.
Terminals are idempotent on redraw. Nobody needs to watch a 500 MB `cat` scroll past in real time.

---

## 4. Resize

The PTY has one size. With N attached clients, the applied size is the minimum cols and minimum rows
across all of them, per dimension independently. Full rules in `04-session-lifecycle.md` §2.

Frontend resize is throttled and debounced before it reaches the wire. A drag on a split divider
must not produce a `SIGWINCH` storm.

---

## 5. Renderers

| Renderer | Use |
|---|---|
| WebGL | Visible, focused panes, while under the context budget |
| Canvas | Visible unfocused panes beyond the budget, and after context loss |
| DOM | Fallback only |

Chrome caps concurrent WebGL contexts per process and drops the oldest silently when exceeded.
`webglcontextlost` is handled wherever a WebGL renderer exists; losing a context degrades to canvas
and never breaks the pane. The measured ceiling comes from the WebGL context spike. Full policy in
`06-chrome-integration.md` §8.

Hidden panes and hidden tabs suspend their renderers entirely after a configured delay and redraw
from a daemon snapshot on reactivation. State lives in the daemon, so suspension costs nothing but
a redraw.

---

## 6. Input fidelity

### Keys to the PTY

`Ctrl+C`, `Ctrl+U`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+A`, `Ctrl+E`, arrows, tab completion, shell history,
and all Vim and agent CLI controls pass through untouched.

### Option as Meta

`macOptionIsMeta` sends Meta rather than typing accented characters. Default set by the keyboard reachability spike.
Interacts with Option-click file opening and Option-drag rectangular selection; resolution documented
in `06-chrome-integration.md` §6.

### Copy, paste, selection

Routing lives in `extension/src/terminal/keymap.ts`, kept pure so the policy is testable without
a renderer. The rule people actually care about on macOS:

> **Control keys reach the shell. Command keys do not.**

`Ctrl+C` must interrupt and `Cmd+C` must copy without interrupting anything. Getting that
backwards in either direction is the difference between a terminal and a text box that looks
like one, so both halves are asserted together in `keymap.test.ts` and again end to end in the
headless run.

| Key | Behavior |
|---|---|
| `Ctrl+`anything | Straight to the PTY, always |
| `Cmd+C` | Copies the selection. With nothing selected it goes to Chrome rather than being swallowed |
| `Cmd+V` | Pastes through xterm's `paste()`, so bracketed paste applies where the application asked for it |
| `Cmd+A` | Selects the terminal buffer |
| `Cmd+K` | Opens the command menu |
| `Shift+Cmd+K` | Clears the terminal, everywhere it is kept |
| Everything else with `Cmd` | Chrome's. In a normal tab those never reach the page at all |

`Cmd+K` clears the screen in most terminals, and it did here too until the command menu wanted
the same key. Both fired: opening the menu wiped the scrollback behind it, while opening it from
the button did not, which is the kind of difference nobody can explain from the outside. Clearing
moved to `Shift+Cmd+K` and the menu owns `Cmd+K` alone.
| Anything else | To the PTY |

`to-pty` is the default on purpose: a terminal that silently swallows keys is worse than one
that passes through something the page might have wanted.

Drag selects, double-click selects a word or path, triple-click selects a line, and shift-click
extends, all from xterm.

### Landmarks

A pane can print a landmark: a solid colored bar with a label, from its own menu. It is written
into the session's **output**, never to the PTY. That distinction is the whole design. Output is
what the terminal has already printed, so a landmark scrolls with the work it marks and survives
a reload and a daemon restart because it sits in the ring and on disk with everything else.

Sending `echo` to the shell instead would put a command in somebody's history, run in whatever
program happened to be in the foreground, and be impossible while a command was already running.

A landmark is **found by what it looks like** rather than by a hidden sentinel: a solid bar of one
explicit 24-bit background, which no ordinary output produces. So it is found again after a
reload with nothing having to remember where it was, and it stops being found the moment its
lines fall off the end of the scrollback, which is exactly when it stops being reachable.

Two details that were wrong first:

- The bar stops **one column short** of the terminal. A line written to the last column wraps by
  itself, and the newline after it then produced a blank line between every bar, so one landmark
  arrived as three.
- The colors are sampled near the **start** of the line, not at the last column. A bar is printed
  at the width the session had at the time, so a terminal widened afterwards leaves the far
  columns untouched.

The rail of markers is drawn by TabTerm rather than by xterm's overview ruler, which paints on
top of the native scrollbar. Chrome handles a scrollbar click itself and dispatches no DOM event,
so markers there could be seen and never clicked.

---

**A path shows it is clickable only while the pointer is on it.** The cursor used to change for
the whole screen the moment the modifier went down, which announced that something was clickable
without saying what, and said it over blank space too. Pointer and underline are xterm's own and
apply per link; the color is a decoration over the link's cells, which is what makes it
unmistakable which run of characters will open.

**Paths are resolved as they are printed, not when one is hovered.** xterm caches what a link
provider answered for a line and asks again only when the pointer changes line. The first hover
therefore arrived before the daemon had confirmed the path, was told there were no links, and
that answer stuck until the pointer left the line and came back. The visible rows are scanned on
render, debounced, so the answer is already in hand by the time anybody hovers.

The modifier is recorded in the **capture** phase of `mousemove`. Bubbling ran after xterm had
already asked its providers about the line under the pointer, so the first query on a line saw no
modifier and the cached answer kept the link inert.

**Right-click never follows a link.** A link is activated by a mouse event without regard to
which button produced it, so right-clicking a URL both opened it and showed the menu: asking what
the options were was the same gesture as choosing one. Activation now requires button 0.

**Right-click never changes the selection.** xterm's macOS default replaces it with the word
under the pointer, and over blank space that word is empty, so right-clicking past the end of a
line silently cleared the selection and greyed out Copy in the menu the same click had just
opened. Selecting a whole line worked and selecting text then right-clicking beside it did not,
which from the outside is simply "sometimes I cannot copy". The selection is also recorded in
the capture phase of the right-click, so the menu reports on what the user had regardless of
what the terminal does with it afterwards.

The context menu is rendered in the page rather than left to Chrome's, because Chrome's menu has
no idea a canvas contains selected text and would offer nothing useful. It carries the clipboard
entries, then the actions that belong to the pane itself: split, move to its own tab, close, and
kill the session. An entry that cannot apply is greyed rather than hidden, so the menu keeps a
stable shape and says why instead of doing nothing when clicked.

Entries act on **the pane that was right-clicked**, which is focused first. A menu whose actions
landed on whichever pane happened to be focused would be a trap.

`Select all` focuses the terminal before selecting. A selection made while the helper textarea
does not have focus is held by xterm and never painted, which is indistinguishable from the entry
doing nothing.

`Clear` performs the real clear, not `term.clear()`. Wiping only this buffer left the output in
the daemon and on disk, so it returned on the next reload, which made the entry a lie. See §7.

The menu is measured and then placed: it opens down and to the right of the pointer, and flips to
the other side when that would put it off screen. Flipping rather than clamping, because a
clamped menu sits under the cursor and covers the thing that was right-clicked.

Clipboard access uses the `clipboardRead` and `clipboardWrite` permissions. A denial is
swallowed: there is nothing useful to do about it, and failing loudly would be worse.

`Cmd+F` is claimed but does nothing yet. Chrome's own find cannot see a WebGL-rendered buffer,
so leaving the key to a find bar that would silently match nothing is worse than holding it.

Mouse reporting mode conflicts with browser selection. When an application has enabled mouse
reporting, a modifier override allows selection anyway, matching normal terminal convention.

---

## 7. Known fidelity gaps

Populated by the VT fidelity spike and updated whenever one is found.

| Gap | Impact | Status |
|---|---|---|
| Kitty graphics protocol | Tools targeting it do not render images | ❌ Not supported. Sixel and the iTerm2 inline-image protocol are available via addon |
| iTerm2 Semantic History | Not recreated as such | ⚠️ Superseded by the path detection work path detection |
| iTerm2 triggers | Not implemented | ⚠️ Out of scope for now |
| iTerm2 profiles | Not implemented | ⚠️ Replaced by workspace templates |
| _(the VT fidelity spike findings)_ | | ⏳ Pending |

---

## 8. Fonts and appearance

The terminal emulator chooses the font, not the application running inside it. Configurable:

family, size, line height, letter spacing, weight, cursor shape, cursor blink, color palette,
background, ligatures.

Locally installed fonts resolve through CSS `local()`. No special API is required. Chrome and iTerm
rasterize the same font slightly differently; pixel-identical output is not a goal and does not
matter functionally.

---

## 9. Verification

Fidelity is verified against **recorded PTY byte-stream fixtures**, never by eyeballing.

Fixture set, minimum: `vim`, `nvim`, `htop`, `less`, `tmux`, and a truecolor and attribute
torture test. Each is captured mid-run, including at least one capture point inside the alternate
screen.

The round-trip test: feed the fixture, serialize, restore into a fresh emulator, assert cell-for-cell
equality including attributes, cursor, alt-screen flag, and scroll region. See `12-testing.md`.


---

## Clearing, and what it has to mean

A session's output exists in three places: the xterm buffer in the tab, the daemon's terminal
state, and the PTY host's buffer. Clearing used to wipe the first one only, so the output was
still on the machine and came straight back on the next reload. Somebody who cleared because a
token had been echoed had cleared nothing.

**Clear now drops all three**, plus the saved pane snapshot, which is what an expired tab offers
to show you and would otherwise hand the same content back by another route.

### The undo window

Clearing is a reflex and it can destroy an hour of output, so an **Undo clear** button appears
under the command menu icon for ten seconds, or until the next command runs, whichever is first.

It restores **only this tab's copy**, which was kept in the page. The durable copies are gone the
moment clear is pressed and are never recovered, so the undo cannot resurrect something that was
cleared in order to be gone. That asymmetry is deliberate: the reason people clear is the reason
the undo must be limited.

Dismissed by a new command, because an undo offered over fresh output would put the old screen
underneath the new one.

---

## How much output is kept

One setting, in **megabytes per session**, governing every copy.

Bytes rather than lines, because a line is anywhere from one character to several thousand, so
the old `scrollback: 10000` meant 200 KB for one person and 20 MB for another. Terminals count
lines, so the setting converts using a measured average, and what is shown and stored is the byte
figure.

| | |
|---|---|
| Default | 5 MB per session |
| Range | 1 MB to 50 MB |
| Applies to | The tab's buffer, the daemon's terminal state, the PTY host's buffer, and the history on disk |

The last one matters more than it looks: the host's buffer is what survives a daemon restart, so
raising this means more of your history comes back after an update, not merely more of it being
visible now. See `adr/0017`.

---

## History on disk

The host's ring redraws a screen after the daemon restarts. It is memory, so it dies with the
host and with the machine. **History is also written to disk as it arrives**, at
`~/.local/state/tabterm/scrollback/<session>.log`, which is what survives everything else.

| | |
|---|---|
| Written | As output arrives, append only |
| Mode | `0600`, in a `0700` directory |
| Size | Bounded by the same per-session budget, compacted by rewriting through a temporary file and renaming, so a crash leaves either the old history or the new one |
| Pruned | Files untouched for thirty days |
| Removed | On clear, and when a session is deliberately ended |
| Kept | When a timeout ends a session, since nobody asked for that and a tab may still be open on it |

Ending a session takes its history with it. Leaving a terminal's output on disk after somebody
closed it is a surprise in the wrong direction.

**A timeout is not somebody closing it.** A session reaped for sitting in the background was not
ended by anyone, and its tab may still be open, so its history stays and the tab shows the last
lines of it instead of only saying where the session was. That is what the history is for.

This is the most revealing thing the product stores, since it is literally everything a terminal
printed. That is why it is owner-only, bounded, pruned, and gone the moment you clear.