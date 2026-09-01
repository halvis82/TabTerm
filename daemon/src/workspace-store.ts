import { randomUUID } from 'node:crypto';
import type { LayoutNode, SplitDirection, Workspace } from '@tabterm/shared';
import {
  cleanLabelColor,
  cleanPaneLabel,
  closePane,
  insertPane,
  panes,
  setRatio,
  splitPane,
  swapPanes,
  terminalNode,
} from '@tabterm/shared';
import { info } from './log.js';

/**
 * Workspaces, which are the thing a Chrome tab actually addresses.
 *
 * A standalone terminal tab is a workspace with one pane. There is no separate single-terminal
 * concept, which is what makes merge and detach symmetric operations on one model rather than
 * special cases. See docs/03-data-model.md §2.
 *
 * Workspaces are pinned by default: closing a tab must never destroy a layout the user built.
 * See ADR-0012.
 */
export class WorkspaceStore {
  readonly #workspaces = new Map<string, Workspace>();
  #onChange: (workspace: Workspace) => void = () => {};

  /**
   * Called whenever a workspace comes into existence.
   *
   * Layout changes were already persisted, but creation was not, so a workspace with one pane
   * that never got split existed only in memory until shutdown. If the daemon was killed rather
   * than stopped, it was gone, and a tab whose processes were still running was told its session
   * had expired. State that is only written on a clean exit is not persisted state.
   */
  onCreate(fn: (workspace: Workspace) => void): void {
    this.#onChange = fn;
  }

  get all(): Workspace[] {
    return [...this.#workspaces.values()];
  }

  get(id: string): Workspace | undefined {
    return this.#workspaces.get(id);
  }

  /**
   * Put back a workspace that existed before this daemon started.
   *
   * Workspaces live in memory during normal operation and are written to the database as they
   * change, so a restart has everything it needs to rebuild them. Without this, a tab whose
   * processes are still running would still be told its session expired, because the daemon
   * would not know which sessions the workspace was made of. See daemon/src/adopt.ts.
   */
  hydrate(workspace: Workspace): void {
    this.#workspaces.set(workspace.id, workspace);
  }

  #announce(workspace: Workspace): Workspace {
    this.#onChange(workspace);
    return workspace;
  }

  create(sessionId: string): { workspace: Workspace; paneId: string } {
    const paneId = randomUUID();
    const now = Date.now();
    const workspace: Workspace = {
      id: randomUUID(),
      layout: terminalNode(paneId, sessionId),
      pinned: true,
      createdAt: now,
      updatedAt: now,
    };
    this.#workspaces.set(workspace.id, workspace);
    info('workspace.created', { workspaceId: workspace.id, sessionId });
    this.#announce(workspace);
    return { workspace, paneId };
  }

  /** Which workspace, if any, holds this session. */
  findBySession(sessionId: string): Workspace | undefined {
    return this.all.find((w) => panes(w.layout).some((p) => p.sessionId === sessionId));
  }

  paneFor(workspace: Workspace, sessionId: string): string | undefined {
    return panes(workspace.layout).find((p) => p.sessionId === sessionId)?.paneId;
  }

  sessionIds(workspace: Workspace): string[] {
    return panes(workspace.layout).map((p) => p.sessionId);
  }

  /**
   * Name a pane, or clear the name.
   *
   * On the layout, so it survives a reload and a daemon restart the way the split does. The
   * label and the color are cleaned here rather than trusted: this is where they enter storage.
   */
  setLabel(workspaceId: string, paneId: string, label: string, color?: string): Workspace | null {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return null;

    const clean = cleanPaneLabel(label);
    const tint = cleanLabelColor(color);
    const relabel = (node: LayoutNode): LayoutNode => {
      if (node.type === 'terminal') {
        if (node.paneId !== paneId) return node;
        // Rebuilt without the old label rather than overwritten, so clearing a name really
        // removes the fields instead of leaving empty ones behind.
        const rest = { type: node.type, paneId: node.paneId, sessionId: node.sessionId };
        return {
          ...rest,
          ...(clean === '' ? {} : { label: clean }),
          ...(clean !== '' && tint ? { labelColor: tint } : {}),
        };
      }
      return { ...node, children: [relabel(node.children[0]), relabel(node.children[1])] };
    };

    const next = { ...workspace, layout: relabel(workspace.layout), updatedAt: Date.now() };
    this.#workspaces.set(workspaceId, next);
    return this.#announce(next);
  }

  split(
    workspaceId: string,
    paneId: string,
    direction: SplitDirection,
    newSessionId: string,
  ): { workspace: Workspace; paneId: string } {
    const workspace = this.#require(workspaceId);
    const newPaneId = randomUUID();
    workspace.layout = splitPane(workspace.layout, paneId, direction, newPaneId, newSessionId);
    workspace.updatedAt = Date.now();
    info('workspace.split', { workspaceId, direction, panes: panes(workspace.layout).length });
    return { workspace, paneId: newPaneId };
  }

  /**
   * Remove a pane. Returns the surviving workspace, or null when the last pane went and the
   * workspace is finished.
   */
  closePane(workspaceId: string, paneId: string): Workspace | null {
    const workspace = this.#require(workspaceId);
    const next = closePane(workspace.layout, paneId);
    if (next === null) {
      this.#workspaces.delete(workspaceId);
      info('workspace.closed', { workspaceId });
      return null;
    }
    workspace.layout = next;
    workspace.updatedAt = Date.now();
    return workspace;
  }

  setRatio(workspaceId: string, paneId: string, ratio: number): Workspace {
    const workspace = this.#require(workspaceId);
    workspace.layout = setRatio(workspace.layout, paneId, ratio);
    workspace.updatedAt = Date.now();
    return workspace;
  }

  swap(workspaceId: string, a: string, b: string): Workspace {
    const workspace = this.#require(workspaceId);
    workspace.layout = swapPanes(workspace.layout, a, b);
    workspace.updatedAt = Date.now();
    return workspace;
  }

  /**
   * Move a session from wherever it lives into another workspace.
   *
   * The PTY is never touched. Only the layout trees change, which is the whole point: a merge
   * is a rearrangement of views over processes that keep running throughout.
   */
  mergeInto(
    targetWorkspaceId: string,
    targetPaneId: string,
    sessionId: string,
    direction: SplitDirection,
  ): { target: Workspace; source: Workspace | null } {
    const target = this.#require(targetWorkspaceId);
    const sourceWorkspace = this.findBySession(sessionId);
    if (sourceWorkspace?.id === targetWorkspaceId) {
      throw new Error('session is already in this workspace');
    }

    let source: Workspace | null = null;
    if (sourceWorkspace) {
      const sourcePane = this.paneFor(sourceWorkspace, sessionId);
      if (sourcePane) source = this.closePane(sourceWorkspace.id, sourcePane);
    }

    const newPaneId = randomUUID();
    target.layout = insertPane(target.layout, targetPaneId, direction, newPaneId, sessionId);
    target.updatedAt = Date.now();
    info('workspace.merged', { from: sourceWorkspace?.id, into: targetWorkspaceId });
    return { target, source };
  }

  /**
   * Pull a pane out into a workspace of its own, which becomes a standalone tab.
   *
   * Returns null when the pane is the only one, since detaching it would just be the same tab.
   */
  detachToNewWorkspace(
    workspaceId: string,
    paneId: string,
  ): { newWorkspace: Workspace; source: Workspace | null } | null {
    const workspace = this.#require(workspaceId);
    const all = panes(workspace.layout);
    if (all.length <= 1) return null;

    const pane = all.find((p) => p.paneId === paneId);
    if (!pane) return null;

    const source = this.closePane(workspaceId, paneId);
    const { workspace: newWorkspace } = this.create(pane.sessionId);
    info('workspace.detached', { from: workspaceId, to: newWorkspace.id });
    return { newWorkspace, source };
  }

  setLayout(workspaceId: string, layout: LayoutNode): Workspace {
    const workspace = this.#require(workspaceId);
    workspace.layout = layout;
    workspace.updatedAt = Date.now();
    return workspace;
  }

  /** Drop a session from whatever workspace holds it, after the process exits. */
  forgetSession(sessionId: string): Workspace | null | undefined {
    const workspace = this.findBySession(sessionId);
    if (!workspace) return undefined;
    const paneId = this.paneFor(workspace, sessionId);
    if (!paneId) return undefined;
    return this.closePane(workspace.id, paneId);
  }

  #require(id: string): Workspace {
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new Error(`no such workspace: ${id}`);
    return workspace;
  }
}
