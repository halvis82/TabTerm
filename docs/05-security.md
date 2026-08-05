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

Context-menu actions (`extension/src/chrome/cross-actions.ts`) can send a selection, a link, or
a repository URL to a terminal. **Nothing they produce is ever run.** The command is staged at a
prompt and waits for the user to press Enter themselves.

| Guard | Why |
|---|---|
| Newlines collapse to spaces | A shell treats a newline as "run this now", so a selection showing one command and hiding another after a line break would execute the second before anyone read it |
| Other control characters removed | Showing the user the exact text *is* the mechanism; an escape sequence could make the display disagree with what would run |
| Values shell-quoted | The staged line sits at a real prompt where Enter runs it, so it has to be correct as written |
| Never a trailing newline | This is the entire difference between staging and running |
| Clone offered only for known hosts | Otherwise any page could present itself as something to clone |
| `http`/`https` links only | A terminal has no business acting on `file:` or `javascript:` on a page's say-so |
| Capped at 4000 characters | A selection is not a file transfer |

The confirmation overlay renders the text with `textContent` into a `pre`, never as markup, and
says where it came from. Accepting removes the parameters from the URL, so a reload or a Chrome
restore does not re-ask about something already answered.

**Detected local servers are offered, not opened.** A process binding a port is not a request
for a browser tab. The offer appears in the tab that started it and fades on its own; accepting
focuses an existing tab for that port rather than opening a second one, because a dev server
restarts constantly. Detection is triggered by the shell integration's command-start mark, so
it requires the integration for the same reason command history does.

---

## 5. Project configuration trust

The highest-severity surface in the project. A cloned repository can contain a `.tabterm.json`
(or `.tabterm/workspace.json`), and the whole point of that file is to describe commands to run.

Implemented in `daemon/src/project-config.ts` (parsing) and `daemon/src/project-trust.ts`
(decisions). The two are separate on purpose: parsing decides what a file is even allowed to
say, and trust decides whether anyone acts on it.

### What a config may contain

| Kind | Behavior |
|---|---|
| **Declarative JSON** — a layout tree, one argv per pane, an optional tab group | Parsed, validated, and *offered*. Never applied without a decision |
| **Anything executable** — `plugin`, `script`, `exec`, `setup`, `preLaunch`, `postLaunch` | **Refused outright.** Not gated behind a prompt: refused. The whole file is rejected |

Refusing rather than prompting is deliberate. There is no version of "run this cloned
repository's script" that is safe by default, and a prompt that appears often enough becomes a
button people click without reading.

### Why argv, and only argv

A command must be a JSON array of strings. A command given as a *string* is rejected rather
than split. Splitting is exactly where shell metacharacters re-enter, so the file is simply
unable to express anything a shell would reinterpret:

```json
{ "layout": { "terminal": { "command": ["grep", "-r", "$(whoami); rm -rf /"] } } }
```

Those characters reach `grep` as a literal argument and can never be re-interpreted. They are
*not* stripped or escaped: sanitizing would be the wrong fix and would break legitimate
commands. Every argv goes to `execvp`, never through a shell.

Further limits, all of which reject rather than repair: 64 KB maximum file size, 8 panes,
8 levels of nesting, 32 arguments per command, 2000 bytes per argument, no null bytes. A
config that names a `sessionId` is ignored, so a repository cannot attach itself to a live
shell. A declared `cwd` is confined to the project directory.

### How trust is decided

Approval is granted by a person, to specific bytes, and is never inferred.

- **Keyed by content hash, not path.** Approving a config once must not approve whatever that
  file says after a `git pull` or a branch switch. A changed file re-prompts, and says that it
  changed since it was approved.
- **Denials are remembered.** Otherwise a repository re-asks on every visit until someone
  clicks through it.
- **There is no "trust all projects" setting.** A blanket approval is indistinguishable from no
  approval at all, and it is the setting an attacker is counting on.
- **The prompt shows every command verbatim**, exactly as written in the file. Approving a
  summary is not approving anything.

Decisions live in the `project_trust` table (`path`, `content_hash`, `decision`, `decided_at`).

### The daemon enforces this, not the page

`launch-project-template` re-reads the file and re-checks trust server-side. A compromised
extension page that sends the message directly gets `not-trusted` back. The client is never the
authority on whether a prompt was shown. Covered by
`daemon/src/project-protocol.test.ts`, including the supply-chain case end to end: approve,
rewrite the file, and confirm the daemon refuses to launch it.

Nothing here runs on directory entry. Trust decides only whether a workspace is *offered*; the
commands still run when a person opens it.

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
