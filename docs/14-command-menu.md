# 14. Command menu

A floating, persistent panel for the commands you actually reuse: the ones you have marked as
favorites, and the ones you ran recently.

It exists because a terminal's own history is a poor interface for reuse. `Ctrl+R` searches
blind, arrow-up walks backwards one at a time, and neither shows you what a command was *for*.

---

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
| **Actions** | Split, close, detach, maximize, launch an agent, and the rest |
| **Stats** | What this session has run, how long each took, and when |

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
