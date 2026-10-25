import { basename } from 'node:path';
import { panes, type LayoutNode, type RemoteTab, type Workspace } from '@tabterm/shared';

/**
 * What a remote browser is shown: the Mac's tabs, each with its terminals, then whatever is running
 * without a tab.
 *
 * Built from what the daemon already holds, without reading any screen, so it can be built as
 * often as anything changes. Every live terminal is listed, including a fresh shell nobody has
 * typed into, because the browser mirrors the tabs and an empty tab is still a tab.
 */

export interface TabSession {
  id: string;
  state: string;
  pid: number;
  cwd: string;
  process?: string;
  pendingCommand?: string;
  ranLast?: string;
  commandRunning: boolean;
  agentState?: string;
}

function label(node: LayoutNode, sessionId: string): string | undefined {
  if (node.type === 'terminal') {
    if (node.sessionId !== sessionId) return undefined;
    const name = node.label?.trim() ?? '';
    return name === '' ? undefined : name;
  }
  return label(node.children[0], sessionId) ?? label(node.children[1], sessionId);
}

const folder = (cwd: string): string => basename(cwd) || cwd;

function titleOf(s: TabSession, name: string | undefined): string {
  return name ?? s.process ?? s.pendingCommand ?? s.ranLast ?? folder(s.cwd);
}

export function remoteTabs(
  sessions: readonly TabSession[],
  workspaces: readonly Workspace[],
  tabHolds: (sessionId: string) => boolean,
): RemoteTab[] {
  const live = new Map(
    sessions.filter((s) => s.state !== 'exited' && s.state !== 'reaped').map((s) => [s.id, s]),
  );
  const pane = (s: TabSession, name: string | undefined): RemoteTab['panes'][number] => ({
    sessionId: s.id,
    stream: 0,
    title: titleOf(s, name),
    cwd: s.cwd,
    busy: s.commandRunning || s.agentState === 'working',
    needsYou: s.agentState === 'approval' || s.agentState === 'waiting',
    ...(s.process ? { process: s.process } : {}),
  });

  const tabs: RemoteTab[] = [];
  const placed = new Set<string>();
  for (const ws of workspaces) {
    const inside = panes(ws.layout)
      .map((p) => live.get(p.sessionId))
      .filter((s): s is TabSession => s !== undefined && tabHolds(s.id));
    if (inside.length === 0) continue;
    for (const s of inside) placed.add(s.id);
    const first = inside[0] as TabSession;
    const title =
      ws.title?.trim() ||
      (inside.length === 1
        ? titleOf(first, label(ws.layout, first.id))
        : `${String(inside.length)} terminals in ${folder(first.cwd)}`);
    tabs.push({
      id: ws.id,
      title,
      panes: inside.map((s) => pane(s, label(ws.layout, s.id))),
    });
  }

  // Running with no tab: closed tabs whose terminals were kept, and sessions in the background.
  const background = [...live.values()].filter((s) => !placed.has(s.id) && s.pid > 0);
  if (background.length > 0) {
    tabs.push({
      id: 'background',
      title: 'Running without a tab',
      panes: background.map((s) => {
        const ws = workspaces.find((w) => panes(w.layout).some((p) => p.sessionId === s.id));
        return pane(s, ws ? label(ws.layout, s.id) : undefined);
      }),
    });
  }
  return tabs;
}
