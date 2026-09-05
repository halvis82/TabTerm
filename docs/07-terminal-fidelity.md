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

### The one place it was re-encoded, and what that cost

"Essentially unchanged" was not true for two years. The PTY host converted node-pty's output with
`Buffer.from(chunk, 'binary')`, and `binary` is Latin-1: it keeps the low byte of every code unit
and discards the rest.

So every character above U+00FF arrived as the wrong one, and the wrongness was specific enough to
recognise on sight:

| Written | Arrived | Because |
|---|---|---|
| `╭` U+256**D** | `m` | low byte 0x6D |
| `╮` U+256**E** | `n` | low byte 0x6E |
| `╯` U+256**F** | `o` | low byte 0x6F |
| `╰` U+257**0** | `p` | low byte 0x70 |
| `─` U+250**0** | nothing | low byte 0x00 |
| `✻` U+273**B** | `;` | low byte 0x3B |

No terminal user interface has ever drawn correctly through the host, and no accent or emoji has
ever survived it. It reads as "the renderer is broken", and it was not the renderer: xterm.js
never saw the right bytes.

**Why it went unseen is the part worth keeping.** The local backend has always encoded this
correctly, and the browser suites were using the local backend, because the host's socket path was
over the limit a unix socket has and it silently never started. One bug hid the other. The
regression test names the exact corruption so that a repeat is recognised rather than puzzled
over: `daemon/src/pty-host/unicode.test.ts`.

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

**A prompt follows it.** The landmark is printed where the cursor was, so the shell's prompt ends
up above it and the next command would be typed against a bare line. Discarding the line and
submitting an empty one is what pressing Enter at a prompt does, and it makes the shell print a
fresh prompt beneath the landmark. Only when nothing is running: those characters would otherwise
be input to whatever program is in the foreground.

### Highlights

A highlight is a background behind text somebody picked out by hand. Select, right click,
`Highlight`. One click, no dialog, in whatever color was used last, defaulting to yellow the way
a highlighter is yellow unless you go and get another one. The color sits on the right of that
menu entry as a swatch, and pressing **the swatch** is the only thing that opens anything.

It is drawn **translucent**, at 24% or 34% depending on whether the color is light or dark, with
an edge down each side. An opaque block hid the very text the highlight was pointing at, which is
the opposite of what a highlight is for. The characters underneath are painted on the renderer's
canvas and cannot be recolored from a decoration, so readability comes from letting them through
rather than from choosing a color for them. The edges are on the sides only: a full outline drew
a line between one highlighted row and the next, so a block spanning several rows looked like
several stripes.

It appears on the same rail as the landmarks, because "somewhere I marked" is one idea and
deserves one place to look.

**A highlight is a range on a line, and ranges merge.** Highlighting "sen", then "ce sent", then
"nice senten" used to leave three translucent layers piled on the overlap, each darker than the
last: the colors were stacking because the ranges were not. One rule answers three behaviors:

- Overlapping ranges become one, so a wash is a wash however many times it was painted
- Highlighting **exactly** what is already highlighted takes it off, which is the natural toggle
- Highlighting anything wider keeps what was there and extends it

`Remove highlight` appears on the menu only when the click landed on one, and removes everything
**continuous** with that point, across rows as well as along one. A block of color reads as one
thing, so it comes off as one thing, whenever its parts were made.

**A live highlight is held by an xterm marker** on its own line, which is what keeps it exactly
where it was put. The first version recomputed the position from the text on every redraw and
anchored to "which occurrence, counted from the end of the buffer", chosen because scrollback is
trimmed from the front. That was right about trimming and wrong about what a terminal does, which
is append: a shell prints its prompt again after every command, each new copy became the last
occurrence, and a highlight on one prompt reappeared on every later prompt. Text is not an
identity in a terminal.

**Only text that was printed.** A terminal line is a fixed grid, so a drag to the right edge
selects blank cells as readily as characters. The selection is clipped to the characters actually
on the line, and when nothing is left the entry is not offered at all.

**Nothing is written into the session.** A landmark can be printed output and survive on its own;
a highlight cannot, because the text it covers was printed long ago and cannot be repainted at
the source. So the durable half is remembered the way a landmark is found, by what it looks like:
the text it covers and **which occurrence of that text, counted from the start**.

From the start, not the end. The first version counted from the end because scrollback is trimmed
from the front, which is true and is the less common event. Text is appended constantly, and
counting from the end means every new copy of the same text renumbers everything before it. A
highlight whose occurrence is no longer in the buffer is dropped rather than drawn somewhere
approximate: being in the wrong place is worse than being gone, because a highlight is a claim
about where something is.

The record is kept per session in extension storage, on the same reasoning as layout templates:
this describes how a person marked up their own view, and the daemon owns sessions rather than
taste. It is bounded at 50 sessions, because nothing tells a closed tab that a session ended.

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

Below those come the actions that act on a pane, read from the same list the command palette
reads: the splits, focus mode, and every action the user wrote themselves. Reading the one list
means an action added in the Actions tab appears here without anybody remembering to add it, and
a menu built from its own copy of the list would drift out of date the first time the other one
changed. The same action being reachable from the palette, a shortcut, and this menu is the point
rather than a duplication.

A menu taller than the window scrolls. The list grew when the actions joined it, and on a short
window its last entries went off the bottom of the screen where nothing could reach them.
Position cannot fix that, because past a point no position fits.

Entries act on **the pane that was right-clicked**, which is focused first. A menu whose actions
landed on whichever pane happened to be focused would be a trap.

`Select all` focuses the terminal before selecting. A selection made while the helper textarea
does not have focus is held by xterm and never painted, which is indistinguishable from the entry
doing nothing.

`Clear` performs the real clear, not `term.clear()`. Wiping only this buffer left the output in
the daemon and on disk, so it returned on the next reload, which made the entry a lie. See §7.

It then asks the shell to redraw. Purging the buffers alone left a genuinely empty screen with no
prompt on it, which is a state no shell ever produces and which leaves the next command typed
against nothing. `Ctrl+L` is the shell's own clear-and-redraw: the prompt returns to the top,
whatever was half typed survives, and a full-screen program redraws rather than being blanked.

**A press inside the menu never dismisses it.** The menu closes on the next mousedown anywhere
else, in the capture phase. Without that exception it was unusable: pressing an entry removed the
button before the release, and a click is only dispatched when press and release land on the same
element, so no entry ever ran. It survived every test because tests clicked with
`element.click()`, which dispatches the click directly and never produces the mousedown that
caused it. Anything driven by a pointer is now tested by pressing and releasing.

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
| Kitty graphics protocol | Tools targeting it do not render images | Not supported. Sixel and the iTerm2 inline-image protocol are available via addon |
| iTerm2 Semantic History | Not recreated as such | Superseded by the path detection work path detection |
| iTerm2 triggers | Not implemented | Out of scope for now |
| iTerm2 profiles | Not implemented | Replaced by workspace templates |
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

It writes the old screen **over** the prompt rather than after it. Clearing ends with the shell
redrawing its prompt at the top, so appending put the restored screen to the right of a live
prompt, leaving one line carrying two prompts. The restored text ends with the prompt line the
shell drew before the clear, which is the same text ending at the same column, so overwriting the
line puts the cursor exactly where the shell already believes it is.

It restores the screen as escape sequences rather than as text, so the colors come back with it.
Reading the buffer as plain text was simpler and wrong: an hour of build output came back in a
uniform gray, every error that had been red and every path that had been blue flattened. Getting
back what was there is the entire point, and a gray copy of it is not what was there. The
serialization is the same one the daemon uses to hand its VT state to a restarting process, which
is the same problem stated differently.

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

## One terminal has one size, and every view is told what it is

The PTY has a single size. With more than one view attached, the applied size is the smallest
across them, per dimension, because a larger view would be drawing into columns the shell does not
know exist.

That was computed and **told to nobody**. A view went on rendering at its own size, so every
wrapped line and every absolute cursor move landed somewhere else. For a shell that is nearly
invisible. For a full-screen application it is fatal, and it is fatal permanently: an agent draws
differentially, writing only the cells it believes changed, so once its idea of the screen and the
view's have diverged, nothing brings them back. The parts that are wrong are parts it has no
reason to touch again.

That is what "the agent looks all messed up, and refreshing makes it worse" was. It was reached
without anybody asking for a mirror, because a reload had put the same session in two tabs.

So `session-size` is sent to every view attached to a session whenever the applied size changes,
and a view sets its grid to it. The pane can then be larger than the terminal inside it, which is
correct and is what every terminal multiplexer does.

A view follows that message **only when it is not the size it asked for**. A size matching its own
request is the daemon agreeing and needs no action. The distinction is load-bearing: attaching
announces one size for a whole workspace, before any pane has been measured, and following that
back resized every pane twice, which was enough to lose a template's command as it was being
typed.

### A saved screen is replayed at the width it was saved at

A serialized screen is a picture with a width. Written into a terminal of a different width, every
line wraps somewhere else. The snapshot carries its dimensions and they were ignored; the pane is
now set to them before the screen is written, and measured back afterwards, which is the same
thing that happens when a window is dragged.

### And the application is asked to draw itself again

After a screen that had something on it is restored, the size is nudged by a row and put back. A
size change is the one thing every terminal application treats as "you know nothing, draw it all
again", which is the only way to clear a divergence that has already happened. It is what tmux
does on reattach, for the same reason.

Never for a screen that came back empty. A session created a moment ago gets a snapshot too, and
nudging there is two size changes arriving exactly while a template is waiting for a prompt to
type its command into.

### And again after a tab has been away for a long time

The same nudge runs when a tab becomes visible after a minute or more out of sight. A full-screen
program draws only what it believes changed, so once its picture and the terminal's have parted
company nothing brings them back on its own: the size is already right, so no size change is
sent, so nothing repaints. A tab opened after five hours showed an agent drawn across a third of
the window with the rest blank, and reloading the page was the only way out.

A minute is what keeps this from being its own defect. Flicking between two tabs is constant and
repainting an agent every time would be worse than the fault; a tab nobody has looked at since
before the window was last resized is where a stale picture actually comes from.

## A size is only ever asked for once it has been measured

Terminals were changing size thousands of times a second: tabs visibly flickering, pages laggy
because they were laying themselves out constantly, and an agent that could not settle on a width.
Twenty-seven thousand size changes in ten seconds, across five sessions.

Four separate faults, each harmless alone and none of them visible in any single sample. What made
them findable was a detector that records the **sequence** of sizes rather than the current one.

**A measurement that failed returned a default.** `fit` returned the terminal's current size when
the element could not be measured, and a terminal that has never been fitted is 80 by 24, xterm's
default. So a pane whose element was not laid out yet reported 80 by 24 as though it had measured
it. It returns nothing now, and nothing is asked for.

**Being told a size was treated as asking for one.** Resizing a terminal makes it announce its
size, and that announcement travelled the same path as a measurement. So following the daemon's
size became a request for it, which the daemon answered, which looked like being overruled again.

**Replaying a snapshot resized the terminal**, which announced itself the same way, so a screen
serialised at 80 by 24 became an instruction to every view of that session.

**Output moved the cursor, and the cursor was read as the prompt's width.** The box under the
start screen grows to fit the line being typed, and it learns where the prompt ends from where the
cursor sits when the line is empty. While a command runs the cursor is wherever the output put it,
so the box grew and shrank on every chunk. Output is not an instruction to resize anything, and
the cursor is only read as a prompt width when the shell is at a prompt with an empty line.

An attach also handed the daemon a placeholder size, which was harmless while nobody was told the
applied size and became an instruction once they were. A client that is already attached keeps the
size it reported; an attach is not new information about it.
