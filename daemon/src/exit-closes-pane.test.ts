import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './workspace-store.js';
import { initLog } from './log.js';

let store: WorkspaceStore;

beforeAll(() => {
  initLog('error');
});

/**
 * A pane whose process has ended stops being a pane.
 *
 * Reported as "i can't seem to close or kill session with right click on any pane in split
 * screen", and the browser check written for it found something larger: a shell that simply
 * exited left its pane behind too. A pane holding a dead terminal is worse than no pane, because
 * it looks exactly like a live one and swallows everything typed into it, which is also what
 * "when i close an agent session, i can't always type commands again" looks like from outside.
 *
 * The store is the half that decides. Whether anybody is told is the other half.
 */
describe('what a workspace does when one of its sessions ends', () => {
  it('drops the pane and keeps the workspace when a sibling survives', () => {
    store = new WorkspaceStore();
    const { workspace, paneId } = store.create('session-a');
    store.split(workspace.id, paneId, 'horizontal', 'session-b');
    expect(store.findBySession('session-b')?.id).toBe(workspace.id);

    const surviving = store.forgetSession('session-a');
    expect(surviving).not.toBeNull();
    expect(surviving).toBeDefined();
    // Collapsed to the one that is left, rather than a split with a hole in it.
    expect(surviving?.layout.type).toBe('terminal');
    expect(surviving?.layout).toMatchObject({ sessionId: 'session-b' });
    expect(store.findBySession('session-a')).toBeUndefined();
  });

  it('closes the workspace when the last pane goes', () => {
    store = new WorkspaceStore();
    const { workspace } = store.create('only');
    expect(store.forgetSession('only')).toBeNull();
    expect(store.get(workspace.id)).toBeUndefined();
  });

  it('says nothing about a session it never held', () => {
    store = new WorkspaceStore();
    store.create('a');
    expect(store.forgetSession('not-here')).toBeUndefined();
  });

  it('drops the right one when three panes share a workspace', () => {
    store = new WorkspaceStore();
    const { workspace, paneId } = store.create('a');
    const second = store.split(workspace.id, paneId, 'horizontal', 'b');
    store.split(workspace.id, second.paneId, 'vertical', 'c');
    store.forgetSession('b');
    expect(store.findBySession('a')?.id).toBe(workspace.id);
    expect(store.findBySession('c')?.id).toBe(workspace.id);
    expect(store.findBySession('b')).toBeUndefined();
  });
});
