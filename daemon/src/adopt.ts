import type { LayoutNode } from '@tabterm/shared';
import type { Database } from './database.js';
import { info, warn } from './log.js';

/**
 * Taking over sessions that were already running when this daemon started.
 *
 * The PTY host keeps processes alive across a daemon restart, which is only half the promise.
 * The other half is that a tab reconnects to the same terminal rather than being told it
 * expired, and that needs the metadata the host does not have and should not: which directory a
 * session belongs to, which workspace it is a pane of, and how that workspace was laid out.
 *
 * All of it is already on disk, written during normal operation. Adoption is a read.
 * See docs/adr/0017 and docs/04-session-lifecycle.md.
 */

export interface AdoptableSession {
  sessionId: string;
  pid: number;
  cwd: string;
  seq: number;
}

export interface AdoptionPlan {
  sessions: {
    sessionId: string;
    pid: number;
    cwd: string;
    shell: string;
    command?: readonly string[];
    workspaceId?: string;
  }[];
  workspaces: { id: string; layout: LayoutNode }[];
}

/**
 * Work out what can be taken over, from what the host has and what the database remembers.
 *
 * A session the database has never heard of is still adopted, with the host's own idea of its
 * directory. Losing a running process because a metadata row is missing would be a poor trade,
 * and a terminal with a slightly wrong title is still a terminal.
 */
export function planAdoption(
  live: readonly AdoptableSession[],
  db: Database,
  defaultShell: string,
): AdoptionPlan {
  if (live.length === 0) return { sessions: [], workspaces: [] };

  const plan: AdoptionPlan = { sessions: [], workspaces: [] };
  const wanted = new Set<string>();

  for (const session of live) {
    const row = db.handle
      .prepare('SELECT workspace_id, cwd, shell, command_json FROM session_meta WHERE id = ?')
      .get(session.sessionId) as
      | { workspace_id: string | null; cwd: string; shell: string; command_json: string | null }
      | undefined;

    let command: readonly string[] | undefined;
    if (row?.command_json) {
      try {
        const parsed: unknown = JSON.parse(row.command_json);
        if (Array.isArray(parsed)) command = parsed as string[];
      } catch {
        // A row we cannot read is not a reason to drop a running process.
      }
    }

    plan.sessions.push({
      sessionId: session.sessionId,
      pid: session.pid,
      cwd: row?.cwd ?? session.cwd,
      shell: row?.shell ?? defaultShell,
      ...(command ? { command } : {}),
      ...(row?.workspace_id ? { workspaceId: row.workspace_id } : {}),
    });
    if (row?.workspace_id) wanted.add(row.workspace_id);
  }

  for (const id of wanted) {
    const row = db.handle.prepare('SELECT layout_json FROM workspaces WHERE id = ?').get(id) as
      { layout_json: string } | undefined;
    if (!row) continue;
    try {
      plan.workspaces.push({ id, layout: JSON.parse(row.layout_json) as LayoutNode });
    } catch {
      warn('adopt.layout-unreadable', { workspaceId: id });
    }
  }

  info('adopt.planned', { sessions: plan.sessions.length, workspaces: plan.workspaces.length });
  return plan;
}

/**
 * Panes in a layout whose session is not among those still running.
 *
 * A workspace can be adopted with some panes alive and some gone, which happens whenever one
 * pane's shell exited before the restart. Those panes are dropped rather than restored as dead
 * ones, because a pane that can never produce output is worse than an absent pane.
 */
export function prunePanes(layout: LayoutNode, alive: ReadonlySet<string>): LayoutNode | null {
  if (layout.type === 'terminal') return alive.has(layout.sessionId) ? layout : null;
  const first = prunePanes(layout.children[0], alive);
  const second = prunePanes(layout.children[1], alive);
  if (first && second) return { ...layout, children: [first, second] };
  return first ?? second;
}
