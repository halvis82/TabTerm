import { describe, expect, it } from 'vitest';
import type { LayoutNode, LiveSession } from '@tabterm/shared';
import { groupSessions, isShared, orderedByLayout } from './session-groups.js';

const session = (id: string, startedAt: number, extra: Partial<LiveSession> = {}): LiveSession => ({
  sessionId: id,
  cwd: '/tmp',
  attached: false,
  inTab: true,
  startedAt,
  preview: [],
  busy: false,
  memoryBytes: 0,
  ...extra,
});

const sideBySide = (a: string, b: string): LayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [
    { type: 'terminal', paneId: `p-${a}`, sessionId: a },
    { type: 'terminal', paneId: `p-${b}`, sessionId: b },
  ],
});

/**
 * Which running sessions share a tab.
 *
 * The list was every session as an equal card, so four panes of one tab looked exactly like four
 * unrelated terminals. The order it had, oldest first, is the thing most easily broken by grouping,
 * so it is what most of this pins.
 */
describe('grouping what Running Now shows', () => {
  it('leaves a list of unrelated sessions exactly as it was', () => {
    const list = [session('a', 1), session('b', 2), session('c', 3)];
    const groups = groupSessions(list);
    expect(groups.map((g) => g.sessions.map((s) => s.sessionId))).toEqual([['a'], ['b'], ['c']]);
    expect(groups.every((g) => !isShared(g))).toBe(true);
  });

  /*
   * The order is oldest to newest and has to stay that way. Groups take the place of their oldest
   * member, so nothing a person was looking at moves anywhere else.
   */
  it('puts a group where its oldest member was, and keeps everything else in place', () => {
    const layout = sideBySide('b', 'd');
    const list = [
      session('a', 1),
      session('b', 2, { workspaceId: 'ws', layout }),
      session('c', 3),
      session('d', 4, { workspaceId: 'ws', layout }),
    ];
    const groups = groupSessions(list);
    expect(groups.map((g) => g.sessions.map((s) => s.sessionId))).toEqual([
      ['a'],
      ['b', 'd'],
      ['c'],
    ]);
  });

  /*
   * A session the daemon knows about that no tab has claimed is its own group. Putting those
   * together would invent a tab that does not exist.
   */
  it('never invents a group out of sessions with no tab', () => {
    const list = [session('a', 1), session('b', 2)];
    expect(groupSessions(list).map((g) => g.sessions.length)).toEqual([1, 1]);
  });

  /*
   * The layout only arrives for a tab with more than one pane, so its absence is the daemon saying
   * this session is alone. Reading that rather than counting members stops a group of one forming
   * while a second card is still on its way.
   */
  it('and does not group a session whose tab has not said it is shared', () => {
    const list = [session('a', 1, { workspaceId: 'ws' }), session('b', 2, { workspaceId: 'ws' })];
    expect(groupSessions(list).map((g) => g.sessions.length)).toEqual([1, 1]);
  });

  it('draws a shared tab in the order its panes are laid out, not the order they started', () => {
    const layout = sideBySide('young', 'old');
    const group = groupSessions([
      session('old', 1, { workspaceId: 'ws', layout }),
      session('young', 2, { workspaceId: 'ws', layout }),
    ])[0];
    expect(group).toBeDefined();
    expect(orderedByLayout(group!).map((e) => e.session.sessionId)).toEqual(['young', 'old']);
  });

  /*
   * A layout can name a pane whose session is not in the list: it exited, or it was taken into
   * another tab and the two facts have not met yet. Drawing a gap for one would be drawing a
   * terminal that is not there.
   */
  it('skips a pane whose session is gone rather than leaving a hole', () => {
    const layout = sideBySide('here', 'gone');
    const group = groupSessions([
      session('here', 1, { workspaceId: 'ws', layout }),
      session('other', 2, { workspaceId: 'ws', layout }),
    ])[0];
    expect(orderedByLayout(group!).map((e) => e.session.sessionId)).toEqual(['here', 'other']);
  });

  /*
   * And the other direction: a session carrying this workspace's id that the layout has not caught
   * up with is kept. Losing a running terminal from the list is far worse than drawing it in the
   * wrong place for a moment.
   */
  it('and keeps a session the layout has not caught up with', () => {
    const layout = sideBySide('a', 'b');
    const group = groupSessions([
      session('a', 1, { workspaceId: 'ws', layout }),
      session('b', 2, { workspaceId: 'ws', layout }),
      session('c', 3, { workspaceId: 'ws', layout }),
    ])[0];
    expect(orderedByLayout(group!).map((e) => e.session.sessionId)).toEqual(['a', 'b', 'c']);
  });
});
