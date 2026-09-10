# Chrome Web Store review instructions

Written to be pasted into the review and testing field of the Chrome Web Store dashboard, and kept
here so it stays true as the product changes.

Everything below has been run on a Mac. Nothing in it invents a step that does not exist: there is
no signed installer to download, the setup is a clone and a build, and that is what this says.

---

## What TabTerm is

A terminal for macOS whose sessions are Chrome tabs. The extension is the interface. The terminal
processes themselves belong to a companion program that runs on the machine, because a browser tab
cannot own a shell and must not be able to end one by being closed.

**The extension does not work on its own.** Without the companion program installed there is nothing
to connect to, and the extension says so rather than appearing broken. That is the expected first
run, not a failure.

## Prerequisites

- macOS. There is no Windows or Linux build
- Node 22 or newer. `node --version`
- Chrome 120 or newer
- Xcode command line tools, for building the native module: `xcode-select --install`

## Install the companion program

```
git clone https://github.com/halvis82/TabTerm.git
cd TabTerm
npm install
npm run build
./scripts/install.sh
```

`install.sh` is idempotent and safe to re-run. It copies the companion program and the native
messaging host into `~/.local/libexec/tabterm`, registers the host for this extension's ID, writes a
launch agent so the program starts at login, and starts it. It does not edit any dotfiles.

The native messaging host is installed by that same script. It exists only to hand the extension a
local token, and is registered against this extension's ID alone.

## Confirm it is healthy

```
npm run doctor
```

It checks each link in the chain and names the one that is broken. A healthy machine reports the
companion program running and listening on `127.0.0.1`.

## Load the extension

1. `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked**, and choose the `extension/dist` folder inside the clone

Or install the packaged `.zip` from the store listing, which is the same code. The extension ID is
pinned by a key in the manifest, and both IDs are registered with the native messaging host, so
either works.

## Open a terminal

Press **Option Shift T**, or click the TabTerm icon in the toolbar.

**What success looks like:** a tab opens showing a start screen with a folder box and a shell prompt
underneath. Type `echo hello` and press Return. The output appears. That is a real PTY: `ls`, `vim`
and `top` all work.

Close the tab and open a new one from the toolbar. The start screen lists the session under
**Running now**, still alive. Clicking it goes back to it. This is the product's central claim and
it is worth one minute of a reviewer's time.

## Copy and paste

Select text in the terminal with the mouse, then **Command C**. Click into the terminal and press
**Command V**. The text is pasted at the prompt and is not run.

Both use the `clipboardRead` and `clipboardWrite` permissions, and only on those two actions.
Nothing reads the clipboard at any other time.

## The context menu

On any web page, select some text, right click, and choose **TabTerm**. The selection is placed at
the prompt of a terminal, **not run**. The same menu can send a link's address or the page's address.

This is the only path by which anything from a web page reaches TabTerm, and it takes an explicit
choice from the menu every time. There are no content scripts.

## Local services

Run something that listens. In a TabTerm terminal:

```
python3 -m http.server 8300
```

Open a new tab. The start screen shows it under **Local ports**, with the port and the program
holding it. Pressing the row opens `http://localhost:8300/` in a tab. **Copy** puts the address on
the clipboard. **Close** asks first, shows a small sandboxed preview of the page so it is clear what
is about to be ended, and then sends `SIGTERM` to the process. TabTerm's own ports cannot be closed
this way, and neither can anything below port 1024.

This is part of the terminal workflow: the server you started a minute ago is the one you want to
open.

## With the companion program not running

To see it, stop the program:

```
launchctl bootout gui/$(id -u)/com.tabterm.daemon
```

Open a TabTerm tab. It shows a setup screen explaining that the companion program is not running and
what to do about it. It does not show an error, and it does not look broken.

Start it again:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tabterm.daemon.plist
```

## What the extension talks to

The companion program over loopback, and services on `localhost` that a person explicitly opens or
previews. There is no TabTerm server anywhere, and nothing typed, printed, copied or opened is sent
to one. `PRIVACY.md` in the repository is the full statement, published at
<https://halvis82.github.io/TabTerm/privacy.html>.
