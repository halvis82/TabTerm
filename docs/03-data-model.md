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
  id: string;
  name: string;
  root: string;
  pinned: boolean;
  lastOpenedAt?: number;
  workspaceTemplateIds: string[];
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

## 6. Retention

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
