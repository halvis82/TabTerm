/**
 * Domain types shared by the daemon and the extension.
 *
 * The daemon is the authority for all of this. The extension holds copies that may be stale
 * at any moment. See docs/03-data-model.md.
 */

export type SessionState =
  /** PTY spawned, first output not yet seen. */
  | 'starting'
  /** One or more frontends connected. */
  | 'attached'
  /** Live, no frontend, not yet expiring. */
  | 'detached'
  /** Grace period running, reap scheduled. */
  | 'expiring'
  /** Child process ended, metadata retained briefly. */
  | 'exited'
  /** Gone. Row retained for history only. */
  | 'reaped';

export type ProcessState = 'idle' | 'running' | 'waiting' | 'approval' | 'failed' | 'exited';

/** State of an agent CLI running in a session, derived from its hooks. See docs/09-agent-integration.md. */
export type AgentState = 'starting' | 'working' | 'waiting' | 'approval' | 'idle' | 'failed';

/**
 * Structured title inputs.
 *
 * The daemon never produces a display string. A shell emitting a hostile OSC title cannot
 * inject formatting or markup into a tab title, because the frontend composes from known
 * fields. See docs/05-security.md.
 */
export interface TitleFields {
  cwd?: string;
  repo?: string;
  process?: string;
  file?: string;
  sshHost?: string;
  custom?: string;
  status?: string;
}

export interface TerminalSession {
  id: string;
  createdAt: number;
  lastAttachedAt: number;
  lastDetachedAt?: number;

  state: SessionState;
  processState: ProcessState;

  shell: string;
  /** argv, never a shell string. See docs/05-security.md. */
  command?: readonly string[];
  cwd: string;

  /** Last applied size. Equals the minimum across attached clients. */
  cols: number;
  rows: number;

  pid?: number;
  foregroundProcess?: string;
  exitCode?: number;
  signal?: string;

  pinned: boolean;
  persistent: boolean;
  cleanupPolicyId?: string;

  titleFields: TitleFields;
  projectId?: string;
  gitRoot?: string;
  sshHost?: string;

  /** Mirrored views and multi-profile attachment. See docs/04-session-lifecycle.md. */
  attachedClientIds: readonly string[];
  /** Set when this session is a pane inside a workspace rather than a standalone tab. */
  attachedWorkspaceId?: string;
  attachedPaneId?: string;

  agentState?: AgentState;
  agentResumeId?: string;
}

export type SplitDirection = 'horizontal' | 'vertical';

export type LayoutNode =
  | { type: 'terminal'; paneId: string; sessionId: string }
  | {
      type: 'split';
      direction: SplitDirection;
      /** Fraction of the parent occupied by children[0]. Bounded by RATIO_MIN and RATIO_MAX. */
      ratio: number;
      children: readonly [LayoutNode, LayoutNode];
    };

export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.95;

/**
 * A standalone terminal tab is a workspace with one pane. There is no separate single-terminal
 * concept, which is what makes merge and detach symmetric rather than special cases.
 */
export interface Workspace {
  id: string;
  title?: string;
  projectId?: string;

  /** Advisory. Stale after a Chrome restart. */
  chromeTabId?: number;
  chromeWindowId?: number;
  chromeGroupId?: number;

  layout: LayoutNode;

  /** Default true. Workspaces are never reaped on a timer. See ADR-0012. */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CommandRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  gitRoot?: string;
  cwd: string;
  sshHost?: string;

  command: string;
  /** Normalized form, for dedup and frequency. */
  normalized: string;
  foreground?: string;

  startedAt: number;
  completedAt?: number;
  durationMs?: number;

  exitCode?: number;
  interrupted: boolean;

  pasted: boolean;
  fromSavedItemId?: string;
  /** Port, when this command started a listening server. */
  startedServer?: number;
  launchedAgent: boolean;

  /** True when any part was scrubbed by the redaction pipeline. */
  redacted: boolean;
}

export interface Project {
  id: string;
  name: string;
  root: string;
  pinned: boolean;
  lastOpenedAt?: number;
  workspaceTemplateIds: readonly string[];
}

/** Serialized screen state, the payload that makes reattach exact. See docs/07-terminal-fidelity.md. */
export interface SessionSnapshot {
  sessionId: string;
  streamId: number;
  /** Output sequence number the live stream resumes from. No gap, no duplication. */
  seq: number;
  cols: number;
  rows: number;
  /** Opaque to the extension. Produced and consumed by the terminal emulator serializer. */
  screen: string;
  scrollback: string;
  altScreen: boolean;
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

export interface RecentDir {
  path: string;
  name: string;
  lastUsedAt: number;
  useCount: number;
  pinned: boolean;
  /** The repository this directory sits in, when it sits in one. */
  project?: { root: string; name: string };
}

export interface CommandEntry {
  id: string;
  command: string;
  cwd: string;
  lastUsedAt: number;
  useCount: number;
  exitCode?: number;
  durationMs?: number;
  /** The repository it was run in, when it was run in one. */
  gitRoot?: string;
}

export interface SavedItem {
  id: string;
  title: string;
  body: string;
  tags: readonly string[];
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

/** A plugin the launcher can offer. None exist yet; the list is empty and renders nothing. */
export interface LauncherPlugin {
  id: string;
  title: string;
  description?: string;
}

export interface LauncherState {
  recentDirs: readonly RecentDir[];
  saved: readonly SavedItem[];
  plugins: readonly LauncherPlugin[];
  home: string;
}
