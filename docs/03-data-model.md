# 03 — Data Model

Shared types live in `shared/src/model.ts` and are imported by both the daemon and the extension.
SQLite is the daemon's private storage. The database is **never** mirrored wholesale into JS memory;
all access goes through a query-only layer.

---

## 1. Core types

```ts
type SessionState =
  | "starting"    // PTY spawned, first output not yet seen
  | "attached"    // one or more frontends connected
  | "detached"    // live, no frontend, not yet expiring
  | "expiring"    // grace period running, reap scheduled
  | "exited"      // child process ended, metadata retained briefly
  | "reaped";     // gone, row retained for history only

type ProcessState =
  | "idle" | "running" | "waiting" | "approval" | "failed" | "exited";

interface TerminalSession {
  id: string;
  createdAt: number;
  lastAttachedAt: number;
  lastDetachedAt?: number;

  state: SessionState;
  processState: ProcessState;

  shell: string;
  command?: string[];          // argv, never a shell string
  cwd: string;
  env?: Record<string, string>;

  cols: number;
  rows: number;                // last applied, = min across attached clients

  pid?: number;
  foregroundProcess?: string;
  exitCode?: number;
  signal?: string;

  pinned: boolean;
  persistent: boolean;
  cleanupPolicyId?: string;

  titleFields: TitleFields;    // structured, frontend formats
  projectId?: string;
  gitRoot?: string;
  sshHost?: string;

  // Attachment
  attachedClientIds: string[];         // mirrored views, multi-profile
  attachedWorkspaceId?: string;        // set when merged into a workspace
  attachedPaneId?: string;

  agentState?: AgentState;
  agentResumeId?: string;
}

interface TitleFields {
  cwd?: string;
  repo?: string;
  process?: string;
  file?: string;
  sshHost?: string;
  custom?: string;
  status?: string;
}
```

`titleFields` is structured on purpose. The daemon never produces a display string. A shell that
emits a hostile OSC title cannot inject formatting or markup into the tab title, because the
frontend composes from known fields. See `05-security.md`.

---

## 2. Layout and workspace

```ts
type LayoutNode =
  | { type: "terminal"; paneId: string; sessionId: string }
  | { type: "split";
      direction: "horizontal" | "vertical";
      ratio: number;                       // 0 < ratio < 1, size of children[0]
      children: [LayoutNode, LayoutNode] };

interface Workspace {
  id: string;
  title?: string;
  projectId?: string;

  chromeTabId?: number;        // advisory, stale after restore
  chromeWindowId?: number;
  chromeGroupId?: number;

  layout: LayoutNode;

  pinned: boolean;             // default true, see ADR-0012
  createdAt: number;
  updatedAt: number;
}
```

Layout invariants, enforced on every write and property-tested:

1. Every `paneId` is unique within the workspace
2. Every `sessionId` referenced exists and is not referenced by another workspace
3. No split has fewer than two children
4. `0.05 <= ratio <= 0.95`
5. Removing a pane collapses its parent split into the sibling, never leaves a one-child split

A workspace with a single pane is a `LayoutNode` of type `terminal` at the root. A standalone
terminal tab is a workspace with one pane. There is no separate "single terminal" concept, which is
what makes merge and detach symmetric operations rather than special cases.

---

## 3. Commands, projects, saved items

```ts
interface CommandRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  gitRoot?: string;
  cwd: string;
  sshHost?: string;

  command: string;
  normalized: string;          // for dedup and frequency
  foreground?: string;

  startedAt: number;
  completedAt?: number;
  durationMs?: number;

  exitCode?: number;
  interrupted: boolean;

  pasted: boolean;
  fromSavedItemId?: string;
  startedServer?: number;      // port
  launchedAgent: boolean;

  redacted: boolean;           // true if any part was scrubbed
}

interface Project {
  root: string;                // the primary key: a repository is its path
  name: string;
  pinned: boolean;
  lastOpenedAt: number;
}

type SavedKind = "command" | "template" | "note" | "prompt" | "workflow";

interface SavedItem {
  id: string;
  kind: SavedKind;
  title: string;
  body: string;
  description?: string;
  scope: "global" | "project";
  projectId?: string;
  cwd?: string;
  tags: string[];
  placeholders?: string[];     // prompted before run
  safeToRunDirectly: boolean;  // still requires an explicit run action
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
  pinned: boolean;
}
```

---

### Finding the project a directory belongs to

`daemon/src/project-index.ts`. A repository root is the unit people think in, so history and
saved items scope to it rather than to one exact directory.

There is **no filesystem walk**. Finding a root means climbing from a directory that is already
known, which is bounded by that directory's depth; searching *downward* for repositories would
be unbounded and is not done. `.git` is checked for existence rather than for a directory, so
worktrees and submodules are found too, and the innermost match wins.

The climb **stops at the home directory**. A stray `.git` above home would otherwise make every
directory on the machine one enormous project.

Results are cached both ways, and every directory passed on the way up is cached with the same
answer. A repeat lookup is a map lookup; a new directory inside a known project costs one
check, not a fresh climb. Negative answers are cached too, since repeatedly failing to find a
repository is exactly the case worth not repeating. `invalidate(path)` clears a subtree and any
ancestor whose negative answer was reached through it, so a directory that has just become a
repository stops claiming it is not one.

**Discovery never blocks a caller.** `recordDir` runs on every prompt in every session; it
writes the row and resolves the project in the background, updating `recent_dirs.git_root` when
the answer arrives. `recordCommand` reads only what the cache already holds, because it must be
synchronous, and by then the directory was almost always recorded moments earlier.

---

## 4. SQLite schema

WAL mode. Foreign keys on. Migrations are forward-only and tested from empty and from every prior
version.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_attached_at INTEGER NOT NULL,
  last_detached_at INTEGER,
  state TEXT NOT NULL,
  process_state TEXT NOT NULL,
  shell TEXT NOT NULL,
  command_json TEXT,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  pid INTEGER,
  foreground_process TEXT,
  exit_code INTEGER,
  signal TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  persistent INTEGER NOT NULL DEFAULT 0,
  cleanup_policy_id TEXT,
  title_fields_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT REFERENCES projects(id),
  git_root TEXT,
  ssh_host TEXT,
  attached_workspace_id TEXT REFERENCES workspaces(id),
  attached_pane_id TEXT,
  agent_state TEXT,
  agent_resume_id TEXT
);
CREATE INDEX idx_sessions_state    ON sessions(state);
CREATE INDEX idx_sessions_project  ON sessions(project_id);
CREATE INDEX idx_sessions_ws       ON sessions(attached_workspace_id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  title TEXT,
  project_id TEXT REFERENCES projects(id),
  chrome_tab_id INTEGER,
  chrome_window_id INTEGER,
  chrome_group_id INTEGER,
  layout_json TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_project ON workspaces(project_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  pinned INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER
);
CREATE INDEX idx_projects_last_opened ON projects(last_opened_at DESC);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  git_root TEXT,
  cwd TEXT NOT NULL,
  ssh_host TEXT,
  command TEXT NOT NULL,
  normalized TEXT NOT NULL,
  foreground TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  exit_code INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0,
  pasted INTEGER NOT NULL DEFAULT 0,
  from_saved_item_id TEXT,
  started_server INTEGER,
  launched_agent INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cmd_started    ON commands(started_at DESC);
CREATE INDEX idx_cmd_project    ON commands(project_id, started_at DESC);
CREATE INDEX idx_cmd_cwd        ON commands(cwd, started_at DESC);
CREATE INDEX idx_cmd_normalized ON commands(normalized);
CREATE INDEX idx_cmd_exit       ON commands(exit_code);
CREATE INDEX idx_cmd_host       ON commands(ssh_host, started_at DESC);
CREATE INDEX idx_cmd_duration   ON commands(duration_ms);

CREATE VIRTUAL TABLE commands_fts USING fts5(
  command, content='commands', content_rowid='rowid'
);

CREATE TABLE saved_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  cwd TEXT,
  placeholders_json TEXT,
  safe_to_run INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE saved_item_tags (
  item_id TEXT NOT NULL REFERENCES saved_items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX idx_tags_tag ON saved_item_tags(tag);

-- Decisions about project-local config, keyed by the bytes that were decided about.
-- Denials are stored too, so a repository cannot re-ask on every visit.
CREATE TABLE project_trust (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  decision TEXT NOT NULL,      -- 'trusted' | 'denied'
  decided_at INTEGER NOT NULL
);

-- Repository roots. Discovered by climbing from directories already known, never by scanning.
CREATE TABLE projects (
  root TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_recent ON projects(pinned DESC, last_opened_at DESC);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
```

Scrollback is **not** in SQLite. It lives in a capped in-memory ring per session, spilling to
`~/.local/state/tabterm/scrollback/<sessionId>` when it exceeds the cap. Putting megabytes of
terminal bytes in the database would make every history query slow and every backup enormous.

---

## 5. Workspace template schema

Declarative JSON, read from `.tabterm.json` or `.tabterm/workspace.json` in a project
directory. It **never executes anything by itself**: it describes a layout whose commands run
only when someone deliberately opens that workspace, after an explicit trust decision. See
`05-security.md` §5 for the trust model and for what is refused outright.

```json
{
  "name": "EEG workspace",
  "cwd": "analysis",
  "group": { "title": "EEG", "color": "blue" },
  "layout": {
    "direction": "horizontal",
    "ratio": 0.5,
    "children": [
      { "terminal": { "command": ["agent"] } },
      {
        "direction": "vertical",
        "ratio": 0.5,
        "children": [
          { "terminal": { "command": ["npm", "test", "--", "--watch"] } },
          { "terminal": { "command": ["npm", "run", "dev"] } }
        ]
      }
    ]
  }
}
```

`command` is always `string[]` argv. A string form is **rejected**, not split, so a template
can never smuggle shell metacharacters into an execution path.

`cwd` is resolved relative to the project directory and confined to it. A config cannot point
its commands at an unrelated part of the filesystem.

`color` is validated against Chrome's fixed tab-group enum, falling back to `blue`. Arbitrary
hex is not supported by Chrome. See `10-limitations.md` tier 1.5.

Limits, all of which reject the file rather than repairing it: 64 KB, 8 panes, 8 levels of
nesting, 32 arguments per command, 2000 bytes per argument, no null bytes. A `sessionId` in the
file is ignored rather than honored.

**Deliberately not supported.** `env` (a repository setting environment variables for spawned
processes is an execution surface with no upside), and any executable entry point. `delayMs`,
`cleanupPolicyId`, and `openUrls` are not implemented; a pane starts when the workspace opens,
and cleanup follows the normal policy in `04-session-lifecycle.md`.

---

## 6. History search

`daemon/src/history-query.ts` parses, `LauncherData.search` runs it.

**No user text ever reaches a SQL string.** The parser decides the column and the operator; every
value it extracts becomes a bound parameter. That is the property that makes accepting a query
language from a text box reasonable at all.

| Filter | Examples |
|---|---|
| `project:` / `repo:` | `project:tabterm` — matched on the repository name, since nobody types an absolute path |
| `cwd:` / `dir:` | `cwd:/w/app` — the directory and everything under it. Quote values with spaces |
| `exit:` | `exit:ok`, `exit:fail`, `exit:130` |
| `duration:` | `duration:>2s`, `duration:<500ms`, `duration:1m` (bare means at least) |
| `host:` | `host:build-box` — remote sessions only |
| `since:` / `before:` | `since:2d`, `before:1w` — resolved against a clock passed in, so it is deterministic |

Anything unrecognized stays in the free text rather than raising an error. A half-typed
`duration:` is someone mid-word, not a mistake.

**Scopes** — global, project, directory, session — are a click in the palette rather than syntax
to remember, and are resolved from the session the user is looking at, never from anything the
page asserts. A scope with no context to resolve against applies no filter, because silently
showing an empty history would be worse than showing everything.

**Filters run in SQL, free text runs in code.** Indexes cannot express a subsequence match,
which is what makes `gco` find `git checkout`, so the database narrows to a page-sized candidate
set and the fuzzy pass runs on that. If the page comes back short, one bounded wider read
follows. The table is never loaded wholesale.

Results page by `offset`; a short page is the last page. Measured on 100k rows in
`11-performance.md`.

---

## 7. Saved items

`daemon/src/launcher-data.ts` stores them; `shared/src/placeholders.ts` handles variables.

Five kinds — `command`, `template`, `note`, `prompt`, `workflow` — distinct because they are
*used* differently, not stored differently. A command is staged at a prompt, a note is read, a
prompt is meant for an agent. One undifferentiated "saved text" type would leave the UI guessing.

**Project items are returned alongside global ones, never instead of them.** Being inside a
repository adds to what you are offered and never takes anything away. Scope is resolved from
the session the user is in, not from anything the page asserts.

Tags live NUL-joined in one column. A join table is the textbook answer and buys nothing here:
nobody has thousands of tags, and this keeps a read to one row. Caps are enforced on write —
200 characters of title, 4000 of body, 12 tags of 40 characters each.

### Placeholder variables

`{{name}}` or `{{name:default}}`. A saved command is only worth keeping if it can be reused
somewhere slightly different, so `deploy {{env}}` asks rather than being copied and edited.

- **The prompt happens before the command goes anywhere.** A half-substituted command sitting
  at a terminal prompt is too easy to run by accident, so nothing leaves the palette until every
  name has a value or a default. A live preview shows what will be staged.
- **An unfilled name keeps its braces** rather than becoming an empty string. A command that
  looks complete and is not would be worse than an obviously unfinished one.
- **Values may not contain line breaks.** The result is staged at a prompt where Enter runs it,
  so a newline would turn one command into two. Everything else is left alone: quoting is the
  user's business in their own saved command, and mangling it would break real commands.
- Shell syntax is not a placeholder. `${HOME}` and `{a,b}` are left untouched.

Filling a template still only *stages* it. Running remains a separate, explicit action, per
`05-security.md` §4.

---

## 8. Command output archive

`daemon/src/output-archive.ts`. **Off by default, and the default is the point.** This stores
what commands *printed*, which is the most sensitive thing the product can hold: a token echoed
by a script, the contents of a file someone `cat`ed, an API response. Nobody should be opted
into that.

### What is captured

Only **OSC 133-delimited command output** — the region between "a command started" and "it
finished". Everything outside that boundary is dropped, which is what makes this a bounded
archive of command results rather than a transcript of a terminal.

**Alt-screen periods are skipped entirely.** `vim`, `less`, `htop` and every other full-screen
program redraw constantly; archiving them would capture megabytes of screen repaints that mean
nothing once the program exits. Enter and leave sequences (`1049`, `47`, `1047`) routinely
arrive in different chunks, so a chunk is split at the boundary rather than classified whole. A
command that was entirely full-screen stores nothing at all.

**Output from a command history would refuse to store is never archived.** The same secret rules
apply, and they matter more here: the output of an `export` is the value itself.

A command that printed nothing stores nothing — the command is already in history, and a row
here would only add disk.

### Bounds, and why there are two

256 KB per command, capped with a visible `[output truncated]` marker rather than silently.
Retention is **both** an age window (14 days) and a total ceiling (256 MB), because either alone
has a case it handles badly: age alone lets one noisy afternoon fill the disk, and size alone
throws away a quiet week that fit comfortably. Usage is reported, not discovered.

Turning the archive off drops anything mid-capture rather than writing it out on the next
command end.

---

## 9. Retention

| Data | Default retention | Mode: low | Mode: full |
|---|---|---|---|
| Live scrollback | 10,000 lines | 5,000 | 50,000 |
| Detached session process | Policy per `04-session-lifecycle.md` | 3 min | policy |
| Command records | 180 days | 30 days | forever |
| Command output archive | **Off** | off | on, 14 days |
| Saved items and notes | Forever | forever | forever |
| Expired session metadata | 7 days | 2 days | 30 days |
| Logs | 7 days, rotated | 3 days | 30 days |

Nothing syncs off the machine. Ever. There is no remote endpoint in the codebase.


---

## Scrollback files

`~/.local/state/tabterm/scrollback/<session>.log`, one per session, owner-readable only.

Not in SQLite deliberately. This is an append-only byte stream with no queries run against it,
and putting it in the database would mean a write amplification on every keystroke of output for
a lookup nobody performs. It is also the thing most worth being able to delete by removing a
file. See `07-terminal-fidelity.md`.
