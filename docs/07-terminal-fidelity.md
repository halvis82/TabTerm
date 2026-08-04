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

A daemon holding server-side VT state is not lightweight. `11-performance.md` carries the real
numbers.

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

- Drag selects, double-click selects a word or path, triple-click selects a line, shift-click extends
- `Cmd+C` copies without sending an interrupt. `Ctrl+C` still interrupts
- `Cmd+V` pastes with bracketed paste
- Right-click exposes copy, paste, open link, open path, split, and detach

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
