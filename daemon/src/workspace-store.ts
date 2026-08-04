import { randomUUID } from 'node:crypto';
import type { LayoutNode, SplitDirection, Workspace } from '@tabterm/shared';
import { closePane, panes, setRatio, splitPane, swapPanes, terminalNode } from '@tabterm/shared';
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

  get all(): Workspace[] {
    return [...this.#workspaces.values()];
  }

  get(id: string): Workspace | undefined {
    return this.#workspaces.get(id);
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
