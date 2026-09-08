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
| `chrome.runtime` | yes | yes | yes |
| `chrome.storage` | **undefined** | yes | yes |
| `chrome.runtime.sendNativeMessage` | **undefined** | yes | yes |
| `chrome.notifications` | **undefined** | yes | yes |
| `chrome.tabs` / `chrome.tabGroups` | **undefined** | yes | yes |
| `chrome.windows` | **undefined** | yes | yes |
| `WebSocket` | yes | yes | yes |

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

**Global scope is partly ours and mostly Chrome's.** `_execute_action` can never be global, which
is the whole reason a plain `new-terminal` command exists beside it: the same action, behind a
command that can be. The two non-action commands declare `"global": true`, which sets the default
scope. Beyond that it is Chrome's decision, and the scope control in
`chrome://extensions/shortcuts` is disabled whenever no key is bound, which accounts for most
reports that a command "cannot" be global.

New tabs open at `currentIndex + 1` and inherit the current tab's group when one exists.

**A command also brings Chrome's window to the front.** `active: true` on a tab selects it within
its window and does nothing to the window itself, which is invisible while Chrome is the focused
application and wrong the moment it is not. A shortcut set to global fires from another app
entirely, so the terminal opened behind whatever the person was looking at and had to be gone and
found. The paths that focus an existing tab always did this; the two that create one did not,
which is why it only ever showed up on the shortcuts. Raising the window is best effort: the
window can be gone by the time it runs, and failing to raise one is not a reason to fail the thing
that opened it.

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

### Reloading the extension does not end anything, and does not duplicate anything

Three separate events can mean "the extension has just started": `onStartup`, `onInstalled`, and
the marker in `chrome.storage.session` that survives the worker dying but not the extension being
reloaded. Which of them fires, and how many, is Chrome's decision.

Two of them arriving put back **two of every tab**. Each read the same empty list of open tabs,
and each created one per remembered workspace, so a session ended up showing in a pair of tabs,
which is the one thing this product promises never to do.

The reopen happens once, whoever asks. A shared promise rather than a flag, so a second caller
waits for the first instead of returning early into a world where the tabs do not exist yet and
then reporting that no tabs are open. And each tab is looked for again immediately before it is
created, because the list was read before any of them existed.

### Reloading the extension does not end anything

Chrome destroys every page an extension owns when it is reloaded, so the terminal tabs vanish.
The terminals themselves are in the PTY host and are untouched, and the tabs are put back from
the remembered set.

The half that was missing is that **the workspaces are claimed as open before a single tab is
created**. In the gap between Chrome destroying the tabs and the worker putting them back, the
truthful answer to "which workspaces are on screen" is none, and saying so starts the clock on
every untouched pane in them. That is not hypothetical: it took five terminals on 2026-09-04.

The claim is given up as soon as the tabs it stood in for exist, and after two minutes for any
that could not be recreated. Holding it indefinitely would keep alive workspaces somebody then
closed on purpose, which is the same mistake in the other direction.

The report itself is now acknowledged rather than fired into the dark. It travels worker →
offscreen document → daemon, and the offscreen document exists before it is connected, so a
report arriving in that window was dropped by a `?.` and looked delivered because nothing threw.
The next attempt was two minutes later, against a rule that ends a terminal in thirty seconds: a
retry slower than the thing it protects against is not a retry.

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

### The panel asks the daemon again whenever it reconnects

Every setting the command menu shows is answered once, when launcher state arrives, and then
kept. That is right while one daemon runs and wrong the moment a different one does: a daemon that
restarts and comes back holding a value read from disk leaves the panel showing the value from
before it, with nothing on screen to say the two disagree.

That is worth more than it sounds. A person who has just been told, by the picker, that their
choice did not stick has no reason to believe the picker about anything else either. The questions
are asked again whenever the connection becomes ready, which is what a restart looks like from the
page's side.

The daemon also logs what it read from disk at startup and what it decided to run with, which are
not always the same: a stored value below the shortest the panel offers is ignored in favour of
the default. Until that line existed, a report about this setting could be answered only from the
file and a guess.

### Whatever will receive the next keystroke shows a cursor

An invariant, not a list of places. It was reported three times about three different moments,
each fixed where it was found: after a refresh, after placing a marker, after undoing a closed
pane. Every time, typing worked and the screen said it would not.

Routing a keystroke to the terminal when it arrives is not enough. By then the person has already
typed into something that looked dead, which is the whole complaint. The terminal has to hold the
keyboard **before** anything is typed.

What owns it, in order:

1. A real text field somebody put the cursor in. It draws its own caret and nothing takes it
2. The command menu or the palette while either is open. Both manage their own focus
3. Otherwise the focused pane's terminal, which is where typing goes anyway

The hole underneath all three reports is the same: **an element that had focus and is then
removed from the document takes the focus with it.** `activeElement` becomes the body, no `blur`
is reliably delivered, and the page is left in a state where typing works and nothing says so.
Redrawing the start screen does that. So does putting a pane back. Removing the check that
restores it puts the keyboard on `body` at four separate moments in one short session.

Two ways of noticing, because neither is enough alone. A `focusout` with nothing gaining focus
covers what the browser reports; a half-second timer covers what it does not, and costs one
property read.

### Undo puts a pane back where it was

Closing a pane collapses the split that held it: the parent is replaced by the surviving sibling,
and every fact about where the closed one was goes with it. Undo had nothing to work from and
placed the pane beside whichever one happened to be focused, which is usually somewhere else.

The position is recorded before the pane is closed, described by its **sibling** rather than by a
path from the root: a path is only valid against the tree it was taken from, and the tree changes
while the offer is up. A sibling is a set of pane ids, and a pane id still means the same pane
after anything else has moved.

The set matters. A sibling can be a whole subtree, and naming one pane inside it is not enough to
find that subtree again: "the node whose first pane is this one" matches the root as readily as
the subtree, and restoring then wrapped the entire layout instead of half of it, which is the
right panes in the wrong shape. The smallest node holding every surviving sibling is the sibling,
however the rest has moved.

Half the sibling can have been closed too while the offer was up. The pane goes back beside what
survives, which is the nearest thing to where it was. Only when none of it survives does undo fall
back to placing it the ordinary way.

### A bar on each pane, only when there is more than one

A tab holding several terminals gives each one a thin strip across the top: what that pane is, a
button that opens the pane's own menu, and a cross that closes it. Twenty-two pixels, which is two
rows of its text, and it is furniture rather than a toolbar.

**Only when a tab holds more than one pane.** With a single terminal the tab's own title already
says what the bar would, and a strip across the top would take rows from the terminal to repeat
something.

**The dots open the pane's own menu, not a smaller one built for the bar.** Everything that can be
done to a pane is in that menu already, and a bar carrying its own three entries would be a second
list to keep in step with a list that is already right. It opens below the button and back into
the pane, since the button sits at the right of a bar that can be half a narrow window wide.

**What the bar says**, in order: the name somebody gave the session, because a name is chosen and
everything else is inferred; otherwise the folder, and the process when one is running that is not
the shell. A pane sitting at a prompt is not news, and four panes all saying "zsh" is four labels
that distinguish nothing from each other.

**The focused pane's bar is lit**, in the same color rather than a new one. The border already
says which pane has the keyboard; this says it again at the top, where the name is.

The tab's command button moves below the bars in a split tab. It lives in the same corner as the
rightmost pane's cross, and at the same line it sat directly on top of it.

### Outcomes wait to be seen

`success`, `failed`, `done` and `waiting` persist **until the tab is actually looked at**, and are
cleared by the look rather than by a timer. This is the whole point of the indicator. A command
that finished while you were in another tab is exactly the thing you left to find out, and a state
that expires on a timer expires while nobody is there to read it.

`waiting` is on that list because looking is the answer to it. An agent raises its notification
about a minute after it finishes a turn, so the real order of events is finish, then wait, and
nothing after that ever clears it: the next thing that happens is a person coming back to the tab,
and coming back is not something an agent has a hook for. The tab went amber a minute after every
single turn and stayed amber, which is how an amber tab came to mean nothing at all.

Conditions do not work this way. `running` describes the present and speaks for itself, and
`approval` clears when the approval is answered rather than when it is noticed. Looking at a tab
is the answer to "waiting for you". It is not the answer to "may I run this".

### A tab decides what to show only once there is something to decide about

A reattaching tab waits for its snapshot before choosing between the start screen and the
terminal, with a timer as the ceiling so a snapshot that never arrives cannot leave the tab
showing nothing. On a loaded machine that ceiling fired before any pane existed, and the tab then
answered the question on no evidence: a tab with no panes fell through the same door as a tab with
two, which answers "in use", so the start screen was dismissed and an empty terminal took the
whole page.

Two corrections. No panes at all is nothing here, not "cannot tell": two panes is work, zero is an
empty tab. And the ceiling now waits for a pane to exist before it decides, up to a few seconds.
Nothing is on screen either way while it waits, so waiting costs nothing and deciding early costs
the answer.

With one exception, which the first version of this got wrong: **a tab opened on a workspace has
work by definition.** The panes are on their way and the only reason there are none yet is that
the daemon has not answered. Reading that as an empty tab put the start screen over a session
somebody was coming back to, which is the one thing a reattaching tab must never do.

### The URL decides before the tab's own record of having launched does

A tab remembers in `sessionStorage` that it has left the start screen, and that memory used to be
asked first, in three places. It has to be asked somewhere: a tab reloading into work must not
have the start screen appear over it a second later, which is what happens if the element is
merely left undrawn, because the start screen renders whenever the daemon sends it something to
list.

But a tab is given a workspace the moment it creates its first session, and the URL is rewritten
to say so. So the address the start screen itself had is the one with **no** workspace on it, and
pressing Back after opening a session returns to exactly that address. The flag answered first,
the start screen was dismissed from the first frame, a bare shell in home was made in its place,
and the tab sat on the start screen's own URL with no way back to it.

So the URL is asked first: **a tab with no workspace in its URL is a new tab, and a new tab shows
the start screen.** The flag loses nothing by going second, because everything it protects is a
tab with work in it, and a tab with work in it has a workspace in its URL.

A tab that does have a workspace in its URL is not decided at startup at all. It is left undrawn
until its screen arrives, and then answered on what is actually in it. Deciding earlier meant
deciding on the flag alone and permanently, and that is the case that was reported twice: a start
screen creates a shell the moment it opens and is given a workspace for it, so the URL it has by
the time anything is clicked already names one, and pressing Back after opening a session from
Running Now returns to **that** address rather than to a bare one. Nothing flashes in the meantime,
because the panel is created hidden and only `show()` reveals it; rendering fills it in without
unhiding it.

Such a tab keeps its terminal unless the single pane in it is genuinely untouched: not started
with a command, never typed into, and sitting in the home directory. **All three facts come from
the daemon**, and the third is the one that says why. The page has the session's directory and the
location of home only after the decision that needs them has been made, so comparing them in the
page compared two empty strings, which is not a conservative answer but a wrong one, and it made
the rule unreachable. The first two are not on the screen at all: a half-typed command sits on the
prompt line, so the tab still has exactly one line of content and looks identical to a prompt
nobody has touched, and nothing was run so the output says nothing either. The daemon sees every
keystroke and remembers, which makes the answer survive a reload and a tab being recreated.

### A redraw restores the box before it restores what is under it

The start screen follows what the rest of TabTerm is doing, so it redraws whenever a session
starts anywhere, and a redraw builds a new path box and a new line to go under it. The answer
about the folder is kept and drawn back in. It was drawn back in **before** the box got its text,
and the line compares the answer against what is typed, so an empty box matched no answer, the
line drew nothing, and it stayed blank until the next keystroke. Correct code in the wrong order,
and it reads fine in both places.

The order is now: put the text back, then draw the line under it.

### A question in flight when the socket drops is asked again

The line under the path box is a round trip: the box changes, the daemon is asked, and the line is
drawn when the answer arrives. It was asked once and then waited on forever, so a socket that
dropped took the answer with it and the line stayed blank permanently, taking with it the offer to
create a folder that is not there. Nothing about the box changes when a connection blips, so
nothing else was ever going to ask again.

The start screen is told when the connection is ready and re-asks anything nobody answered. The
folder listing needs no such thing: typing asks again, and typing is what produces it.

### A tab that attaches keeps what the agent was doing

Agent state is pushed when it changes and never polled, so a page that reloads or reconnects has
no way to ask. Attaching used to set every pane back to idle, which meant a tab that blinked its
connection while an agent was waiting for somebody came back saying nothing was happening, and
the event that would have corrected it is the one that never arrives: the agent is waiting, and
what it does next is wait some more.

The daemon replays the current state of every session in a workspace right after `workspace-
attached`, and the page leaves alone any pane it already had a state for.

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

## 6.5 What a new tab shows

A tab opened with no session shows what already exists, before anything else.

Every running session appears as a card with **the last lines of its actual screen**, because a
path does not identify a terminal: four shells in the same repository are identical by directory,
and the one you want is the one that printed the thing you remember. The preview is text taken
from the daemon's terminal state, with escape sequences removed, rather than an image. It stays
readable at any zoom and can never be a stale picture of a terminal that has moved on.

| State | Shown as |
|---|---|
| A tab is showing it | Blue dot, "open in a tab" |
| Alive with no tab | Grey dot, "no tab" |
| Running a command | Green pulsing dot, and the command |

The second row is the one this exists for. A session nobody is looking at is invisible everywhere
else in the product, and since a session now survives a daemon restart, sessions accumulate until
somebody can see and end them. Each card ends its session from a control that only appears on
hover, because ending one is not something to invite.

**Clicking a session that a tab is already showing focuses that tab.** It does not attach a
second view, and it deliberately leaves the tab you clicked from alone: dismissing its start
screen would reveal its own empty terminal at the moment focus moves away, which looks exactly
like the click opened a duplicate.

The folder box completes with Tab, the way a shell does. The daemon reads the filesystem, since a
page cannot, and offers directories only, because a file is not something this box can open. One
match completes with a trailing slash so the next Tab goes deeper; several show the alternatives
until Tab can decide.

Sessions are also reachable from a right click on the toolbar icon, alongside settings, which
opens a terminal tab with the panel already on that pane rather than a separate settings page.
Every setting there is about how a terminal behaves and is worth changing while looking at one.

That menu is registered from a list rather than written out as a run of calls. `chrome.contextMenus`
has no `getAll` in a manifest v3 worker, so a menu built by eight creates in a row can only be
checked by opening it and looking, and two entries once went missing while a check said nothing
about them. The list is a value, and its order, its titles and its contexts are asserted like any
other value.

Opening a terminal is the first of its entries, so the menu is never a dead end: everything else
on it configures or ends things. Launching an agent comes next, because it is a thing you do
rather than a thing you configure, and it opens its own tab, which is why it makes sense from a
window with no terminal in it. The entries that need a page, sending a selection and cloning a
repository, stay off the icon: offering them there would be offering them everywhere, including
where they cannot mean anything. Chrome puts its own name above all of it, and nothing can go
higher.

---

### A start screen shows what is true now, not what was true when it opened

Something done in one tab reaches the others: a session started, a folder opened, an agent
resumed. The daemon says only that **the answer changed**, with no payload, and the pages that are
actually showing the start screen ask for what they need. Everyone else ignores it, which costs
one comparison.

Sending the new state to every page instead would mean building all of it every time anything
happens, most of it for pages showing a terminal that will never draw it.

Two rules keep it from becoming a loop or a nuisance:

**Only a real change counts.** Recording a folder that is already at the top of the list is the
ordinary case, since every tab that opens reports the directory of every session it can see.
Treating that as news made every start screen ask for the list again, which recorded the
directories again: two hundred and twenty frames in four seconds on a tab nobody was touching.
`recordDir` says whether the folder was new, and only a new one is announced.

**An open command menu is left alone.** Launcher state carries the saved items, so refreshing it
also redraws that menu, and a control redrawn while it is being used stops being the one that was
clicked: a shortcut being recorded lost the button it was recording into. The folder list is
refreshed when the menu closes.

The nudge fires when a command **finishes**, not when it starts, because the running list asks
what is on the screen and a command that has just been typed has not printed anything yet.

---

### A tab that was never used does not survive being left

Choosing a running session, or resuming an agent, from a tab still showing its start screen acts
**on that tab**. Resuming takes it over; opening a session that already lives in another tab
brings that tab forward and closes this one.

The tab used to be left alone, reasoning that dismissing its start screen would reveal its own
empty terminal at the moment focus moved away, which reads as a second copy of the session.
Closing it answers that better than leaving it: there is no tab left to be confused by, and an
empty tab beside the one you asked for is waste. Only ever a tab with one pane and nothing on
it, because closing a tab somebody has worked in is far worse than leaving an empty one.

### A way back from both ways of losing a pane

Closing a pane and moving one to its own tab are both easy to do by accident and were both final.
Each now leaves an offer under the menu button, in the same place and the same shape as the undo
for a clear, because it is the same promise: for the next five minutes that terminal is still
there and one gesture brings it back.

`Command+Z` takes the most recent one. A clear wins when both are on offer, because its window is
ten seconds against five minutes and it happened in the pane being looked at. Outside both windows
the key is not ours and goes to the shell, where it means nothing.

The cross **hides the button without giving up the way back**: the key keeps working for the rest
of the five minutes. Hiding a reminder is not the same as saying no.

The stack is as deep as the tab is wide, so closing every pane in a four pane tab can be undone
four times and no further, since there is nothing beyond the panes that existed. The same terminal
offered twice replaces its earlier entry rather than appearing twice.

A closed pane comes back through `reopen-pane`, which the daemon refuses if the session has ended
or has since been opened in another tab. A detached one comes back as an ordinary merge, which
also closes the tab it had moved to. Both are checked at the moment they are taken rather than
when they are offered, because five minutes is long enough for the answer to change.

### A detached pane opens next to the tab it left

At the end of the strip it reads as an unrelated tab that happened to appear. Beside its source
it reads as the thing that just moved, which is what happened. Chrome appends unless it is given
an index.

The pane that stays **grows into the space**. A pane's wrapper element is reused across renders
so its terminal survives, and it was keeping the width it had been given as one half of a split:
the tree collapsed correctly and the surviving pane still drew itself at half width with empty
space beside it, which read as the layout not updating at all. Filling is now the default and a
fixed share is set only for the first child of a split, which is the right way round.

### Two terminals in one tab are two rows

`Running now` lists sessions, not tabs, so a split tab appears twice. That is deliberate: they
are separate shells with their own directories and their own work, and collapsing them into one
row would hide one of them. Both rows carry the same workspace, so pressing either brings that
tab forward.

### What a card calls a session

A name somebody typed wins outright. Naming a pane puts the name on the layout node, and that is
the only line on the card the person wrote themselves, so it says what the terminal is for in a
way nothing derived from its output can. Without a name the order is: the running command, then a
program that is not a shell, then the last command run there, then "shell" for a session that has
genuinely never run anything.

The directory above it is shortened from the **left**, by whole segments, because the end of a
path is the part that distinguishes it: a screen of cards under one project otherwise reads
`~/Documents/personal_cod…` on every line, which is a column of identical text where the whole
point is telling them apart. The full path is on hover.

Not done in CSS, though it was tried there. `direction: rtl` clips on the left, but a path is a
run of bidi-neutral characters, so `~/Downloads/test6` was reordered and drawn as
`Downloads/test6/~`. `unicode-bidi: plaintext` stops the reordering by taking the paragraph
direction from the first strong character, which puts the clip back on the right: the two cannot
both be had that way. Dropping segments in script also never cuts a directory name in half.

### One color picker, everywhere

Three parts, in the same order and the same shape wherever it appears:

    [        the color as it stands        ]
    [              the map                 ]
    []  []  []  []  []

The bar on top follows the pointer across the map, so a color can be judged at a size worth
judging rather than as a dot under the cursor. Under the map are the last five colors used **for
that particular job**, filling left to right, with the empty slots drawn rather than left out so
the row is the same shape from the first use and a color picked by position stays where it was.
Nothing is marked as selected: the bar already says what is chosen.

Choosing is one click, with nothing to confirm. A color is not a decision worth asking twice
about, and putting it back is one more click.

The name and the marker show the picker **permanently**, beside their text box, because those
forms are "type a word and pick a color" and both halves belong on screen at once. The highlight
menu shows it only when its swatch is pressed, because highlighting is one click and the color is
the exception.

It replaced three fixed palettes of six tints each. Six was enough to tell panes apart and was
never enough for anything anybody meant by "that one, but darker".

Under the map are the **last five colors, kept separately per use** and across restarts, because
the colors are for different jobs: a tint chosen to keep a session title readable at low opacity
is not one anybody wants offered as a highlight, and a landmark color is neither. One shared list
would make all three worse. The common case stays one click on a color already known to work.

### The folder box says whether the folder is there

Checked as it is typed, debounced, and answered against the exact text that was asked about so a
reply to a keystroke that has since been replaced is discarded rather than shown against
something else. A path that is not there offers `Create folder`, and the offer goes once it is.

**Return runs the selected layout, and only that.** Two handlers on the same box both acted on
Return, so `Open` sent its `cd` twice. `stopPropagation` does not prevent that: it stops an event
reaching an ancestor and says nothing about a second listener on the same element.

The path is quoted **only when it needs quoting**. The line goes into the scrollback and is read
later, and `cd ~/'Documents/thing'` for a folder with no space in it is a line nobody would have
typed. What counts as needing it is decided by a list of characters that pass through untouched
rather than a list of dangerous ones, so a character nobody thought of ends up quoted, which is
harmless, instead of unquoted, which is not.

### What comes first

The folder box leads, and what is already running follows it. Running sessions used to come
first, on the argument that a session with no tab is invisible everywhere else. That held until
those cards grew previews: with a handful of sessions the layout buttons were pushed below the
fold, so the primary control on the page could not be reached without scrolling for it.

---

## 6.6 What an empty pane shows

Splitting a tab produced two empty shells in the home directory, and the first thing anybody does
with one is go somewhere. So a pane with nothing in it draws a chooser over itself offering the
two things worth doing: open a folder, with the same Tab completion the start screen has, or bring
a session that already exists here.

Bringing a session here **takes the pane over**. It used to split the pane, which left the
untouched shell sitting beside the session that was asked for and took the chooser away with it,
so the arrangement gained a pane nobody wanted and the way to fix it was gone. The pane keeps its
id, so the split ratios around it are untouched, and the shell it displaced is ended.

It sits at the **bottom** of the pane. A terminal fills from the top, so a panel anchored there
would cover the line being typed, which is the one place it must never be. It is over the pane
rather than replacing it, on the same principle as the start screen: the shell underneath is
already running and already has the keyboard, so typing goes straight to it and the chooser goes
away when a command is actually sent.

Every folder in the directory is listed, in a region that scrolls, with the heading and the
buttons outside it so `Open here` cannot be scrolled out of reach. It used to show the first
eight, which is a browser that cannot reach most folders: a directory of projects routinely has
more, and the one being looked for was usually not among the ones shown.

There is deliberately **no path box**. Sitting at a prompt, typing a path is what `cd` is for, and
a box for it would be a worse version of the terminal underneath. A picker and a list of running
sessions are the parts typing cannot replace. Only a workspace with more than one
pane gets them, since a single pane already has the start screen over it.

**Only a pane that has printed nothing but a prompt.** Every pane in a multi-pane tab used to get
one, so a session merged into a pane arrived with a panel over its output offering to replace
what had just been put there.

The panel is bounded by the pane it sits in and scrolls inside it, rather than running past the
bottom of a short one where its rows cannot be clicked at all. The list is short, so its order
matters: a session currently open in a tab comes first, because a short list that omits the one
you meant is worse than no list.

### Naming a session

A session can be given a name from its pane's menu. The name belongs to the terminal, not to the box it is drawn in, which is why the entry
reads `Name session`. Six distinguishable tints is what telling panes apart actually needs, and a free color
wheel mostly produces labels nobody can read against the terminal background.

The name lives **on the layout**, so it survives a reload and a daemon restart the way the split
it belongs to does. It is drawn large and faint, the way iTerm does it: big enough to read at a glance, translucent
enough that the terminal reads straight through it, in the top corner clear of the command
button, and sized against the pane rather than the window so it stays legible in a narrow one and
wraps instead of being cut off. Spaces are kept exactly as typed: HTML collapses a run of them
into one, so a name with five spaces in it was drawn with one and did not match the box it came
from.

**It is drawn as it is typed.** A name is a piece of visual design, and none of how big it looks,
whether the color survives being drawn at low opacity, or whether it wraps can be judged from a
text box. Only in the tab doing the typing: nothing is sent until Save, so an abandoned form
leaves no trace and Escape genuinely cancels. The form itself sits at the **bottom** of the pane,
which is what stops it covering the name it is naming.

Both the name and the color are cleaned where they enter storage. Control characters become
spaces, since a label is drawn on one line and a newline is not a label, and a color that is not
`#rrggbb` is dropped rather than guessed at.

### A session is never open in two tabs

Bringing a session into a pane **moves** it. A session lives in exactly one workspace, so the tab
it came from is left with nothing, and that is said before it happens rather than discovered
afterwards: a session a tab is currently showing is marked, and choosing it asks first.

That tab is then told the workspace was **taken over**, which is distinct from expiry. Nothing
ended, so offering to restore it would be untrue, and it closes instead.

This does not conflict with ADR-0011, which says a duplicated tab mirrors its session. That is
about Chrome's own duplicate, which cannot be refused because Chrome does not ask. This rule is
about the sessions TabTerm itself offers to open, where it can and does.

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
| A pane's process failed | Important | Not ended by TabTerm, and the policy is on |

**The threshold is enforced in the daemon**, not in the page. The duration is authoritative there,
and a discarded tab has nothing left to make the decision with. Default 60 seconds, clamped to
between 5 seconds and 10 minutes so a stored value cannot make it notify about `ls` or about
nothing. Set from the settings pane, persisted, and read back from the daemon rather than assumed.

A failure passes the same threshold as a success. A command that fails instantly is a typo, and
being told about typos is how people turn notifications off.

**A session TabTerm ended itself is not a failure.** A shell sent a hangup exits non-zero, which
is indistinguishable from a failed command if the exit code is all you have. It was all the exit
handler had, so every session the background reaper cleaned up was announced as the user's process
failing: twelve of them on a real machine in one day, about work the user had not started and was
not involved in. `terminate` records its cause on the session before it signals anything, and a
non-zero exit is reported only when nothing caused it.

That decision is `isAFailureWorthSaying`, kept out of the exit handler and tested, because inline
and untested is how it came to be wrong. It also honors the notification policy, which it used to
ignore: a notification that arrives after you have switched notifications off is how a setting
stops being believed.

**An agent turn is the event a command boundary cannot see.** The shell command is the agent CLI
itself and it runs for an hour, so `command-end` fires when it is quit rather than when it finished
thinking. Turns are bounded by the hooks that report their ends, which is why
`09-agent-integration.md` treats hook installation as part of the product rather than as a
footnote in the installer.

### The extension reports, the daemon decides

Worth stating plainly because the division is easy to get backwards. The service worker sends two
facts about tabs and nothing else: `tabs-open`, the workspaces that currently have a tab, and
`tab-closed`, naming a tab a person closed. It holds no timer that ends anything and has no
opinion about what should be kept.

Every clock, every policy and every signal lives in the daemon, which is what makes a terminal's
life independent of the browser: Chrome can be quit, crash, or be replaced, and the only effect is
that its observations stop arriving. Absent observations are `unknown`, and `unknown` keeps
everything. See `04-session-lifecycle.md`.

### Every one is logged

`notify.sent`, with priority, title and body. One line per interruption, which is by definition
rare. Nothing recorded what had actually been raised, so a report of an unwanted notification
could only be answered by reading the code and guessing which of the seven it was, and that guess
was wrong once. A log turns the next report into a lookup.

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
    "_execute_action":   { "suggested_key": { "mac": "Command+Shift+Period" } },
    "new-terminal":      {},
    "open-command-menu": {},
    "split-right":       {},
    "split-down":        {},
    "launch-agent":      {}
  }
}
```

Every permission is justified line by line in `05-security.md` §8. No `<all_urls>`. No broad content
scripts.

`Command+Alt` combinations are rejected by Chrome on macOS, and only **four** commands may carry a
suggested key. One is used, and the rest are declared without one so that they are there to bind.

There used to be three commands and all three opened a terminal, which spent the whole budget of
rebindable keys on a single action. The others are things somebody might genuinely want a key
for, and a command declared with no suggested key still appears in
`chrome://extensions/shortcuts` waiting for one.

### Why a command rather than a key the page listens for

Everything except `new-terminal` acts on a terminal, and a command fires in the **service worker**
rather than in a page, so the worker forwards it to the terminal in front and only to a terminal.
Sending a split to whatever page happens to be in front would be a message to somebody else's tab
about something it knows nothing about.

It is worth the relay because it is the only way an in-page action can have a key a person is
allowed to **change**: `chrome://extensions/shortcuts` is the one place Chrome permits rebinding,
and a key the page listens for itself can never appear there.

Everything else the page handles is rebindable inside TabTerm instead, in the settings panel, and
a combination Chrome keeps is refused there with the reason. See `08-shell-integration.md` and
`extension/src/terminal/page-shortcuts.ts`.

### Why the default is punctuation

A command here is handled by the browser before the page, so binding one **takes that keystroke
away from every site**. The choice is therefore not only about what Chrome permits.

`Command+Shift+O` was an early default and is a poor one for exactly this reason: sites use it,
and a terminal shortcut that quietly disables a shortcut somewhere else is a bad trade for
something opened a few times a day. Letters are the contested space, so the default uses
punctuation. `Command+Shift+Y`, `+U`, `+Period` and `+Comma` were all confirmed bindable, so this
was a choice between working options rather than the only one Chrome would take.

**Manifest acceptance is not binding**, so what Chrome really assigned is read back with
`chrome.commands.getAll()` rather than assumed, and the command menu shows those answers rather
than a table written by hand. One such table said `Option Shift T` for a command that had been
rebound to something else, which is worse than saying nothing. See `10-limitations.md` tier 1.8.

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

### The command line grows, and then the launcher gets out of the way

**The line is counted from the keystrokes, not read off the screen.** In a terminal three rows
tall zsh does not wrap a long line: it truncates the display and draws `>....` to say so. There
are no wrapped rows to count and the line is genuinely not on the screen, so the two earlier
attempts to measure this from the screen could not have worked, and the box stayed small while the
shell quietly showed less than had been typed. The repeated prompt lines in the same report are
the same shell redrawing a line it could not fit.

The counting is deliberately not the buffer that watches for abbreviations, which looks like the
same thing and answers a different question: it forgets the line on every space, because a space
ends a trigger, and keeps only the last 512 characters, because nothing longer can match. Using it
made the box stop growing at about six rows and reset every time somebody typed a word.

It is an estimate and behaves like one. Anything it cannot model, an arrow key, a completion, an
interrupt, sets the count back to nothing, which keeps the box small: being wrong small is the
harmless direction.

The limit is the smaller of ten rows and what fits in the share of the window a strip may have.
Only the height was capped before, so on a short window the box stopped at eight rows and the line
went on growing behind a shell that had started truncating it. Growing to a limit and then
quietly showing less than was typed is the failure this exists to prevent.



The box at the bottom is a view onto the shell's own line, so a command longer than one row has
to be shown somewhere. The panel above it gives up height, one row at a time, and the terminal
underneath is resized to match.

It only ever **grows** while the command does. Shrinking on the way back looked like the obvious
symmetric thing and was the cause of the box shaking: the strip's height sets how many rows the
terminal has, which sets whether it needs a scrollbar, which sets how many columns it has, which
sets where the line wraps, which sets how many rows the command needs. Feed that back into the
height and it oscillates several times a second. The height resets in one step when the command
is back to a single row, which is a state that cannot re-trigger the loop.

Past **ten rows** the launcher dismisses itself and the tab becomes an ordinary terminal in the
home directory. Somebody writing something that long has stopped choosing what to open, and the
alternative is a panel squeezed into nothing with an ellipsis in the middle of what is being
typed. Truncating the line somebody is writing is never the right answer.

### A tab that has started something never goes back to the start screen

Dismissing the launcher writes a flag in `sessionStorage`, and a tab holding that flag never
draws the start screen again, whatever its panes contain.

Reloading was showing it for a moment, and sometimes not only for a moment: the decision was made
from the layout, and a workspace whose panes had all been closed back to one home-directory shell
looks exactly like a tab that was never used. The flag records what actually happened rather than
inferring it from a state that stops being distinguishable. `sessionStorage` because it is per
tab and per browsing session, which is exactly the lifetime of the fact.

### A refused token is dropped rather than offered again

The extension holds the daemon's token in session storage, fetched from the native messaging host.
A token can genuinely change: a daemon reinstalled, a state directory cleared. When that happened,
the connection reconnected on its own schedule, offered the same rejected token every time, and
the page said "tabtermd is not responding" until the tab was closed.

A refusal now clears the cached token and fetches a fresh one, in the page and in the offscreen
document. The connection can also be given a new token without being rebuilt, because the token
belongs to the installation rather than to the connection.

### The key that had two owners

`Shift+Command+K` cleared the screen twice: the page's own shortcut table ran it, and the
terminal's built-in keymap ran it as well. The second run saved the already cleared screen as what
to put back, so taking the clear back restored a bare prompt, which reads as undo being broken.

The page's table owns every key it can bind, and the keymap answers `browser` for those, meaning
"not ours to swallow". Two owners for one key is a defect whatever the key does.

### One list of keys, whatever they are bound to

Everything the page can be asked to do is one list: the shipped actions, and each action
somebody made. One list rather than two, because one list is what makes "is this combination
already taken" a question with an answer. Two would need a third thing to compare them, and the
first time that was forgotten the same keys would run two different jobs.

A key is bound in either of the two places somebody is already looking: on the form where an
action is edited, and in the settings panel's Keyboard shortcuts, which lists the actions after
the shipped ones. Both write the same store, so neither is a second copy of the truth, and every
open tab follows a change through `chrome.storage.onChanged` rather than showing what was true
when it was opened.

Deleting an action deletes its binding. A key bound to something that no longer exists does
nothing when pressed and goes on blocking that combination for everything else.

### What is a browser shortcut and what is a terminal one

Three commands are declared to Chrome: open a terminal, open one on an alternate key, and launch
an agent. They are the ones that make sense with no terminal in front of you, because each of
them makes one.

Splitting a pane and opening the command menu were declared there too, which put them in
`chrome://extensions/shortcuts` as browser-wide keys: rows about panes, offered in every window,
including windows with no terminal in them. They act on a terminal, so they are bound in one.
That also means they can be changed without leaving the product, which the Chrome-declared ones
cannot be.

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
