/**
 * Wire protocol between the extension and the daemon.
 *
 * Terminal bytes travel in binary frames, never base64 and never JSON-escaped. Base64 would
 * inflate high-throughput output by a third for nothing, and JSON escaping of arbitrary bytes
 * is a correctness trap. See docs/02-protocol.md.
 *
 * Every decode path treats its input as hostile. A malformed frame produces a ProtocolError,
 * never a partially populated object and never a throw from deep inside a parser.
 */

import type {
  AgentState,
  CommandEntry,
  LauncherState,
  LayoutNode,
  ProcessState,
  SavedItem,
  SessionSnapshot,
  SavedKind,
  TitleFields,
  LiveSession,
  LayoutShape,
  NotifyPolicy,
  AgentHooksStatus,
  ShellIntegrationStatus,
} from './model.js';

export const PROTOCOL_VERSION = 1;

/** Frames larger than this are rejected before allocation. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Auth must arrive within this window or the connection is closed. See docs/05-security.md. */
export const AUTH_TIMEOUT_MS = 2000;

export const CLOSE_POLICY_VIOLATION = 1008;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const FrameType = {
  Control: 0x00,
  Output: 0x01,
  Input: 0x02,
  Ack: 0x03,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export type Frame =
  | { kind: 'control'; message: ControlMessage }
  | { kind: 'output'; streamId: number; data: Uint8Array }
  | { kind: 'input'; streamId: number; data: Uint8Array }
  | { kind: 'ack'; streamId: number; bytesConsumed: number };

const HEADER = 1;
const U32 = 4;
const MAX_U32 = 0xffffffff;

export type ProtocolErrorCode =
  | 'frame-empty'
  | 'frame-too-large'
  | 'frame-truncated'
  | 'frame-unknown-type'
  | 'control-not-json'
  | 'control-not-object'
  | 'control-missing-type'
  | 'value-out-of-range';

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function assertU32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new ProtocolError('value-out-of-range', `${what} must be a uint32, got ${String(value)}`);
  }
}

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.kind) {
    case 'control': {
      const json = encoder.encode(JSON.stringify(frame.message));
      const out = new Uint8Array(HEADER + json.length);
      out[0] = FrameType.Control;
      out.set(json, HEADER);
      return guardSize(out);
    }
    case 'output':
    case 'input': {
      assertU32(frame.streamId, 'streamId');
      const out = new Uint8Array(HEADER + U32 + frame.data.length);
      out[0] = frame.kind === 'output' ? FrameType.Output : FrameType.Input;
      new DataView(out.buffer).setUint32(HEADER, frame.streamId, false);
      out.set(frame.data, HEADER + U32);
      return guardSize(out);
    }
    case 'ack': {
      assertU32(frame.streamId, 'streamId');
      assertU32(frame.bytesConsumed, 'bytesConsumed');
      const out = new Uint8Array(HEADER + U32 + U32);
      const view = new DataView(out.buffer);
      out[0] = FrameType.Ack;
      view.setUint32(HEADER, frame.streamId, false);
      view.setUint32(HEADER + U32, frame.bytesConsumed, false);
      return out;
    }
  }
}

function guardSize(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      'frame-too-large',
      `frame of ${String(bytes.length)} bytes exceeds cap`,
    );
  }
  return bytes;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length === 0) {
    throw new ProtocolError('frame-empty', 'empty frame');
  }
  if (bytes.length > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      'frame-too-large',
      `frame of ${String(bytes.length)} bytes exceeds cap`,
    );
  }

  // Non-empty was checked above, so index 0 exists. The coalesce keeps the type a plain
  // number rather than a union the exhaustiveness checker would want an undefined arm for.
  const type: number = bytes[0] ?? -1;
  switch (type) {
    case FrameType.Control:
      return { kind: 'control', message: decodeControl(bytes.subarray(HEADER)) };

    case FrameType.Output:
    case FrameType.Input: {
      if (bytes.length < HEADER + U32) {
        throw new ProtocolError('frame-truncated', 'stream frame shorter than its header');
      }
      const streamId = readU32(bytes, HEADER);
      // Copy rather than alias: the caller must not be able to observe later mutation of a
      // reused socket buffer.
      const data = bytes.slice(HEADER + U32);
      return type === FrameType.Output
        ? { kind: 'output', streamId, data }
        : { kind: 'input', streamId, data };
    }

    case FrameType.Ack: {
      if (bytes.length < HEADER + U32 + U32) {
        throw new ProtocolError('frame-truncated', 'ack frame shorter than its header');
      }
      return {
        kind: 'ack',
        streamId: readU32(bytes, HEADER),
        bytesConsumed: readU32(bytes, HEADER + U32),
      };
    }

    default:
      throw new ProtocolError('frame-unknown-type', `unknown frame type ${String(type)}`);
  }
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function decodeControl(payload: Uint8Array): ControlMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    throw new ProtocolError('control-not-json', 'control frame payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('control-not-object', 'control frame payload is not an object');
  }
  if (typeof (parsed as { t?: unknown }).t !== 'string') {
    throw new ProtocolError('control-missing-type', 'control message has no string "t" field');
  }
  return parsed as ControlMessage;
}

// ---------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------

/**
 * A data connection serves one page and multiplexes its panes. A control connection serves
 * one Chrome profile and carries state, notifications, and tab actions.
 * See docs/01-architecture.md.
 */
export type ConnectionRole = 'control' | 'data';

export interface AuthMessage {
  t: 'auth';
  v: number;
  role: ConnectionRole;
  token: string;
  /** Stable per Chrome profile. Identifies a client, not a session. */
  clientId: string;
}

export type ClientMessage =
  | AuthMessage
  | { t: 'create-session'; cwd?: string; command?: readonly string[]; cols: number; rows: number }
  | { t: 'attach'; sessionId?: string; workspaceId?: string; cols: number; rows: number }
  | { t: 'detach'; sessionId: string }
  | { t: 'resize'; sessionId: string; cols: number; rows: number }
  | { t: 'request-scrollback'; sessionId: string; beforeSeq: number; maxLines: number }
  | { t: 'kill-session'; sessionId: string }
  | { t: 'set-pin'; sessionId?: string; workspaceId?: string; pinned: boolean }
  | { t: 'set-persistence'; sessionId: string; policyId?: string }
  | { t: 'attach-workspace'; workspaceId: string; cols: number; rows: number }
  | {
      t: 'split-pane';
      workspaceId: string;
      paneId: string;
      direction: 'horizontal' | 'vertical';
      cwd?: string;
      command?: readonly string[];
      cols: number;
      rows: number;
    }
  | { t: 'close-pane'; workspaceId: string; paneId: string }
  | {
      /** Move an existing session into this workspace as a new pane beside a target. */
      t: 'merge-into';
      workspaceId: string;
      targetPaneId: string;
      sessionId: string;
      direction: 'horizontal' | 'vertical';
    }
  | { t: 'detach-pane-to-tab'; workspaceId: string; paneId: string }
  | { t: 'list-mergeable'; workspaceId: string }
  | {
      /** Name a pane, or clear the name by sending an empty label. */
      t: 'set-pane-label';
      workspaceId: string;
      paneId: string;
      label: string;
      color?: string;
    }
  | { t: 'set-ratio'; workspaceId: string; paneId: string; ratio: number }
  | { t: 'swap-panes'; workspaceId: string; a: string; b: string }
  | { t: 'resize-pane'; workspaceId: string; paneId: string; cols: number; rows: number }
  | {
      t: 'merge-session';
      sessionId: string;
      workspaceId: string;
      targetPaneId: string;
      direction: 'horizontal' | 'vertical';
    }
  | { t: 'detach-pane'; workspaceId: string; paneId: string }
  | { t: 'resolve-paths'; sessionId: string; candidates: readonly string[] }
  | { t: 'open-path'; sessionId: string; path: string; how: OpenHow }
  | { t: 'open-path-result'; ok: boolean }
  | {
      /** Launch an agent CLI, in a new tab or beside the current pane. */
      t: 'launch-agent';
      where: 'new-tab' | 'split';
      workspaceId?: string;
      paneId?: string;
      cwd?: string;
      cols: number;
      rows: number;
    }
  | { t: 'list-launcher' }
  | { t: 'recall-workspace'; workspaceId: string }
  | {
      t: 'list-history';
      query?: string;
      /** Applied on top of the query. The daemon supplies the context from the session. */
      scope?: HistoryScope;
      /** Which session's project and directory a scope resolves against. */
      sessionId?: string;
      limit?: number;
      offset?: number;
    }
  | {
      t: 'save-item';
      kind?: SavedKind;
      title: string;
      body: string;
      tags?: readonly string[];
      /** Scopes the item to one repository. The daemon resolves it from the session. */
      scopeToProject?: boolean;
      sessionId?: string;
    }
  | { t: 'pin-saved'; id: string; pinned: boolean }
  | {
      /** Edit a favorite. Omitted fields are left alone; a null hotstring clears it. */
      t: 'update-saved';
      id: string;
      title?: string;
      body?: string;
      hotstring?: string | null;
    }
  | { t: 'delete-saved'; id: string }
  | { t: 'use-saved'; id: string }
  | { t: 'clear-history' }
  | { t: 'pin-dir'; path: string; pinned: boolean }
  | { t: 'forget-dir'; path: string }
  | {
      /** Build a workspace of N panes in one directory, creating it if asked. */
      t: 'create-layout';
      path: string;
      panes: number;
      direction: 'horizontal' | 'vertical';
      /**
       * The arrangement, when it is not a simple row or column.
       *
       * `panes` and `direction` alone can only describe splitting the same way repeatedly, which
       * cannot express one pane beside two stacked ones, or four in the corners. Absent means the
       * old behavior, so nothing that already worked has to change.
       */
      shape?: LayoutShape;
      createIfMissing: boolean;
      cols: number;
      rows: number;
    }
  // Project-local config. Discovery is separate from acting on it, and trust is answered by a
  // person for specific content. See docs/05-security.md §5.
  | { t: 'inspect-project'; cwd: string }
  | { t: 'decide-project-trust'; path: string; contentHash: string; decision: 'trusted' | 'denied' }
  | { t: 'launch-project-template'; cwd: string; cols: number; rows: number }
  // Agent sessions that could be resumed. Listing is not resuming: the daemon reports what
  // exists and a person decides. See docs/09-agent-integration.md.
  | { t: 'list-resumable'; cwd?: string; limit?: number }
  | { t: 'resume-agent'; sessionId: string; cwd: string; cols: number; rows: number }
  // Local servers. Discovery runs when someone asks, and on the command-start event, never
  // on a timer. See docs/11-performance.md §6.
  | { t: 'list-servers' }
  | {
      /** Interrupt whatever is listening, the way a person would. Confirmed in the UI first. */
      t: 'stop-server';
      sessionId: string;
      /** Send the recorded start command again once it has stopped. */
      restart?: boolean;
    }
  | { t: 'set-memory-mode'; mode: MemoryModeName }
  | { t: 'get-memory-mode' }
  // Completion notifications, and the agent CLI hooks that make agent turns visible at all.
  // See docs/06-chrome-integration.md and docs/09-agent-integration.md.
  | { t: 'get-notify-policy' }
  | { t: 'set-notify-policy'; policy: Partial<NotifyPolicy> }
  /**
   * Throw away this session's scrollback everywhere it is kept.
   *
   * Not the same as the terminal's own clear sequence, which only affects the screen in one tab.
   * This drops the daemon's copy, the PTY host's buffer and the saved snapshot, which is what
   * has to happen for clearing to mean anything. See docs/07-terminal-fidelity.md.
   */
  | { t: 'clear-scrollback'; sessionId: string }
  /** How much output to keep per session, in bytes, across every copy of it. */
  | { t: 'set-scrollback-budget'; bytes: number }
  | { t: 'get-scrollback-budget' }
  /**
   * How long a session with no tab is kept, in seconds, or null to keep it forever.
   *
   * A pane used to be kept indefinitely, which was safe while a daemon restart ended everything
   * anyway. See docs/adr/0012.
   */
  | { t: 'set-background-timeout'; seconds: number | null }
  | { t: 'get-background-timeout' }
  /** Every session the daemon holds, with enough of its screen to recognize it. */
  | { t: 'list-live-sessions' }
  /**
   * Complete a directory path, the way a shell would.
   *
   * Answered by the daemon reading the filesystem, because the extension cannot: a browser page
   * has no view of the disk, and asking a real shell would mean running something to find out
   * what somebody is about to type.
   */
  | { t: 'complete-path'; partial: string }
  /**
   * End everything and start clean.
   *
   * For the case where something has gone wrong in a way nobody wants to diagnose. Destructive
   * on purpose, so it is only ever sent after the user has confirmed it, and the daemon reports
   * what it did rather than assuming. See docs/04-session-lifecycle.md.
   */
  | { t: 'reset-everything'; restartDaemon: boolean }
  | { t: 'get-agent-hooks' }
  | { t: 'set-agent-hooks'; enabled: boolean }
  // Sourcing the shell integration, without which there are no exit codes at all.
  | { t: 'get-shell-integration' }
  | { t: 'set-shell-integration'; enabled: boolean }
  // Reboot restore. Processes cannot survive a restart; layout and context can.
  // See docs/04-session-lifecycle.md §11.
  | { t: 'list-restorable' }
  | {
      t: 'restore-workspace';
      workspaceId: string;
      /** Opt-in per restore. Off means the panes come back as plain shells in place. */
      replayCommands: boolean;
      cols: number;
      rows: number;
    }
  | { t: 'forget-restorable'; workspaceId: string }
  // Command output archive. Off by default; see docs/03-data-model.md.
  | { t: 'get-archive-status' }
  | { t: 'set-archive-enabled'; enabled: boolean }
  | { t: 'search-output'; query?: string; command?: string; limit?: number }
  | { t: 'clear-output-archive' }
  | { t: 'list-sessions' }
  | { t: 'list-workspaces' }
  | { t: 'subscribe'; topics: readonly string[] };

/** What to do with a resolved path. Each maps to a specific structured spawn, never a shell string. */
/**
 * What to do with a path the user clicked.
 *
 * Each maps to one specific structured spawn. The frontend chooses by modifier; the daemon
 * decides what that means, because only the daemon can see the filesystem.
 */
export type MemoryModeName = 'low' | 'balanced' | 'full';

export type HistoryScope = 'global' | 'project' | 'directory' | 'session';

export type OpenHow = 'default-app' | 'reveal-in-finder' | 'editor' | 'gui-editor' | 'new-terminal';

/** A pane, paired with the stream that carries its terminal output. */
export interface WorkspacePane {
  paneId: string;
  sessionId: string;
  streamId: number;
}

/** A session in another tab that could be pulled into this workspace. */
export interface MergeableSession {
  sessionId: string;
  workspaceId: string;
  title: string;
  cwd: string;
  paneCount: number;
  /**
   * A tab is showing this session right now.
   *
   * Taking it moves it, because a session lives in exactly one workspace, so the tab it came
   * from is left with nothing. Knowing which ones those are is what lets the interface say so
   * before doing it rather than afterwards.
   */
  attached: boolean;
  /** Something has actually been run in it, so an untouched shell can be told apart. */
  hasRun: boolean;
}

export interface ResolvedPath {
  /** Exactly the text that appeared in the terminal, so the frontend can match it back. */
  candidate: string;
  absolute: string;
  exists: boolean;
  isDirectory: boolean;
  line?: number;
  column?: number;
}

export type ServerErrorCode =
  | 'auth-required'
  | 'auth-failed'
  | 'version-unsupported'
  | 'session-not-found'
  | 'session-expired'
  | 'session-attached-elsewhere'
  | 'workspace-invalid-layout'
  | 'path-not-found'
  | 'not-trusted'
  | 'rate-limited'
  | 'internal';

export type ServerMessage =
  | { t: 'auth-ok'; serverVersion: string; sessionCount: number }
  | { t: 'auth-fail'; code: ServerErrorCode }
  | { t: 'session-created'; sessionId: string; streamId: number; pid: number; workspaceId: string }
  | { t: 'snapshot'; snapshot: SessionSnapshot }
  | { t: 'cwd'; sessionId: string; cwd: string; gitRoot?: string }
  | { t: 'title'; sessionId: string; fields: TitleFields }
  | { t: 'process-state'; sessionId: string; state: ProcessState; foreground?: string }
  | {
      t: 'command-start';
      sessionId: string;
      commandId: string;
      command: string;
      cwd: string;
      startedAt: number;
    }
  | {
      t: 'command-end';
      sessionId: string;
      commandId: string;
      /**
       * Absent when nobody could tell.
       *
       * Without shell integration the OS reports no exit code for a process that is already
       * gone, and a guessed zero would make "it succeeded" a claim nothing supports. See
       * docs/08-shell-integration.md.
       */
      exitCode?: number;
      completedAt: number;
      interrupted: boolean;
    }
  | { t: 'agent-state'; sessionId: string; state: AgentState; detail?: string }
  | { t: 'session-exited'; sessionId: string; exitCode: number; signal?: string }
  | { t: 'session-detached'; sessionId: string; remainingClients: number }
  | { t: 'session-expiring'; sessionId: string; expiresAt: number; reason: string }
  | { t: 'session-expired'; sessionId: string }
  | { t: 'workspace-updated'; workspaceId: string; layout: LayoutNode }
  | {
      t: 'workspace-attached';
      workspaceId: string;
      layout: LayoutNode;
      /** One entry per pane, in the order the frontend should restore them. */
      panes: readonly WorkspacePane[];
    }
  | { t: 'server-detected'; sessionId: string; port: number }
  | { t: 'paths-resolved'; sessionId: string; cwd: string; results: readonly ResolvedPath[] }
  | { t: 'launcher-state'; state: LauncherState }
  | {
      t: 'history-page';
      entries: readonly CommandEntry[];
      offset: number;
      /** False when the page came back short, which is how the UI knows to stop asking. */
      hasMore: boolean;
      /** What was actually applied, so the UI can show it rather than guess. */
      appliedFilters: readonly string[];
      scope: HistoryScope;
    }
  | { t: 'saved-updated'; saved: readonly SavedItem[] }
  | { t: 'save-rejected'; id: string; reason: string }
  | {
      /**
       * Something that must reach the user even with no terminal tab on screen.
       *
       * Delivered on the control connection, because the offscreen document is the only
       * context that survives both a hidden tab and a discarded one.
       */
      t: 'notify';
      priority: 'critical' | 'important' | 'low';
      title: string;
      body: string;
      target?: { workspaceId?: string; paneId?: string };
      /**
       * Drop it if the pane is already on screen.
       *
       * Decided by the receiver rather than here, because only the extension can see which tab
       * is active in which focused window. The daemon knows what happened, not who is watching.
       */
      suppressIfVisible?: boolean;
    }
  | { t: 'notify-policy'; policy: NotifyPolicy }
  | { t: 'agent-hooks'; status: AgentHooksStatus }
  | { t: 'scrollback-budget'; bytes: number }
  | { t: 'background-timeout'; seconds: number | null }
  | { t: 'live-sessions'; sessions: readonly LiveSession[] }
  | {
      t: 'path-completion';
      /** Echoed back, so a stale answer to an earlier keystroke can be ignored. */
      partial: string;
      /** The longest common prefix of every match, which is what Tab fills in. */
      completed: string;
      /** Every match, for showing when Tab cannot decide. Bounded. */
      matches: readonly string[];
    }
  | { t: 'reset-done'; sessionsEnded: number; historyFilesRemoved: number; restarting: boolean }
  | { t: 'shell-integration'; status: ShellIntegrationStatus }
  | {
      /** What a tab can offer after its session is gone. */
      t: 'workspace-recall';
      workspaceId: string;
      found: boolean;
      cwd?: string;
      lastCommand?: string;
      lastSeenAt?: number;
      /**
       * The last lines this session printed, from the history on disk.
       *
       * A tab whose processes are gone can at least still show what happened in it. Without
       * this the history is written, bounded and pruned, and never seen by anybody.
       */
      lastScreen?: readonly string[];
    }
  | { t: 'mergeable-sessions'; sessions: readonly MergeableSession[] }
  | {
      /**
       * A workspace's last session was taken into another one.
       *
       * Distinct from expiry, which is what this used to be reported as. Nothing ended: the
       * session is alive and somewhere else, and the tab that used to show it has nothing left.
       * Saying "this expired" there is untrue and offers to restore something that moved.
       */
      t: 'workspace-taken-over';
      workspaceId: string;
      sessionId: string;
    }
  | {
      /** A pane left this workspace. The frontend opens a tab at this URL to pick it up. */
      t: 'pane-detached';
      workspaceId: string;
      newWorkspaceId: string;
    }
  | {
      t: 'project-config';
      cwd: string;
      /** Null when the directory has no config, or has one that was refused outright. */
      config: ProjectConfigInfo | null;
    }
  | {
      t: 'memory-mode';
      mode: MemoryModeName;
      /** The part of the mode the daemon cannot enforce, applied by the page. */
      rendererUnloadMs: number;
      faviconWhileHidden: boolean;
      scrollbackLines: number;
    }
  | {
      t: 'archive-status';
      enabled: boolean;
      rows: number;
      bytes: number;
    }
  | { t: 'output-results'; results: readonly ArchivedOutputSummary[] }
  | { t: 'restorable-workspaces'; workspaces: readonly RestorableSummary[] }
  | { t: 'server-list'; servers: readonly LocalServer[] }
  | { t: 'resumable-sessions'; sessions: readonly ResumableAgentSession[] }
  | { t: 'error'; code: ServerErrorCode; message: string; context?: string };

/** A workspace that could be brought back, as presented before anyone decides to. */
export interface RestorableSummary {
  workspaceId: string;
  paneCount: number;
  savedAt: number;
  /** One entry per pane, in layout order. */
  panes: readonly {
    cwd: string;
    lastCommand?: string;
    /** True when the pane ran an explicit command rather than a shell. */
    hadCommand: boolean;
  }[];
}

/** One archived command's output, as offered to the UI. */
export interface ArchivedOutputSummary {
  id: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  bytes: number;
  /** Head of the output. The full text is fetched only when someone opens it. */
  preview: string;
}

export interface LocalServer {
  sessionId: string;
  workspaceId?: string;
  port: number;
  cwd: string;
  /** The command that appears to be serving, when it is known. */
  command?: string;
  startedAt?: number;
}

export interface ResumableAgentSession {
  sessionId: string;
  cwd: string;
  modifiedAt: number;
  /** First words of what the user asked. A label only, absent when it cannot be read. */
  summary?: string;
}

/**
 * A project config as presented to the user before they decide about it.
 *
 * The commands are sent verbatim so the approval prompt can show exactly what would run.
 * Summarizing them would mean approving something other than what was displayed.
 */
export interface ProjectConfigInfo {
  path: string;
  contentHash: string;
  name: string;
  paneCount: number;
  commands: readonly (readonly string[])[];
  action: 'offer' | 'ask' | 'ignore';
  /** Set when the file changed after a previous decision. */
  changedSince?: 'trusted' | 'denied';
}

export type ControlMessage = ClientMessage | ServerMessage;

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export function controlFrame(message: ControlMessage): Uint8Array {
  return encodeFrame({ kind: 'control', message });
}

export function outputFrame(streamId: number, data: Uint8Array): Uint8Array {
  return encodeFrame({ kind: 'output', streamId, data });
}

export function inputFrame(streamId: number, data: Uint8Array): Uint8Array {
  return encodeFrame({ kind: 'input', streamId, data });
}

export function ackFrame(streamId: number, bytesConsumed: number): Uint8Array {
  return encodeFrame({ kind: 'ack', streamId, bytesConsumed });
}
