# TabTerm privacy policy

**Last updated:** 2026-09-09

TabTerm is a terminal. Everything it handles is the sort of thing a terminal handles, which is to
say some of it is sensitive. This describes exactly what it touches, where that stays, and what you
can delete.

The short version: **there is no TabTerm server.** Nothing is uploaded, because there is nowhere to
upload it to.

---

## What TabTerm is made of

Two pieces, and the split matters for this document:

- **The Chrome extension**, which is the interface. Tabs, panes, the start screen
- **The companion program on your Mac**, which owns the actual terminal processes and everything
  written to disk

The extension talks to the companion program over a loopback connection on your own machine.

It also talks to other things listening on `localhost`, and only when you ask it to. Opening a local
service from the start screen loads it in a tab, and confirming that one should be closed shows a
small preview of it first. Those are ordinary requests to your own machine, made because you pressed
something, and they go no further than it.

There is no TabTerm server anywhere. Nothing you type, nothing your programs print, no command
history, no clipboard contents and nothing about your projects is sent to any service TabTerm
operates, because there is not one to send it to.

Programs you run in a terminal reach the network on their own account, exactly as they would in any
other terminal. `npm install` downloads packages and `curl` fetches a page. That traffic is theirs
and it is not TabTerm sending your terminal anywhere.

---

## What TabTerm handles

**Terminal input and output.** What you type into a terminal and what your programs print. This
lives in the terminal process on your Mac. Recent output is kept on disk so a tab can show what was
there after Chrome restarts.

**Command history.** Commands you run, when, in which directory, and whether they succeeded, so the
command menu can offer them again.

**Directories and projects.** Folders you have opened, and per-project configuration files you have
explicitly trusted.

**Clipboard contents.** Read only when you invoke Paste. Written only when you invoke Copy.

**Webpage text and URLs.** Only when you explicitly choose a TabTerm action from the right-click
menu on a page. The selected text or the URL is placed at your terminal prompt, on your machine,
for you to look at before you run anything.

**Settings and interface state.** Your theme, panel state, saved templates, keyboard shortcuts,
highlight colors, and which workspaces have tabs open.

**A local access token.** Generated on your machine so that only the extension can talk to the
companion program. It is held in Chrome's session storage, which Chrome clears when the browser
closes.

---

## Where it goes

Nowhere.

- **No TabTerm server exists.** There is no backend, no account, no sign-in
- **Terminal input and output are never transmitted anywhere by TabTerm**
- **No analytics. No telemetry. No crash reporting**
- **No advertising, and no data is sold or shared with anybody**

The extension makes no network requests to any remote host. Its only connection is to the companion
program on your own machine, over loopback, and that connection is bound to loopback and refuses
anything without the local token.

Programs **you** run in a terminal can of course use the network. That is what a terminal is for,
and it is your command doing it rather than TabTerm.

---

## What is written to your disk, and where

All of it under your home directory, readable only by you:

| What | Where |
|---|---|
| Command history, folders, projects, saved items, workspaces | `~/.local/state/tabterm/tabterm.sqlite` |
| Recent terminal output, per session | `~/.local/state/tabterm/scrollback/` |
| Your settings | `~/.local/state/tabterm/settings.json` |
| Output of individual commands, **only if you turn it on** | the same database, `archiveOutput` in the config file, off by default |
| Diagnostic log | `~/.local/state/tabterm/logs/` |
| The local access token | `~/.local/state/tabterm/token`, mode 0600 |
| Interface state | Chrome's own extension storage |

**The diagnostic log deliberately excludes the things above.** It records that a command ran, not
what it was; that a folder was opened, not which one; that output arrived, not what it said. There
is a test that reads the source and fails if a new log line would carry a path, a command, terminal
text or an environment value.

---

## Retention, and deleting it

Nothing is kept forever without you having asked for it.

- **Recent output** is bounded by a size budget you set in Settings, and pruned after 30 days
- **Command history** can be cleared from the command menu, one entry or all of it
- **Everything at once**: Settings has a Reset that removes stored settings, and a Reset Everything
  that ends every session and deletes stored history
- **By hand**: delete `~/.local/state/tabterm/` and it is all gone
- **Uninstalling**: `./scripts/uninstall.sh` in the repository removes the companion program.
  Removing the extension removes what Chrome stored for it

---

## Services listening on your own machine

Development means running servers, so the start screen says which ones are running. This is part of
working in a terminal rather than a separate feature: the thing you started in a pane a minute ago
is the thing you want to open.

TabTerm asks the operating system which ports are being listened on, and shows the port number and
the name of the program holding each one. Servers started inside a TabTerm session are shown apart
from everything else that happens to be listening, because more is known about the first kind.

None of this leaves your machine, and none of it is stored. It is read when the start screen asks
and it is gone when the list closes.

What you can do with one:

- **Open it**, which loads `http://localhost:<port>/` in a tab like any address
- **Copy its address**
- **Close it**, which ends the program holding the port

Closing is the only one that acts on something outside TabTerm, so it is the careful one:

- It always asks first, naming the program and the port
- The confirmation shows a small preview of the page, loaded at that moment and never before. It is
  sandboxed: it cannot submit forms, open windows, download anything, or navigate the page it sits in
- TabTerm's own ports cannot be closed
- Only ports above 1024 are eligible, which is where the operating system's own services are not
- Whoever holds the port is looked up **again** at the moment you confirm, rather than trusting what
  the list said a minute ago, because ports get reused and the wrong process must not be ended
- It sends `SIGTERM`, which asks a program to stop and lets it save what it was doing, rather than
  `SIGKILL`, which does not

---

## Native messaging

Chrome's native messaging is used for one thing: handing the extension the local token so it can
open its connection to the companion program. It carries no terminal data. The companion program is
registered to accept messages only from the TabTerm extension.

---

## Permissions, and why each exists

| Permission | What it is for |
|---|---|
| `tabs` | Open terminal tabs, find existing ones, move panes between them |
| `tabGroups` | Group terminal tabs by project |
| `storage` | Settings and interface state |
| `offscreen` | Hold the local connection open while Chrome suspends the extension's worker |
| `alarms` | Periodically tell the companion program which tabs are still open, so a terminal is not ended while its tab exists |
| `nativeMessaging` | The token handover described above |
| `notifications` | Tell you when a command finished or an agent needs you |
| `contextMenus` | The right-click actions that send a selection or a link to a terminal |
| `clipboardRead` | Paste, when you invoke it |
| `clipboardWrite` | Copy, when you invoke it |

TabTerm requests no access to websites. It has no content scripts and no host permissions, so it
cannot read pages you visit. The only webpage data it ever sees is what you hand it deliberately
through the right-click menu.

---

## Changes

This file lives in the repository, so its history is public and any change to it is a commit you
can read.

## Contact

Through the repository: <https://github.com/halvis82/TabTerm>
