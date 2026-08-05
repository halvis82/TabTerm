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
  TitleFields,
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
  | { t: 'list-history'; query?: string; limit?: number }
  | { t: 'save-item'; title: string; body: string; tags?: readonly string[] }
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
      createIfMissing: boolean;
      cols: number;
      rows: number;
    }
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
      exitCode: number;
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
  | { t: 'history-page'; entries: readonly CommandEntry[] }
  | { t: 'saved-updated'; saved: readonly SavedItem[] }
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
    }
  | {
      /** What a tab can offer after its session is gone. */
      t: 'workspace-recall';
      workspaceId: string;
      found: boolean;
      cwd?: string;
      lastCommand?: string;
      lastSeenAt?: number;
    }
  | { t: 'mergeable-sessions'; sessions: readonly MergeableSession[] }
  | {
      /** A pane left this workspace. The frontend opens a tab at this URL to pick it up. */
      t: 'pane-detached';
      workspaceId: string;
      newWorkspaceId: string;
    }
  | { t: 'error'; code: ServerErrorCode; message: string; context?: string };

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
