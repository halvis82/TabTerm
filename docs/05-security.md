# 05 — Security Model

The daemon executes arbitrary commands as the logged-in macOS user. That is the point of the
product and also its entire risk surface. This document is a gate: any change touching the
socket, a spawn path, project configuration, or a browser-privileged action requires a review
against it before merge.

---

## 1. Threat model

### In scope

| Threat | Vector |
|---|---|
| **Local process impersonating the extension** | Any program on the machine can open `ws://127.0.0.1:<port>` and forge an `Origin` header |
| **A visited website connecting to the daemon** | WebSocket handshakes are not CORS-preflighted. Any page can attempt a connection |
| **Hostile terminal output** | Escape sequences, OSC titles, fake file paths, fake URLs emitted by any command or any file you `cat` |
| **Hostile project configuration** | A cloned repository containing `.tabterm/` |
| **Secret leakage into history** | Tokens and passwords in command arguments, persisted to SQLite |
| **Privilege confusion via TCC** | Processes spawned by the daemon inherit the daemon's privacy identity, not Terminal.app's |

### Out of scope

- Remote attackers. Nothing binds off loopback, ever.
- A user who is already root, or malware already running as the user with full disk access.
- Physical access.

---

## 2. The token is the only boundary

```
Origin checking is NOT a security control.
```

Any local process can send `Origin: chrome-extension://<our-id>` on a WebSocket handshake. The
header is client-supplied. We check and log it as defense in depth and for diagnostics. We never
make an authorization decision on it.

**The token is the boundary.** Requirements, all enforced and tested:

1. 256 bits from a CSPRNG. Hex-encoded.
2. Stored at `~/.local/state/tabterm/token`, mode **0600**. The daemon refuses to start if the mode
   is wider, rather than fixing it silently.
3. Required in the first frame, within **2000 ms**. Otherwise close with 1008.
4. No other frame is processed before `auth-ok`.
5. Constant-time comparison.
6. Per-source exponential backoff on failure.
7. Rotatable. Rotation invalidates every live connection and triggers re-bootstrap.
8. Never logged. Never written to `chrome.storage.local`. Held in `chrome.storage.session` only.

The daemon binds `127.0.0.1` explicitly, never `0.0.0.0`, never `::`. A test asserts that a
connection from a non-loopback interface fails.

---

## 3. Token bootstrap

The daemon generates a secret in a 0600 file. The extension cannot read files. Bridging that gap is
the bootstrap problem and it has exactly two acceptable answers.

### Primary: native messaging host (ADR-0005)

A tiny native messaging host whose manifest lists **only our extension ID**. Chrome enforces that
allowlist, so the host also authenticates the extension, which the WebSocket alone cannot do.

```
extension → chrome.runtime.connectNative("com.tabterm.host")
host      → reads ~/.local/state/tabterm/token (0600, same user)
host      → returns { token }
extension → caches in chrome.storage.session, connects the WebSocket
```

The host does nothing else. It does not proxy terminal data, does not spawn processes, and does not
accept commands. Its entire surface is one message.

### Fallback: manual pairing

`tabterm pair` prints a one-time code. The user pastes it into the extension options page. Used when
the native host is not installed. Must work, because it is the recovery path when the host breaks.

---

## 4. Untrusted input

Everything below is attacker-controlled the moment you `cat` a file or run a command that prints
something.

### Terminal output

| Rule | Enforcement |
|---|---|
| Never reaches `eval`, `innerHTML`, or a template that renders markup | Lint rule plus review |
| Never becomes a shell string | All spawns take `string[]` argv. There is no `exec` with a string in the codebase |
| OSC title requests populate **structured fields**, never a display string | `TitleFields` in `03-data-model.md` |
| Escape sequences cannot trigger a browser or shell action | xterm.js handles rendering only. No sequence is wired to a privileged handler |
| Output length is bounded before it reaches any parser | Caps on title, cwd, and OSC payload sizes |

### File paths

Detected paths are **candidates**, not facts.

1. Resolve against the **command's** cwd, not the session's current cwd, using the OSC 133 boundary
2. Normalize and reject anything escaping outside the session's project root unless the user
   confirms
3. Ask the daemon to `stat` it. A path that does not exist gets no action offered
4. Pass to the editor as structured argv: `["nvim", "+184", "/abs/path"]`, never a joined string
5. Require an explicit click or keystroke. Nothing opens automatically

### URLs

Scheme allowlist: `http`, `https`, `mailto`. Everything else (`javascript:`, `data:`, `file:`,
custom schemes) is rendered as inert text. Opening always creates a Chrome tab through
`chrome.tabs.create`, never a page-level navigation.

### Webpage text sent to a terminal

Browser-to-terminal actions always require an explicit context-menu
invocation, always paste rather than execute, and always show what will be inserted.

---

## 5. Project configuration trust

The highest-severity surface in the project. A cloned repository can contain `.tabterm/`.

| Kind | Behavior |
|---|---|
| **Declarative JSON** (`workspace.json`, `commands.json`) | Applied without prompting. Schema-validated. `command` must be `string[]`. Cannot express arbitrary execution beyond the argv it declares, and those still only run when the user opens the workspace |
| **Executable** (`plugin.ts`, any script) | **Never runs automatically, under any circumstance.** Requires an explicit trust grant per path, recorded with a content hash |

Trust grants live in the `trust_grants` table with a content hash. Any change to the file
invalidates the grant and re-prompts. The prompt shows a diff and offers Review, Trust and enable,
and Ignore. There is no "trust all projects" setting.

Note that even declarative JSON declares commands that will be spawned. Applying a template without
a prompt is acceptable because the user still has to open that workspace deliberately, and the
argv is visible. Auto-running a project's commands on directory entry is not, and is not implemented.

---

## 6. macOS TCC

**Underappreciated and structural.** Processes spawned by the daemon inherit the *daemon's* privacy
identity, not Terminal.app's or iTerm's.

Consequences:

- `ls ~/Desktop`, `~/Documents`, `~/Downloads` may return `Operation not permitted` until the
  daemon's binary is granted access
- Full Disk Access granted to iTerm does not transfer
- Camera, microphone, Contacts, Calendar, Photos, and Accessibility requests are attributed to the
  daemon
- With a bare `node` daemon the prompt reads "node" wants access, and the grant can be invalidated
  by a Node upgrade or a Homebrew path change

**Mitigation, decided by the TCC spike and implemented in the app bundle work:** ship the daemon inside a signed app
bundle with a stable bundle identifier, and point the LaunchAgent at the bundle's executable. TCC
then has a durable identity to attach grants to.

Retrofitting this later forces every user to re-grant everything. It is on the critical path for
that reason, not for functionality.

---

## 7. History privacy

Command history contains secrets by nature.

| Control | Behavior |
|---|---|
| Leading-space exclusion | Commands starting with a space are never recorded |
| `HISTCONTROL` | Respected where the shell exposes it |
| Ignore patterns | Configurable regex list. Matching commands are recorded as redacted or not at all |
| Default redactions | `export .*TOKEN=`, `password=`, `secret=`, `--api-key`, `Authorization:`, `Bearer ` |
| Per-session disable | Toggle, and a config default |
| SSH sessions | History disabled by default for sessions with a detected `sshHost` |
| Deletion | Per entry, per project, and clear all |
| Retention | Configurable, default 180 days |
| Sync | **None.** There is no remote endpoint in the codebase |

Command **output** archiving is off by default and, when enabled, records only OSC 133-delimited
command output regions, skipping alt-screen periods entirely.

---

## 8. Extension permissions

Every permission in `manifest.json` is justified here line by line. A permission with no line is a
review failure.

| Permission | Why |
|---|---|
| `tabs` | Create terminal tabs, query for existing matching tabs on link open, detach panes |
| `tabGroups` | Inherit and manage project groups |
| `offscreen` | Hold the control connection past service worker termination |
| `storage` | Settings. Token uses `session` storage only |
| `notifications` | Terminal event notifications |
| `nativeMessaging` | Token bootstrap only |
| `contextMenus` | Explicit browser-to-terminal actions |
| `clipboardRead` | Paste into the terminal |
| `commands` | Keyboard shortcuts |

No `<all_urls>`. No content scripts on arbitrary pages unless a specific feature justifies it, and
none currently does.

---

## 9. Logging

- Logs never contain command text, environment values, or terminal output by default
- A verbose mode exists for debugging and states clearly that it will capture sensitive data
- The diagnostic bundle from `tabterm doctor` is redacted by default and lists what it includes
- Stack traces are logged daemon-side and never returned to the page. The page receives an error
  `code` from the table in `02-protocol.md`

---

## 10. Review checklist

Applied to any change touching this surface.

- [ ] No new listening socket, or it binds loopback and requires the token
- [ ] No shell string construction. All spawns are argv arrays
- [ ] All external input validated at the boundary, with the validation stated in the PR body
- [ ] No terminal output reaches markup, `eval`, or a privileged handler
- [ ] Any new privileged browser action requires an explicit user gesture
- [ ] No new secret written to disk, or it is 0600 and never logged
- [ ] Any new persisted field considered for the redaction pipeline
- [ ] `10-limitations.md` updated if a new constraint was discovered
