import { panes, type LayoutNode, type LiveSession } from '@tabterm/shared';

/**
 * Which running sessions share a tab, in an order that does not move anything about.
 *
 * `Running now` listed every session as an equal card, so four terminals that are four panes of one
 * tab looked exactly like four unrelated terminals. Asked for a way to see which belong together.
 *
 * Colour was the first idea and was argued against: the dot on that card is already blue for
 * attached and green for busy, and pane labels carry colours somebody chose, so a third colour
 * language means a green group header beside a green busy dot meaning something unrelated. Calm
 * hues that stay legible run out around five or six, and none of it reaches somebody colour-blind.
 *
 * Grouping them is the answer, and it has to be a container rather than cards that merely sit next
 * to each other: a group that straddles a row boundary loses the cue entirely, which is the one
 * thing adjacency cannot survive.
 */

export interface SessionGroup {
  /** The workspace these share, or undefined for a session that is alone in its tab. */
  workspaceId?: string;
  /** Oldest first, the same order the flat list had. */
  sessions: readonly LiveSession[];
  /** The arrangement of the tab, when there is one to draw. */
  layout?: LayoutNode;
}

/**
 * Group the list without reordering it in any way somebody would notice.
 *
 * The existing order is oldest to newest, and it stays that way: **groups are ordered by their
 * oldest member**, and a session alone in its tab is a group of one. So nothing jumps around, and
 * the only movement is a tab's other panes being pulled up beside the oldest of them, which is the
 * whole point.
 *
 * A session with no workspace, which is one the daemon knows about but no tab has claimed, is its
 * own group. Grouping those together would invent a tab that does not exist.
 */
export function groupSessions(sessions: readonly LiveSession[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byWorkspace = new Map<string, SessionGroup>();

  for (const session of sessions) {
    const workspaceId = session.workspaceId;
    /*
     * Alone unless the tab says otherwise.
     *
     * The layout only arrives for a workspace with more than one pane, so its absence is the
     * daemon saying this session is the only thing in its tab. Reading that rather than counting
     * members keeps a group of one from forming while the second pane's card is still on its way.
     */
    if (workspaceId === undefined || session.layout === undefined) {
      groups.push({ sessions: [session] });
      continue;
    }
    const existing = byWorkspace.get(workspaceId);
    if (existing) {
      (existing.sessions as LiveSession[]).push(session);
      continue;
    }
    const group: SessionGroup = {
      workspaceId,
      sessions: [session],
      layout: session.layout,
    };
    byWorkspace.set(workspaceId, group);
    groups.push(group);
  }

  return groups;
}

/**
 * The panes of a layout, in the order they are drawn, keeping only the ones there are cards for.
 *
 * A workspace's layout can name a pane whose session is not in this list: it has exited, or it has
 * been taken into another tab and the two facts have not met yet. Drawing a gap for one of those
 * would be drawing a terminal that is not there, so the shape is built from what actually arrived.
 */
export function orderedByLayout(group: SessionGroup): { session: LiveSession; paneId: string }[] {
  if (!group.layout) return group.sessions.map((session) => ({ session, paneId: '' }));
  const bySession = new Map(group.sessions.map((s) => [s.sessionId, s]));
  const out: { session: LiveSession; paneId: string }[] = [];
  for (const pane of panes(group.layout)) {
    const session = bySession.get(pane.sessionId);
    if (session) out.push({ session, paneId: pane.paneId });
  }
  /*
   * And anything the layout did not mention, kept rather than dropped.
   *
   * Every session in this group came with this workspace's id on it. If the layout has not caught
   * up with one of them, the card still belongs here: losing a running terminal from the list is
   * far worse than drawing it in the wrong place for a moment.
   */
  for (const session of group.sessions) {
    if (!out.some((entry) => entry.session.sessionId === session.sessionId)) {
      out.push({ session, paneId: '' });
    }
  }
  return out;
}

/** Whether this group is a tab with more than one pane in it, which is what gets a container. */
export function isShared(group: SessionGroup): boolean {
  return group.sessions.length > 1;
}

/**
 * How many cards wide a tab is, which is how many columns of the grid it needs.
 *
 * Panes side by side add up; panes stacked sit in the same column, so the wider of them decides.
 * A tab of two side by side is two cards wide, a tab of two stacked is one card wide and two tall,
 * and each card stays the size it would be on its own.
 *
 * The first version of this gave every group the whole row, which made a pair of terminals into a
 * banner across the list and was the first thing said about it: "it takes up the whole width".
 */
export function columnsWide(node: LayoutNode): number {
  if (node.type === 'terminal') return 1;
  const first = columnsWide(node.children[0]);
  const second = columnsWide(node.children[1]);
  return node.direction === 'horizontal' ? first + second : Math.max(first, second);
}
