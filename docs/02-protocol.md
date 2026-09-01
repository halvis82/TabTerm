# 02 — Wire Protocol

Transport: WebSocket over `127.0.0.1`. Two roles, `control` and `data`. See `01-architecture.md`
for why they are separate.

Protocol version is an integer. The daemon accepts exactly the versions it knows and closes with a
readable error otherwise. Never negotiate silently to a degraded mode.

---

## 1. Framing

The first byte of every WebSocket frame is the frame type.

| Byte | Type | Payload |
|---|---|---|
| `0x00` | Control | UTF-8 JSON |
| `0x01` | Output | `u32 streamId` (BE) + raw PTY bytes |
| `0x02` | Input | `u32 streamId` (BE) + raw bytes to write to the PTY |
| `0x03` | Ack | `u32 streamId` + `u32 bytesConsumed` |

Terminal bytes are never JSON-encoded or base64-encoded. Base64 would inflate high-throughput
output by a third for no benefit, and JSON escaping of arbitrary bytes is a correctness trap.

`streamId` is scoped to the connection, assigned by the daemon at attach time. It is not the
session ID. A page with three panes uses one connection and three stream IDs.

---

## 2. Authentication handshake

```
client → daemon   0x00 {"t":"auth","v":1,"role":"data","token":"<hex>","clientId":"<uuid>"}
daemon → client   0x00 {"t":"auth-ok","serverVersion":"...","sessionCount":n}
```

Rules, all enforced:

1. The auth frame must arrive within **2000 ms** of connection open, or the daemon closes with 1008.
2. No other frame is processed before `auth-ok`. Anything else closes the connection immediately.
3. Token comparison is constant-time.
4. On failure the daemon closes with 1008 and applies increasing backoff per source.
5. `clientId` is a stable per-Chrome-profile UUID. It identifies a *client*, not a session, and is
   how mirrored views and multi-profile attachment are tracked.
6. Origin is checked and logged, but **is not a security boundary**. Any local process can forge it.
   See `05-security.md`.

---

## 3. Control messages, client to daemon

| Message | Fields | Notes |
|---|---|---|
| `auth` | `v`, `role`, `token`, `clientId` | Must be first |
| `create-session` | `cwd?`, `command?`, `env?`, `cols`, `rows`, `projectId?` | `command` is `string[]` argv, never a shell string |
| `attach` | `sessionId` or `workspaceId`, `cols`, `rows` | Returns snapshot |
| `detach` | `sessionId` | Explicit. Connection close implies detach for all its streams |
| `resize` | `sessionId`, `cols`, `rows` | Daemon applies min across attached clients |
| `request-scrollback` | `sessionId`, `beforeSeq`, `maxLines` | Paged, never wholesale |
| `kill-session` | `sessionId`, `signal?` | Escalates per `04-session-lifecycle.md` |
| `set-pin` | `sessionId` or `workspaceId`, `pinned` | Pinned is never reaped |
| `set-persistence` | `sessionId`, `policyId` | |
| `create-workspace` | `layout`, `chromeTabId?`, `chromeGroupId?` | |
| `update-layout` | `workspaceId`, `layout` | Transactional, validated |
| `merge-session` | `sessionId`, `workspaceId`, `targetPaneId`, `direction` | |
| `detach-pane` | `workspaceId`, `paneId` | Returns a URL for the new tab |
| `list-sessions` / `list-workspaces` / `list-projects` | filters | |
| `search-history` | `query`, `scope`, `page`, `pageSize` | Paged, always |
| `save-item` / `delete-item` | | Notes and saved commands |
| `open-workspace-template` | `templateId`, `overrides?` | |
| `subscribe` | `topics[]` | Control connection only |
| `get-notify-policy` / `set-notify-policy` | `policy{}` | Partial. Threshold clamped to 5s..10m |
| `get-agent-hooks` / `set-agent-hooks` | `enabled` | Writes agent CLI settings. See `09-agent-integration.md` |
| `clear-scrollback` | `sessionId` | Drops every stored copy, not just the screen |
| `list-live-sessions` | | Sessions that have run something, with a preview of their screen |
| `complete-path` | `partial` | Directory completion. The daemon reads the filesystem; a page cannot |
| `check-folder` | `path` | Is that folder there? Same reason as above: only the daemon can look |
| `create-folder` | `path` | Make it, then answer as `check-folder` would |
| `get-scrollback-budget` / `set-scrollback-budget` | `bytes` | Clamped to 1 MB..50 MB |

---

## 4. Control messages, daemon to client

| Message | Fields | Trigger |
|---|---|---|
| `auth-ok` / `auth-fail` | | Handshake |
| `session-created` | `sessionId`, `streamId`, `pid` | |
| `snapshot` | `sessionId`, `streamId`, `seq`, `cols`, `rows`, `screen`, `scrollback`, `cursor`, `altScreen`, `attrs` | Attach response. See §6 |
| `cwd` | `sessionId`, `cwd`, `gitRoot?` | OSC 7 |
| `title` | `sessionId`, `fields{}` | Structured fields, frontend formats. Never a raw string |
| `process-state` | `sessionId`, `state`, `foreground?` | |
| `command-start` | `sessionId`, `commandId`, `command`, `cwd`, `startedAt` | OSC 133 |
| `command-end` | `sessionId`, `commandId`, `exitCode`, `completedAt`, `interrupted` | OSC 133 |
| `agent-state` | `sessionId`, `state`, `detail?` | Hook bridge, see `09-agent-integration.md` |
| `session-exited` | `sessionId`, `exitCode`, `signal?` | |
| `session-detached` | `sessionId`, `remainingClients` | |
| `session-expiring` | `sessionId`, `expiresAt`, `reason` | Grace warning |
| `session-expired` | `sessionId` | |
| `workspace-updated` | `workspaceId`, `layout` | Another client changed it |
| `server-detected` | `sessionId`, `port`, `proto` | |
| `notify` | `priority`, `title`, `body`, `target{}`, `suppressIfVisible?` | Control connection only |
| `notify-policy` | `policy{}` | After a get or a set |
| `agent-hooks` | `status{}` | `installed`, per-target detail, `lastEventAt?` |
| `scrollback-budget` | `bytes` | After a get or a set |
| `live-sessions` | `sessions[]` | Each with `attached`, `busy` and a `preview`. See §4.1 |
| `path-completion` | `partial`, `completed`, `matches[]` | `partial` is echoed so a stale answer can be dropped |
| `folder-checked` | `path`, `exists`, `isFile?`, `error?` | `path` is echoed for the same reason. A folder that is not there is an answer, not an error |
| `error` | `code`, `message`, `context?` | Never a bare string |

### 4.1 Which sessions are live

`live-sessions` is not every session the daemon holds. A session appears once a command has run
in it, and stays for as long as it is alive, including after that command finishes. A session
started with an explicit command is included from the moment it exists, since the command is the
reason it was spawned and may still be running.

A shell that has printed a prompt and nothing else is deliberately absent. It is a session in the
daemon's bookkeeping and an empty tab to the person who opened it, and including those makes the
list read as terminals they do not recognize.

`attached` means a client connection is reading the session, which is not quite the same as a tab
being on screen. A client showing a session should filter its own out of the list before
presenting it, because the daemon serves one list to every connection and cannot tell which tab
is asking.

---

## 5. Flow control

Terminal output is the only high-volume traffic and the only thing that can kill a tab.

**Credit window per stream.** The daemon may have at most `WINDOW` bytes outstanding and unacked
per stream. The client sends `0x03 Ack` with `bytesConsumed` from the xterm.js write callback, which
fires after the data is actually parsed, not merely queued.

**Coalescing.** Output is accumulated for `COALESCE_MS` and flushed as one frame, capped at
`MAX_CHUNK`. This turns `cat bigfile` from tens of thousands of tiny frames into a manageable stream.

| Parameter | Value |
|---|---|
| `WINDOW` | 256 KiB |
| `COALESCE_MS` | 6 ms |
| `MAX_CHUNK` | 64 KiB |

Measured: the loopback socket sustains 1,783 MB/s while the VT parser sustains 50 MB/s. The socket
is not the constraint. The window exists to protect the frontend renderer, and `MAX_CHUNK` is set at
the point where parse throughput stops improving. See `11-performance.md`.

**The critical rule:** when a client's window is exhausted, the daemon stops *sending* to that
client. It never stops *reading* the PTY. Output continues into the VT state machine and scrollback.
When the client catches up, the daemon does not replay the backlog byte by byte. If the client fell
behind by more than one window, the daemon drops the intermediate stream and sends a fresh snapshot
instead. Terminals are idempotent on redraw; nobody needs to watch a 500 MB `cat` scroll past in
real time.

**Detached sessions** have no window and no sending. Draining and VT feeding continue unchanged.

---

## 6. The snapshot

The single most important message in the protocol. It answers "what does this screen look like right
now" so a fresh renderer can become identical to the one that was destroyed.

It must carry, at minimum:

- Grid dimensions
- Every cell: codepoint(s), foreground, background, and attribute flags (bold, dim, italic,
  underline and style, inverse, invisible, strikethrough)
- Cursor position, visibility, and shape
- Saved cursor state
- Alternate screen flag, and if active, the primary screen's preserved content
- Scroll region top and bottom
- Active character set and any pending mode state
- Bracketed paste, application cursor, and mouse reporting modes
- Scrollback, up to the requested cap
- The sequence number the live stream resumes from

Anything the chosen emulator library cannot round-trip is recorded in `07-terminal-fidelity.md` as a
known fidelity gap. the VT fidelity spike exists to find those before they surprise us.

Snapshot encoding is chosen in the VT fidelity spike against measured size and cost at 1k, 10k, and 50k scrollback
lines. It is not JSON if JSON proves too slow.

---

## 7. Ordering and idempotence

- Output frames for a given stream are strictly ordered. Control frames are ordered relative to each
  other but not relative to output, except that a `snapshot` establishes a sequence point.
- Every state-changing control message is idempotent. Re-sending `attach` after a reconnect is safe
  and returns a fresh snapshot.
- The daemon never sends a delta the client could have missed. On reconnect it re-sends current
  state. This is why the control connection can drop without consequence.

---

## 8. Errors

Every error carries a machine-readable `code`. The frontend never parses `message`: the code
chooses the sentence, and `message` is appended as the detail, because that is the half naming
the folder, the session, or the command.

**An error carries a `context`, and a client acts only on its own.** The daemon tells every
client when a workspace ends, since the tab that needs to hear it is not necessarily attached at
that moment. A page that ignored the context put "this terminal session expired" over every open
tab whenever any one workspace ended, including tabs whose own session was running.

**A message names the cause, not the category.** "could not launch the agent" cannot be acted on;
the reason underneath it usually names the command that was missing or the directory that was not
there.

**Nothing is reported as a bare number.** A pane showing an exit code and nothing else cannot
distinguish a missing program from a crash, so a command that fails to start says so in the
session's own output, the way a shell does.

**A bad frame does not take the tab with it.** Decoding and handling are both contained, and a
failure in either is reported rather than left to escape into an event handler, where it presents
as a tab that quietly stopped updating.

| Code | Meaning |
|---|---|
| `auth-required` | Frame received before `auth-ok` |
| `auth-failed` | Bad token |
| `version-unsupported` | Protocol version not accepted |
| `session-not-found` | Unknown or already reaped |
| `session-expired` | Known but reaped. Frontend shows the recovery page |
| `session-attached-elsewhere` | Merged into a workspace. See `04-session-lifecycle.md` §merge |
| `workspace-invalid-layout` | Rejected layout tree |
| `path-not-found` | Path action target does not exist |
| `not-trusted` | Project config requires an explicit trust grant |
| `rate-limited` | Auth backoff active |
| `internal` | Bug. Logged with context, never leaks a stack to the page |

---

## Who receives a broadcast

Two audiences, and confusing them is silent.

| Method | Reaches | For |
|---|---|---|
| `broadcast` | The control connection only | Things only the offscreen document can act on, such as a desktop notification |
| `broadcastAll` | Every authenticated connection | Shared state that terminal pages render |

Terminal pages connect with role `data`. Sending page state to the control role alone means the
one context that cannot draw anything receives the update and every context that can does not.
There is no error: the change simply never appears. A favorite edited in one tab stayed stale in
all of them, and a page asking for the memory mode never heard back at all.
