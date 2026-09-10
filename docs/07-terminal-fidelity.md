# 07 — Terminal Fidelity

TabTerm must behave like a modern terminal emulator. Anything less and it is a toy.

---

## 1. The byte path

**When typing is dropped, the terminal says so.** The queue for an absent host is bounded, and the
last thing it gives up is somebody's input. That is the right order to give things up in, and it is
still a loss that only the person typing can put right: the shell carries on, and the next thing
typed lands against a command line that is not what its author believes it is.

There was a record of it and no way for anybody to see it. The ids were collected, a line went into
the log, and the method that returned them had no caller in the product. So the notice is now
written into the session's own stream, the same way a failed spawn is: it reaches the screen, the
scrollback, and any tab that attaches later.


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

### And the same width table as the programs it hosts

The same emulator is not sufficient on its own. Both copies also have to agree with the programs
being hosted about how many columns a character occupies, and that is a separate decision the
emulator does not make for us.

xterm ships one built-in width table and it is Unicode 6, from 2011. Programs that draw boxes pad
each cell to a column count they work out themselves, against a current table by way of
`string-width`. Where the two disagree, the padding lands in the wrong column and the box drawing
comes apart.

That is not hypothetical. An agent's status table came out with every row holding `U+2705` a column
short, while the rows holding a warning sign stayed straight, which is the detail that identifies
the cause rather than merely fitting it. `U+2705` has emoji presentation, so a current table calls
it two columns wide and Unicode 6 calls it one. `U+26A0` is text-default, neutral width, made emoji
only by a variation selector, and both sides already counted it as one. So those rows agreed. The
same session opened in a terminal with a current table was flawless.

Measured in our own build before deciding anything:

| Character | Unicode 6 | what the programs pad for |
| --- | --- | --- |
| `U+2705` white heavy check mark | 1 | 2 |
| `U+274C` cross mark | 1 | 2 |
| `U+26A0 U+FE0F` warning sign | 1 | 1 |
| `U+4E00` CJK | 2 | 2 |

CJK was always right, so the table was never broken in general. It simply predates Unicode 9 giving
the emoji block a wide East Asian Width.

There is no current provider to install. xterm offers version 6, the `unicode11` addon adds version
11, and that is the whole menu. Version 11 fixes the characters above and is still frozen in 2018.
So the addon supplies the base table, including the zero-width behavior that is combining and
control rather than a width question, and a generated set of corrections carries it the rest of the
way. `scripts/generate-char-width.mjs` writes them by comparing the addon against
`get-east-asian-width`, which is the same data `string-width` reads, so the agreement is by
construction rather than by hand. It comes to 993 codepoints in 42 ranges, most of them Tangut
ideographs and CJK strokes, and the ones that matter here are the post-2018 emoji blocks.

Two characters go the other way. `U+1F93B` and `U+1F946` were two columns in 2018 and are one now,
so the corrections carry a width rather than a widen flag.

Width is read once per codepoint on the output path, so the cost was measured rather than assumed:
14.2 ms per five million lookups for the base table alone against 37.6 ms with the corrections
applied, which is 0.075 ms to width a full 200x50 screen. Correctness decided this and speed
did not.

#### Why the daemon needs the table even though replay would survive without it

Worth stating plainly, because the obvious reason is wrong. Serializing stores characters rather
than columns, so a screen laid out under the wrong widths is re-wrapped by whoever draws it next
and arrives looking correct. Replay is not what forces the daemon to match.

What forces it is that the daemon's buffer is a model of the same screen and the daemon reads it.
Widths decide where a line wraps, wrapping decides how many rows the content occupies, and that
decides what is still on screen once the rest has scrolled off. `hasRun` is exactly that question,
counted off a snapshot taken without scrollback, and it is how an adopted session is judged to have
run something. Twelve two-column characters in a six-column terminal leave half of them on screen
and half above it. Under a table that calls them one column, nothing has scrolled at all.

Both sides call `installCurrentWidths` from `@tabterm/shared`, before a byte is written. The width
table is not something one of them can pick up and the other not.

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

**Only at a prompt.** A landmark is right where the scrollback is a record of what has happened.
It is wrong inside anything that owns the screen: an agent, an editor, a pager, a build that
redraws. The bars land in the middle of what is being drawn and the program redraws over and
around them, which is what "it just stays stuck at the input box and looks all weird" was.

The entry stays visible and is greyed, so it says the thing exists and cannot be used here, rather
than disappearing and leaving somebody hunting for it.

Three signals decide it, because each has a gap of its own:

| Signal | Covers | Misses |
|---|---|---|
| The daemon says the pane was started with a command | `Open agent here`, templates | Typing `claude` into a shell that is already open, which is how people actually do it |
| Something is running in the pane now | Editors, pagers, builds, agents alike | Anything the shell integration did not notice starting |
| An agent has reported its own state here, or is named as what is running | An agent whose start nothing else saw | A pane where the agent has not spoken yet |

The first of those was the whole of the first attempt, and it is why this was reported twice.

An agent between turns still refuses. From the outside it looks exactly like a prompt and it is
not one: the next thing it does is redraw. A pane that has held an agent goes on refusing until
something else is put there.

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

## A right click anywhere in TabTerm is TabTerm's

Chrome's own menu knows nothing about any of this. Over a terminal drawn on a canvas it offers
Reload and Save As; on the start screen it offers to translate the page. So every right click gets
a menu of ours, and what it offers depends on where it landed, because a menu that offers the same
six things everywhere is a list to read past rather than a set of things to do.

| Where | What it offers |
|---|---|
| A terminal | Its own menu, unchanged: selection, clipboard, highlights, markers, the pane's actions |
| A saved template | Its card, pinned open, the same as the `i` on the end of the chip |
| A text box | Cut, copy, paste and select all, acting on that box |
| The start screen | Paste, then a new tab, the menu, settings, and closing the tab |
| The command menu | Settings, and a way to put it away rather than a way to open it |
| Anywhere else | The same small set, without paste, which would have nowhere to go |

Markers and highlights are deliberately absent outside a terminal: they act on a place in a screen
of output, and there is no such place on a start screen.

Anything that has already answered keeps its answer. The terminal, the pane chooser and a template
chip handle the gesture themselves, so the page-level handler runs after them and steps aside when
the event is already spoken for. A second menu over the first would be worse than Chrome's.

A chip answers with `preventDefault` rather than by stopping the event from travelling. Stopping
it would leave nothing to decline the gesture, and Chrome's own menu would open instead, which is
the one thing all of this exists to prevent.

## Light mode is a theme, not a filter over a dark one

Most of the start screen was painted with the dark theme's colors written out by hand, so light
mode was a white page covered in near-black rectangles: the miniature on a session card, the box a
path is typed into, and every folder chip were dark washes, several of them with gradients fading
off the edges. Twenty-one of those washes were the same panel color at different alphas.

They follow the theme now. The two colors that belong to the terminal rather than to the page,
`--term-bg` and `--term-fg`, come from the same table the renderer paints with, so a picture of a
terminal cannot disagree with the terminal it is a picture of.

The fades are gone. A list that dissolves into the page hides the row being read and says nothing
a scrollbar does not, and a miniature that fades at the top read as damage rather than as depth
once the page behind it was light.

Checked by measuring rather than by looking: no panel, card, box or chip is dark in light mode,
nothing is light in dark mode, every piece of text stands at least 4.5 to 1 off what is behind it,
and nothing fades the content it is showing. That found two real faults nobody had noticed: the
badge saying a session is open somewhere sat at 4.3 to 1 in light and 3.4 in dark, and a project
chip put the theme's text color on a hardcoded navy at 1.3 to 1.

### A measurement only covers what it can see

A third fault survived all of that. The selected row in the command menu carried a hand-written
dark blue wash with no light form at all, black text on it at 3.6 to 1, and the check that would
have caught it opened an empty menu: no rows, so no selected row, so nothing to measure. It
surfaced only in a full run, where suites that had gone before left history behind.

Selection is a token now, per theme, like everything else that is a color. The suite gives the
menu something to hold and picks a row before it measures, because a check of an empty list is a
check of nothing.

## A renderer the browser takes away is asked for again

A browser keeps a limited number of accelerated contexts and takes the oldest away when something
else wants one. For this product that means a person with a dozen terminal tabs open: one of them
loses its renderer to another, falls back to drawing with DOM nodes, and stays there.

Losing it used to be permanent for the life of the page. On a shell showing a prompt nobody would
notice; on a tab holding thousands of lines of an agent's output it is the difference between
scrolling at a frame each and scrolling badly. That is one tab feeling worse than the next for no
reason anybody could see, and it was reported exactly that way.

It is asked for again now, with a widening gap and only while the tab is being looked at: a hidden
tab does not need one, and asking takes it from a tab that does. For the same reason a hidden tab
gives its own back after four seconds rather than two minutes. The long delay was chosen to save
memory, and memory is not the only thing these cost.

**And it is written down.** A lost renderer is reported to the log like a resize storm is, because
it is invisible otherwise, including to the person feeling it.

### What scrolling actually is, measured

Worth stating plainly, because it was assumed wrong twice. Read out of a real session's
scrollback, an agent CLI here **never takes the alternate screen and never asks for mouse events**.
So scrolling one of its tabs is the emulator scrolling its own buffer, exactly as in any other tab:
no round trip, no input sent, nothing asked of the program.

| | |
|---|---|
| Scrolling a four thousand line coloured buffer | 16.7 ms a frame, worst 17.4 |
| Rebuilding the marker rail across that buffer | 1.1 ms |
| Wheel events turned into messages, per forty | 7 |

All of which is why the answer turned out to be the renderer rather than any of it.

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

### The clear's own aftermath is not new work

Clearing asks the shell to redraw by writing `Ctrl+L` to it, so the screen looks like one that
just ran `clear` rather than a blank with no prompt. Two things follow from that, and both of them
broke the undo.

The shell integration reports what the shell runs, so the clear announces a **command start** of
its own, and a command start takes the undo offer away: an undo over new output would put the old
screen underneath it. The offer was therefore removed by the very thing meant to make the screen
look normal. A command start within a moment and a half of our own clear, in that pane, is now
understood as the clear finishing rather than as somebody running something.

And the redraw arrives whenever it arrives. Putting the old text back before it lands means the
redraw wipes it, so the undo appears to do nothing. Pressing the offer while the shell is still
redrawing now waits for that to land and then applies.

Neither was reachable by hand: a person takes longer to reach for the button than a shell takes to
redraw. Both were found by a check that waits for the offer to appear rather than sleeping past
it, which is faster than a person and was therefore the first thing ever to lose the race.

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

### And the screen is asked for again

After a screen that had something on it is restored, and again when a tab becomes visible after a
minute or more out of sight, the page asks the daemon to send that pane's screen again. The daemon
holds the authoritative copy, so handing it over is both correct and completely invisible to the
program: no signal, no resize, nothing it can observe.

Never for a screen that came back empty. A session created a moment ago gets a snapshot too, and
there is nothing to put right.

A minute is what keeps the second case from being its own defect. Flicking between two tabs is
constant; a tab nobody has looked at since before the window was last resized is where a stale
picture actually comes from.

#### An attach applies the size it measured, and that coupling is load bearing

A page that has just loaded measures its pane before the layout has fully settled, so an attach can
announce `187x44` where the box will be `195x44` a second later, and the session is resized twice.
That is a real cost, because narrowing a terminal rewraps every wrapped line in its history and
widening rewraps them back.

**It was tried and reverted, and the reason is worth keeping.** Marking the attach size as
not-yet-settled, so a session that already had one ignored it, made every reattach far worse: the
page's own grid is that measurement, so refusing it at the daemon leaves the grid at one width and
the terminal at another. The program then writes lines wider than the grid and every row of its
output wraps. What looks like a redundant resize is the one thing keeping the grid and the terminal
the same size.

So the transient stays. It is two resizes of a size the pane really had, in lockstep with the grid,
rather than a lasting disagreement between them.

#### It used to ask the program instead, and that was destroying agents

The size was nudged down a row and put back, which is what tmux does on reattach and which every
terminal program treats as "you know nothing, draw it all again". It is safe for a shell, which
draws forwards from a prompt and never revisits what it wrote.

It is ruinous for anything that redraws in place. Measured in one Claude Code session that came out
unreadable: **21,881** cursor-up sequences, **five** erase-downs, **no** absolute cursor positioning
and **no** alternate screen. That program redraws by moving the cursor up over its own last frame
and writing on top of it. A row-shrink scrolls the buffer underneath that frame, so every redraw
afterwards lands a row out, overwrites the wrong lines, and leaves the previous frame's fragments
behind. The daemon's log for that session shows nine of these over twenty-four minutes, each one
195x44, 195x43, 195x44 inside a single second.

The check for this in `steady-size` used to assert that a woken tab **does** change the size, which
is the bug written down as a requirement. It asserts the opposite now, and fails against the old
code with `48x22 48x22 48x23 48x23`.

## A size is only ever asked for once it has been measured

Terminals were changing size thousands of times a second: tabs visibly flickering, pages laggy
because they were laying themselves out constantly, and an agent that could not settle on a width.
Twenty-seven thousand size changes in ten seconds, across five sessions.

Four separate faults, each harmless alone and none of them visible in any single sample. What made
them findable was a detector that records the **sequence** of sizes rather than the current one.

### One terminal, one size, one authority

Every flicker this product has had was two things believing they were entitled to set the same
number, so the arbitration is checked as a property rather than by example: the smallest across the
views wins per dimension, and **restating the same facts produces no second announcement**.

That last part is the one that matters. Every announcement makes a page set its grid, and a page
that sets its grid reports the size, which arrives back at the daemon. An announcement that says
nothing new is the first half of a loop with no exit.

Checked over every order the views can arrive in, because order is not something any of them
controls: two tabs attach when they attach, and a size that depends on who spoke last is a size
arrived at by a sequence rather than by the facts.

On the page there are exactly two things that set the grid without measuring it: replaying a
snapshot, and following a size the daemon applied. Both are wrapped in the flag that says "this is
not a request", because a terminal announces every resize and that announcement travels the same
path a measurement does. Everything else goes through the one door, which records what was asked
so that being agreed with can be told from being overruled.

Guarded end to end by `steady-size`, which now includes a session with two views of different
sizes: the size is expected to change once, to the smaller, and then hold. A second change would
mean the page had argued back.

### Telling a loop from somebody dragging the window

That detector reported at twelve changes in two seconds. The flicker being reported was about five
a second, so the guard sat just above the fault it was guarding against, and a return of the exact
thing complained about would have gone unrecorded.

Counting cannot fix it, because a window being dragged produces just as many changes and is not a
fault. What separates them is not how many changes there are but **how many different sizes**. A
drag moves through a new size every time and never returns to one. A loop is two or three sizes
repeating, because something is feeding its own input. So a few sizes changed many times is a loop,
and many sizes changed many times is a person with a mouse. A flood past forty in two seconds is
reported whatever the sizes, since no drag reaches that rate.

Two windows, because a loop does not have one speed. The fast one catches the several-a-second
flicker that was reported. A slow one, ten seconds wide and stricter about how many sizes it will
accept, catches an oscillation of about one a second: just as visible to the person watching, and
under any threshold a two second window can carry without firing on ordinary work. Over ten
seconds a person opens a panel, splits a pane and changes a font, and that is several sizes rather
than two.

**A size that did not change is not a change.** Several paths ask for one without knowing whether
anything moved: a terminal announcing itself, a refit after a panel opens, an attach. Counting
those measured activity rather than instability, and it showed within a day of the detector being
installed: an ordinary reattach reported a storm made of one deliberate repaint nudge and three
requests for the size the pane already had.

### A size measured before the renderer exists is offered, not applied

A grid is the room a pane has divided by the cell the **renderer** believes in, and the two
renderers do not agree on that cell. The DOM one reports the font's advance. The WebGL one reports
it snapped to whole device pixels. Read off a real machine, 7.829 against 7.5, so 1468 pixels of
room is 187 columns under the first and 195 under the second.

Attaching is exactly when the WebGL one may not be there. Every tab re-attaches at once when the
extension reloads or the daemon restarts, and they contend for a number of GPU contexts the browser
caps. The panes that lose measure against the DOM cell, get 187, and correct themselves seconds
later once a context frees up. That correction is a resize, and a resize is the one thing a program
redrawing in place cannot survive: it overwrites its last frame by counting rows upward, so wrapping
that moved underneath it puts every later frame on the wrong lines, and it has no way to notice.

From the log of a real session:

```
attach   avail 1482x805   cell 7.829   webgl false   ->  187x44
refit    avail 1482x805   cell 7.5     webgl true    ->  195x44
```

The room never changed. Only the cell did.

So a pane that cannot yet trust its measurement draws at what it measured and tells the daemon
nothing. The attach carries the size marked `estimated`, which the daemon already knows to ignore
for a session that has one of its own, and refits are held back entirely. The pane asks again the
moment the renderer arrives, and by then the two normally agree, so nothing is resized at all.

Ten seconds of grace, after which an untrusted measurement is trusted anyway. A pane that never
gets a context must still be able to follow the window, and while it waits the daemon's size is the
right answer rather than a compromise.

#### What this is not

Two earlier attempts fixed the wrong thing, and both reached this machine before being caught.

The first held a pane's size whenever its box had not changed. That is right for the fault and
wrong in general, because it makes an early bad measurement permanent: a pane measured while it was
still the strip under a start screen stayed three rows high afterwards.

The second aimed at renderer swaps on tab switching. Measured on the machine that has the fault,
switching tabs produces no resize at all: sixteen consecutive measurements, every one of them
`want 195x44, have 195x44, cell 7.5, webgl true`. The theory was wrong and the fix made things
worse, doubling the resizes per visit.

Both were reasoned from the mechanism rather than read from the machine. The full browser suite
passed on both, and cannot see any of this: headless Chrome's font advance is already device-pixel
aligned, so its two renderers agree and the gap never opens. What the suite is for here is
collateral damage, which is real and is how the three-row pane was found.

### A size nobody measured is not allowed to move a terminal

Reading that record for a day found the next fault, and it was on every tab open. The sequence per
tab was five changes:

```
attach 212x47   resize-pane 195x44   resize-pane 195x43   resize-pane 195x44   resize-pane 195x3
```

The first of those is a guess. A page that has just loaded has no pane with a box to measure, so
it works a size out from the window, and that answer is systematically too big: it knows nothing
about the launcher, the border or the scrollbar. It was 212 by 47 where the truth was 195 by 44,
and it was reaching the PTY. For a shell that is nothing. For a full-screen program it is a
complete redraw at the wrong width followed by another at the right one, every single time a tab
is opened.

An attach now says whether its size is a measurement or a guess, and a guess does not move a
terminal that already has a size. The measurement follows within about a tenth of a second and is
believed then. The rule that already covered a returning client covers this too, and for the same
reason: **an attach is not new information about how big anything is.**

Only when the session already has a size. A session being created has nothing better to go on and
nothing on screen to spoil.

Three places sent a size nobody had measured:

- **A page-load reattach**, above. The largest, because it happens on every tab open.
- **Pulling a terminal in from another tab**, which happens in the daemon where nothing knows how
  big the panes are, and passed a literal `80, 24`. That is the `80x24` that appeared in the middle
  of the original flicker sequence.
- **Resuming an agent from the recovery page**, which passed a literal `80, 24` while every other
  way of starting something measured first. The one path where the thing being started is
  guaranteed to be a full-screen program.

### A restart rebuilds each screen at the size it was really running at

The daemon rebuilds an adopted session's screen by replaying the host's output into a fresh
emulator, and an emulator of the wrong width wraps every line in the wrong place. Adoption passed
`80, 24` for every session, so every restart rebuilt every screen at eighty columns while the
terminals themselves carried on at whatever they were. A reattaching tab was handed a folded-up
copy of its own screen, and a full-screen program had to be resized before it looked right.

The host has held the true size all along and reports it in the same list adoption already reads.
It was being discarded one call before it was needed.

### A wrapped row continues a line rather than starting one

Whether a tab has begun is answered from its screen when nothing better is known, by counting the
lines with something on them. A wrapped row was counted separately, so one long line looked like
two, and the line most likely to be long is the prompt: a shell in a narrow pane wraps
`(base) name@machine ~ %` onto a second row.

The consequence was a start screen that refreshed into a bare terminal. It appeared only when the
window was small enough to wrap, which is why it looked like something else every time it turned
up.

### A tab shows what it is, and never the other thing first

Both directions were reported. A tab with work in it flashed the start screen, which was fixed by
holding the start screen back until the tab knew what it was. A tab that **is** the start screen
then paid that same wait in the other direction: it showed its terminal for most of a second and
was then covered over.

So a tab that has not worked out what it is shows **neither**, and works it out when its screen
arrives rather than when a timer says so. The panes are hidden with `visibility` rather than
removed, because a pane with no box cannot be measured and a size nobody measured is the other
thing that goes wrong on a tab that has just opened. The timer stays as a ceiling, since a
snapshot that never arrives must not leave a tab showing nothing.

The decision is made in the callback that fires once the emulator has **parsed** the restored
screen, not on the line after handing it over. Asking a moment too early reads an empty terminal
and answers "nothing here" whatever the snapshot held, which put the start screen over restored
work.

### The start screen draws itself only when something asks it to

A tab reopened on a session it already had showed the start screen about a sixth of a second in
and swapped to its terminal when the snapshot arrived. The page had a guard for exactly this and
the guard never got the chance: the launcher unhid itself whenever it was handed data, and the
daemon hands a tab its launcher state as soon as it connects.

Rendering and being on screen are separate now. Drawing fills the element; only `show` makes it
visible, and only the one place that decides a tab is empty calls it. Checked by sampling what is
on screen from the first moment the page can run anything, because by the time it has settled the
answer is right and the fault is invisible.

### The start screen is never drawn over a pane that something was launched into

Drawing it squeezes the terminal into a three row strip, and a full-screen program redraws itself
into three rows. Whether a tab has launched anything is remembered in that tab's own
`sessionStorage`, which is the usual answer and survives a reload.

It does not survive the tab being **recreated**, which is what an extension reload does to every
tab. After one of those the only evidence left was the screen, and the screen is a guess that is
wrong in exactly the case that hurts most: a program that has printed nothing yet, or one showing
a compact prompt, has as few lines on it as a shell nobody has used.

So the daemon says so instead. It started the process, so it knows, and each pane now arrives with
whether its session was started with a command rather than as a bare shell. Measured against the
old behavior, a recreated tab on a pane running something that prints nothing went from
**44 rows to 3**.

### The record of what the terminal actually resized to

`session.resize.applied` is written at **info**, not debug, and carries every claim at the moment
one is applied. It was at debug, which meant no ordinary daemon wrote it: answering "are terminals
holding still" needed a special build, and in the meantime the absence of the lines was read as
the absence of the fault.

It is affordable because a size that did not change returns before the line is written. Every one
of them is a real change to the size a terminal is running at. A machine holding still writes none
for hours; a machine that is not writes a great many, which is exactly what wants recording.

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
