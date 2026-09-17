# 14. Command menu

A floating, persistent panel for the commands you actually reuse: the ones you have marked as
favorites, and the ones you ran recently.

It exists because a terminal's own history is a poor interface for reuse. `Ctrl+R` searches
blind, arrow-up walks backwards one at a time, and neither shows you what a command was *for*.

---


## Stats belongs to the session, not to the tab looking at it

Every figure was counted in the page that was showing it. Refreshing the tab reset all of them, so
a terminal that had been open all day reported four seconds, no commands run and nothing answered.
The numbers were not wrong about the page. They were about the wrong thing, because a tab is a view
of a session and the session is what did the work.

The daemon keeps them now. It sees every command boundary and every agent turn already, it outlives
every tab, and it writes them down, so a session's counts survive a refresh, a close and reopen,
and a daemon restart.

Two shapes, because two questions are being asked. **Per session**, so a terminal can say what it
has done since it started. **Per day**, so "today" and "the last seven days" are answerable without
keeping a row per command: a row per day is bounded by the calendar rather than by use, which is
the only bound that does not need pruning to be correct.

Counters only. No command, directory or other text is stored by any of this. The two lists that are
about habits, what you run most and where you work, come from the history table, which already
decides what may be remembered: a command typed with a leading space or one that looks like a
secret never reaches it, so neither reaches the page.

| Group | What it answers |
|---|---|
| This terminal, since it started | Commands run, failed, time in them, prompts answered and time spent waiting on the agent, how long it has really been open, and its memory |
| Today, and the last seven days | The same counts across every session, plus how many terminals were opened |
| What you run most, and where you work | The commands and directories with the highest counts |
| What went wrong | Commands that ended with a non-zero exit, most recent first |

The agent figures are absent from a group when nothing has been asked there, because a row of
zeroes about a feature this terminal is not using is worse than no row.

## Stats answers three questions, and says which is which

The page held one list of numbers about commands, and the line in the corner of a pane held a
running command's elapsed time. In a pane running an agent both were about the wrong thing: the
command that is running **is** the agent CLI, which started when the session did, so the corner
said `running 47m` about a process nobody is waiting on and the page counted one command that never
ends.

Three groups now, each under a heading that says what it is about.

| Group | What it answers |
|---|---|
| Agent | How many answers, how long the last one took, the longest, and the total time spent waiting on it. Absent until a turn has finished, because a session with no agent in it has nothing to say here and a row of zeroes is worse than nothing |
| Commands | What was run, how many failed, the typical duration, and the time spent in them |
| This session | Memory of its process tree, and how long it has been open |

A turn is the unit for the first group and no command boundary can see it, so it comes from the
daemon, which bounds a turn with the hooks that report its ends. See `09-agent-integration.md`.

**Memory is the daemon's side only.** A tab showing a session costs more in a Chrome renderer, and
that is not measurable from an extension outside the dev channel, so it is left out rather than
guessed at.

### The line in the corner of a pane answers one question at a time

Whichever question that pane is actually about, in this order:

| When | What it says |
|---|---|
| An agent is answering | `answering 1m 14s`, timed from the prompt |
| An agent is blocked on you | `waiting for you · 30s`, because the thing holding it up is you |
| An agent has just answered | `answered in 1m 35s · 10s ago` |
| A command is running | `running 5s` |
| Otherwise | What the last command did, and how long the session has been open |

The clock is one timestamp sent once and counted up in the page. Streaming a ticking clock over the
wire would be continuous traffic to say something the receiver can work out for itself.

## The Actions page and a pane's own menu offer the same things

A pane can be acted on from two places, and which things each one offered had drifted: naming a
session and marking a place in it were only ever on the pane's own menu, though both are ordinary
actions and the surfaces overlap in everything else.

They are now on both, and the way that stays true is that both call the same function. Two copies
of the same closure agree on the day they are written and not much longer, and the difference shows
up as one surface quietly doing something slightly different from the other.

A pane action needs a pane. The command menu is not attached to one the way a pane's menu is, so it
acts on the focused pane, and with nothing focused these are left out rather than offered and doing
nothing. `menu-aftermath` asserts the two surfaces agree, and fails the moment one of them grows a
pane action the other does not have.

## 1. Shape

Opened from a button in the top right of a terminal tab, or with `Command+K`.

| Opened by | Lands on |
|---|---|
| The button | The tab you were last on |
| `Command+K` | The search box, focused |

| Tab | Contents |
|---|---|
| **Favorites** | Commands you kept, with a display name and an optional hotstring |
| **Recent** | Command history, newest first, searchable |
| **Actions** | Three groups: what TabTerm can do, what you made, and how to make one |
| **Stats** | What this session has run, how long each took, and when |

The Actions tab is grouped rather than flat. A flat list put `Make an action` between two things
that do something, looking exactly like them, and buried what somebody had written among what
ships. The three headings answer three questions: what can this do, what have I taught it, and
how do I teach it something. A heading is a label, not a row: it cannot be selected, and arrow
keys step over it in whichever direction they were going.

Each row carries the key it answers to, and the ones you made carry a pencil and a cross. The
pencil opens the same form as making one, which is also where its key is bound. Clicking an
action runs it, which is the one place in this panel where selecting and acting are the same
gesture: a history row is text and running it by a misplaced click is a real cost, while an
action is a button with a verb on it, and a button you must select before pressing Return is a
button that does not work.

Settings are a gear in the footer rather than a sixth tab. They are not a list of commands, and
putting them in the row of things you select from would mean one tab that does not answer the
question the others do.

The search box empties every time the panel opens. A filter left over from last time is a list
that looks empty for a reason nothing on screen explains.

### It is a panel, not a dialog

- **Translucent**, because there is terminal output behind it and hiding that is the one thing a
  terminal panel must not do.
- **Draggable**, and where you put it is remembered for the next session. A fixed position is
  wrong for a panel that sits over content the user is reading.
- **Minimizable** to a small puck, which reopens where it was.

---

## 2. Selecting and acting

Selection is a step of its own. Nothing in the list acts because the pointer passed over it.

| Input | Does |
|---|---|
| Arrows, `Home`, `End` | Move the highlight |
| Click | Select only |
| **Double-click** | Paste into the terminal, without touching the clipboard |
| `Enter` | Paste into the terminal |
| `Command+Enter` | Copy to the clipboard |
| `e` or right-click (Favorites) | Edit |
| `Escape` | Close, from anywhere |

**The footer names the operations for whatever is selected**, so the keys are never something
you have to remember or discover. It changes with the row: an action row has nothing to copy,
and says so by not offering it.

**Pasting closes the panel.** You came here to get a command to the prompt, and once it is there
the panel is in the way of the thing you are about to do.

Pasting stages the command at the prompt. It does not run it. The commands worth keeping are the
ones worth reading before running, and that has been true of every surface in this product.

### Only one surface has the keyboard

The panel sits over a live terminal, and both accepting keys at once would mean typing that
lands in whichever place happened to be focused last. So the panel takes the keyboard outright:
while it is open the terminal is marked inert and its cursor stops blinking, and closing it hands
focus straight back to the pane that had it. Both stay visible. Only one is listening.

This is also why `Escape` is handled on the document in the capture phase. Wherever focus has
ended up, the key that closes the panel has to work.

---

## 3. Editing a favorite

Three fields:

| Field | Purpose |
|---|---|
| **Display name** | What the list shows. `deploy staging` is a better row than the command itself |
| **Command** | What gets pasted |
| **Hotstring** | An abbreviation that expands to the command while typing |

A favorite with a hotstring set carries a small marker in the list, so the abbreviation is
discoverable from the list rather than only from the edit form.

---

## 4. Hotstrings

Typing an abbreviation and then a space or `Enter` replaces it with the command.

```
type:   runbuild!·          becomes:  npm run build·
type:   runbuild!<Enter>    becomes:  npm run build<Enter>   (and runs)
```

### Why space and Enter, and not as you type

Expanding the instant the characters match would make any hotstring that is a prefix of a real
word unusable: `ls` would fire while you were typing `lsof`. A delimiter means the abbreviation
is only ever expanded once you have finished typing it. `Tab` is not a trigger, because in a
terminal `Tab` already means completion.

On `Enter` the expansion happens **first**, and the command is then submitted, so a hotstring is
one keystroke from running rather than two.

### Where it is allowed to fire

Expansion deletes what you typed and sends something else. At a shell prompt that is exactly
what you asked for. Inside `vim`, those same keystrokes mean something else entirely, and the
backspaces would edit your file.

**The alternate screen decides.** Measured:

| Program | Alternate screen | Hotstrings |
|---|---|---|
| `vim` | yes | suppressed |
| `less` | yes | suppressed |
| A shell prompt | no | active |
| An inline REPL (`python3`) | no | active |
| Agent CLIs | no | **active** |

That distinction is the point: it separates programs that take over the screen from programs
that print into it, which is exactly the line between "these keystrokes are text" and "these
keystrokes are commands". It needs no shell integration and no guessing at a program's internal
mode, which is not knowable from outside.

A hotstring is therefore active in an agent CLI, which is where it is most wanted, and inert in
`vim`, where it would do damage.

### What is tracked, and what is not

Expansion works on **what you typed in this pane**, tracked locally as keystrokes pass through.
It is not derived from the screen, so it cannot be confused by output arriving at the same time.
The buffer resets on `Enter`, on any control character, and when the pane changes.

Consequently a hotstring recalled from shell history, or pasted, does **not** expand: those
characters were never typed. That is the honest boundary of the mechanism and is documented
rather than papered over.

---

## 5. Where favorites come from

- **Starring a row in Recent**, which is the common case
- **Add in the Favorites tab**, for a command you have not run yet
- `Command+S` while a row is selected, which was the only route before this panel existed

---

## 5.5 Settings

The gear holds what TabTerm itself controls, and two switches that make the rest of the product
work at all:

| Setting | Does |
|---|---|
| Theme | Dark, light, midnight |
| Desktop notifications | The master switch, with a duration threshold |
| Shell commands, Agent turns | Which completions are worth a notification |
| Stay quiet while I am looking | Suppress for a pane already on screen |
| **Agent events** | Installs the agent CLI hooks. Without them agent status does nothing |
| **Shell integration** | Adds the line to `.zshrc`. Without it there are no exit codes |

The last two write to files outside TabTerm, so they happen only on an explicit switch, are backed
up before the first change, and are removable to the byte. Both used to be lines of text in the
install output, which meant they were not run, which meant a large part of what a tab can show was
silently inert. See `09-agent-integration.md` and `08-shell-integration.md`.

Each says what it is currently doing rather than only whether it is on. "Installed" and "working"
are different claims, and hooks present that have never fired is the state worth being able to see.

---

## 6. Statistics

Built from the `command-start` and `command-end` events the page already receives, so it costs
nothing extra to collect and reports what the daemon observed rather than what the screen happens
to show.

The tab shows commands run, how many failed, how many are still running, total time, the median
duration and the longest command, then every command with its start time and duration.

**Median, not mean.** One `npm install` should not describe a session of quick commands, and an
average is exactly what would let it. Records are matched to their completion by session key
rather than by command text, because the same command run twice is two runs and matching on text
would attribute the second one's timing to the first.

Statistics are per page and are not persisted. They describe this session, and a number that
survived the session it described would be a different feature.

---

## 7. Storage

Favorites are `saved_items` rows of kind `command`, with `title` as the display name and a
`hotstring` column. Panel position and the last tab live in extension storage, since they are
properties of a view rather than of the data. See `03-data-model.md`.

## Escape closes a menu, and the terminal never hears it

Escape is how a menu is dismissed everywhere, and it is also the interrupt key of every agent CLI
this product hosts. With a menu open and the keystroke reaching the pane underneath, pressing it to
put the menu away stopped an agent mid answer.

So the menu takes the key rather than merely acting on it: the listener is at the capture phase on
`window`, which is the outermost node and therefore ahead of everything in the page and long ahead
of the emulator's own handler on its textarea, and it stops the event there.

Leaving takes the menu with it too. A menu is about a place on a page, and coming back to a tab to
find one still sitting there means the next click lands on an entry opened for something else.
Changing tab hides the page and changing window blurs it, so both are listened for.

**One implementation.** The pane's menu was a second copy of the placing and dismissing code, and
the two drifted: Escape closed the page's menus and not a pane's. Fixing the copy meant deleting
its local `close`, and the entries that called it silently began calling `window.close` instead, so
every entry in that menu closed the tab. `no-restricted-globals` now refuses the bare names that do
that, and the check that caught it is in `escape-closes-the-menu`.

## Adding a command writes nothing until it is saved

Pressing add used to create the row in the daemon and open its editor afterwards, so Cancel left a
command called "New command" behind: the thing somebody had just said no to. Nothing exists until
Save now, and Cancel leaves nothing.

Two rules go with it, and the same ones apply to editing an existing command:

- **A command with nothing in it is not a command.** Save is offered only once there is one, which
  says why without a message to dismiss. Emptying an existing one and saving is refused for the
  same reason: it would leave a row that pastes nothing and a hotstring that expands to nothing.
- **The name falls back to the command.** A row with no name cannot be picked out of a list, and
  the command is what somebody would have called it anyway.

## Everything that speaks from the corner shares one column

The undo for a clear, the undo for a closed pane, and the notice that something is listening on a
port all used to place themselves, so each had to know about the others: one moved the next down by
a hand written offset, and the third knew about neither and sat over the terminal at the bottom of
the screen. They are one column under the menu button now, and the spacing follows whatever is
showing.
