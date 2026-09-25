import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { panes } from '@tabterm/shared';
import type { LayoutNode, Workspace } from '@tabterm/shared';
import { Database } from './database.js';
import { RestoreStore, layoutWithSessions } from './restore-store.js';

const workspace = (id: string, sessions: string[]): Workspace => {
  const build = (index: number): LayoutNode =>
    index === sessions.length - 1
      ? { type: 'terminal', paneId: `p${String(index)}`, sessionId: sessions[index] as string }
      : {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          children: [
            { type: 'terminal', paneId: `p${String(index)}`, sessionId: sessions[index] as string },
            build(index + 1),
          ],
        };
  return { id, layout: build(0), pinned: true, createdAt: 1, updatedAt: 1 };
};

const pane = (cwd: string, extra: Record<string, unknown> = {}) => ({
  cwd,
  screen: `contents of ${cwd}`,
  ...extra,
});

const fresh = () => new RestoreStore(new Database(':memory:'));

describe('recording a workspace', () => {
  it('stores the layout and every pane', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1', 's2']), (id) => pane(`/dir/${id}`));

    const saved = store.get('w1');
    expect(saved?.panes).toHaveLength(2);
    expect(saved?.panes.map((p) => p.cwd).sort()).toEqual(['/dir/s1', '/dir/s2']);
    expect(saved?.layout.type).toBe('split');
  });

  it('keeps the screen, which is what makes a restored pane recognisable', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w', { screen: 'the output was here' }));
    expect(store.get('w1')?.panes[0]?.screen).toBe('the output was here');
  });

  it('never lets an empty screen erase one already captured', () => {
    // A pane whose session is gone reports nothing. Overwriting the recorded screen with that
    // would destroy the only reason to offer a restore at all.
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w', { screen: 'real output' }));
    store.save(workspace('w1', ['s1']), () => pane('/w', { screen: '' }));
    expect(store.get('w1')?.panes[0]?.screen).toBe('real output');
  });

  it('keeps the last command once it has one, even if a later save has none', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w', { lastCommand: 'npm test' }));
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    expect(store.get('w1')?.panes[0]?.lastCommand).toBe('npm test');
  });

  it('stores an explicit command as argv', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w', { command: ['npm', 'run', 'dev'] }));
    expect(store.get('w1')?.panes[0]?.command).toEqual(['npm', 'run', 'dev']);
  });

  it('drops a pane that left the layout', () => {
    // A closed pane coming back on every restart is the opposite of what closing it meant.
    const store = fresh();
    store.save(workspace('w1', ['s1', 's2']), (id) => pane(`/dir/${id}`));
    store.save(workspace('w1', ['s1']), (id) => pane(`/dir/${id}`));
    expect(store.get('w1')?.panes).toHaveLength(1);
  });

  it('skips a pane whose session is already gone', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1', 's2']), (id) => (id === 's2' ? null : pane('/w')));
    expect(store.get('w1')?.panes).toHaveLength(1);
  });
});

describe('offering restores', () => {
  /**
   * The offer is what a restart took away, which is the sentence on the start screen.
   *
   * Closing a tab does not close a workspace, by design, so without this nothing separated a tab
   * somebody closed from one that was taken: the start screen showed both, under a heading about
   * restarting, for every workspace of the last fortnight.
   */
  it('offers nothing until a restart has said what it came back without', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    expect(store.list(new Set())).toHaveLength(0);
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('does not call a workspace lost when it came back with the daemon', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.markLost(new Set(['w1']));
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('stops calling it lost once it is alive again', () => {
    // A save is the workspace being used, which is the opposite of having been taken away.
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.markLost(new Set());
    store.save(workspace('w1', ['s2']), () => pane('/w'));
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('offers nothing that is already running', () => {
    // During normal operation every workspace is live, so nothing is offered. That is the point:
    // restore is for the case where the sessions are gone.
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set(['w1']))).toHaveLength(0);
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('offers newest first', () => {
    const store = fresh();
    store.save(workspace('old', ['s1']), () => pane('/old'));
    store.save(workspace('new', ['s2']), () => pane('/new'));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    const listed = store.list(new Set());
    expect(listed[0]?.workspaceId).toBe('new');
  });

  it('honors the limit', () => {
    const store = fresh();
    // Distinct directories, because identical layouts now collapse to one.
    for (let i = 0; i < 20; i++) {
      store.save(workspace(`w${String(i)}`, ['s']), () => pane(`/w/${String(i)}`));
    }
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set(), 5)).toHaveLength(5);
  });

  /**
   * What the offer is actually for, which it had stopped being.
   *
   * On a real machine this list was four hundred and seventeen workspaces across a fortnight,
   * none of them marked closed and none of them from a restart, with three of them on the start
   * screen at any moment under a heading that says "reopen from before the restart". Reported as
   * "at some point these should go away, i haven't restarted today at all".
   */
  it('stops offering a workspace somebody closed', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
    store.close('w1');
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('offers it again if it comes back and is lost again', () => {
    // Closed is a fact about the last time it ended, not a mark that retires the workspace.
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.close('w1');
    store.save(workspace('w1', ['s2']), () => pane('/w'));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('stops offering one that is older than the window', () => {
    // Aged in the store rather than through an injected clock, so this exercises the real window
    // against a real row: five hours ago, against the four the offer is worth.
    const db = new Database(':memory:');
    const store = new RestoreStore(db);
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
    db.handle
      .prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 5 * 60 * 60 * 1000, 'w1');
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('offers back within a few hours rather than a fortnight', () => {
    // The number itself, because it is the whole of the fix and a later edit should have to mean
    // it. Four hours is the working stretch after a restart, which is when this is taken or not.
    expect(RestoreStore.OFFER_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('skips a workspace with no panes recorded', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => null);
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('skips a layout that will not parse rather than throwing on startup', () => {
    // One unusable row costs a restore offer. Throwing would cost the daemon.
    const db = new Database(':memory:');
    db.handle
      .prepare(
        `INSERT INTO workspaces (id, layout_json, pinned, created_at, updated_at) VALUES ('bad', '{not json', 1, 1, 1)`,
      )
      .run();
    db.handle
      .prepare(
        `INSERT INTO pane_snapshots (workspace_id, pane_id, session_id, cwd, screen, saved_at)
         VALUES ('bad', 'p0', 's', '/w', '', 1)`,
      )
      .run();
    const store = new RestoreStore(db);
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(() => store.list(new Set())).not.toThrow();
    expect(store.list(new Set())).toHaveLength(0);
    expect(store.get('bad')).toBeNull();
  });

  it('tolerates a stored command that is not valid argv', () => {
    const db = new Database(':memory:');
    const store = new RestoreStore(db);
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    db.handle.prepare(`UPDATE pane_snapshots SET command_json = '{"not":"an array"}'`).run();
    expect(store.get('w1')?.panes[0]?.command).toBeUndefined();
  });
});

describe('forgetting', () => {
  it('removes a workspace and its panes', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.forget('w1');
    expect(store.get('w1')).toBeNull();
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('prunes anything older than the retention window', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.prune(-1); // everything is older than a negative window
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('keeps recent workspaces when pruning', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.prune(60_000);
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
  });
});

describe('what is not worth offering back', () => {
  const trivial = (id: string) => {
    const store = fresh();
    store.save(workspace(id, ['s1']), () => ({ cwd: homedir(), screen: '' }));
    // Taken away by a restart, which is the only state in which anything is offered at all.
    store.markLost(new Set());
    return store;
  };

  it('does not offer a plain shell in the home directory', () => {
    // Restoring one pane that never ran anything, in the directory a new tab already opens in,
    // restores nothing. A list of them buries the ones that carry something back.
    expect(trivial('w1').list(new Set())).toHaveLength(0);
  });

  it('does offer it once something was run there', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => ({
      cwd: homedir(),
      screen: 'x',
      lastCommand: 'npm test',
    }));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('does offer a single pane somewhere other than home', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => ({ cwd: '/w/app', screen: 'x' }));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('does not offer a multi-pane workspace where every pane is untouched', () => {
    /**
     * Being bigger used to be enough to escape the rule. Three shells sitting in the home
     * directory with nothing run in any of them were offered back as "3 panes" after every
     * restart, and reopening them produced three more shells with nothing in them.
     */
    const store = fresh();
    store.save(workspace('w1', ['s1', 's2']), () => ({ cwd: homedir(), screen: 'x' }));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('keeps only the panes that hold something, and forgets the shape', () => {
    // Work in one pane and two untouched shells beside it is worth reopening. The two are not.
    const store = fresh();
    store.save(workspace('w1', ['s1', 's2', 's3']), (sessionId) =>
      sessionId === 's2'
        ? { cwd: '/w/app', screen: 'x', lastCommand: 'npm test' }
        : { cwd: homedir(), screen: 'x' },
    );
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    const [offer] = store.list(new Set());
    expect(offer?.panes).toHaveLength(1);
    expect(offer?.panes[0]?.lastCommand).toBe('npm test');
  });

  it('collapses identical layouts to the newest', () => {
    // A daemon that restarted a dozen times leaves a dozen indistinguishable records.
    const store = fresh();
    for (let i = 0; i < 12; i++) {
      store.save(workspace(`w${String(i)}`, ['s1']), () => ({ cwd: '/w/app', screen: 'x' }));
    }
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    const listed = store.list(new Set());
    expect(listed).toHaveLength(1);
    expect(listed[0]?.workspaceId).toBe('w11');
  });

  it('keeps layouts that genuinely differ', () => {
    const store = fresh();
    store.save(workspace('a', ['s1']), () => ({ cwd: '/w/one', screen: 'x' }));
    store.save(workspace('b', ['s1']), () => ({ cwd: '/w/two', screen: 'x' }));
    // Everything here was taken away by a restart, which is what the offer is about.
    store.markLost(new Set());
    expect(store.list(new Set())).toHaveLength(2);
  });
});

/**
 * A snapshot is one state, written whole or not at all.
 *
 * `save` writes three things that only mean something together: the layout, a row per pane in it,
 * and the removal of rows for panes that have left. Written separately, a crash partway leaves a
 * layout from now beside pane contents from before, and the next start restores a workspace that
 * never existed: a pane showing another pane's screen, or a layout naming a pane whose snapshot
 * was already deleted.
 *
 * The live terminals are not at risk either way, because the host holds those. What is at risk is
 * the recovery after a reboot, and a recovery that restores a state nobody was ever in is worse
 * than one that restores the previous coherent state.
 */
describe('saving a restore snapshot', () => {
  it('leaves the previous state untouched when the save cannot finish', () => {
    const store = fresh();
    store.save(workspace('ws-atomic', ['s1']), () => pane('/first'));
    expect(store.get('ws-atomic')?.panes[0]?.cwd).toBe('/first');

    /**
     * A save that throws partway through its panes. Without a transaction the layout row is
     * already written by this point, so the workspace would be left describing a shape whose
     * panes still hold the previous contents: a state nobody was ever in.
     */
    store.save(workspace('ws-atomic', ['s9', 's8']), () => {
      throw new Error('the emulator went away mid-save');
    });

    const after = store.get('ws-atomic');
    expect(after?.panes).toHaveLength(1);
    expect(after?.panes[0]?.cwd).toBe('/first');
    // And the layout is the one that matches those panes, not the half-written new one.
    expect(after?.layout.type).toBe('terminal');
  });
});

describe('what a daemon remembers about a workspace across a restart', () => {
  /**
   * Two facts that are worthless if they only live in memory.
   *
   * Provenance decides whether a browser saying "I do not have that workspace" means anything. A
   * daemon that lost it would find every session it adopted unattributable: no browser in this
   * lifetime reported the workspace or asked for it, so nothing could ever authorise the timeout
   * somebody chose, and the session would live for ever. That is the safe direction and still the
   * wrong answer.
   *
   * The background time is the start of that timeout. Recomputing it after every daemon update
   * hands each waiting session a fresh countdown, which is the same setting quietly not working.
   */
  it('keeps which browser held it, and when it went to the background', () => {
    const db = new Database(':memory:');
    const store = new RestoreStore(db);
    const ws = workspace('ws-provenance', ['s1']);
    store.save(ws, () => null);

    store.noteOwner(ws.id, 'profile-uuid');
    store.noteBackgroundSince(ws.id, 1_700_000_000_000);

    const back = store.provenance().find((p) => p.workspaceId === ws.id);
    expect(back?.profile).toBe('profile-uuid');
    expect(back?.backgroundSince).toBe(1_700_000_000_000);
  });

  it('forgets the background time when the tab comes back', () => {
    const db = new Database(':memory:');
    const store = new RestoreStore(db);
    const ws = workspace('ws-returned', ['s1']);
    store.save(ws, () => null);
    store.noteOwner(ws.id, 'profile-uuid');
    store.noteBackgroundSince(ws.id, 1_700_000_000_000);

    store.noteBackgroundSince(ws.id, null);

    const back = store.provenance().find((p) => p.workspaceId === ws.id);
    expect(
      back?.backgroundSince,
      'a workspace that is open has no background clock',
    ).toBeUndefined();
    expect(back?.profile, 'but it is still the same browser that had it').toBe('profile-uuid');
  });
});

/**
 * A restored workspace comes back in the arrangement it was saved in.
 *
 * It used to be rebuilt as a chain of horizontal splits, which kept the number of panes and
 * nothing else. A stacked pair came back side by side, every ratio was lost, and the order
 * depended on which way the chain leaned. Two panes in the same directory came back swapped,
 * which is the one case where nothing on the screen says which is which.
 */
describe('putting the sessions back into the saved layout', () => {
  const tree: LayoutNode = {
    type: 'split',
    direction: 'vertical',
    ratio: 0.3,
    children: [
      { type: 'terminal', paneId: 'p1', sessionId: 'old-1', label: 'top' },
      {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.7,
        children: [
          { type: 'terminal', paneId: 'p2', sessionId: 'old-2' },
          { type: 'terminal', paneId: 'p3', sessionId: 'old-3' },
        ],
      },
    ],
  };

  it('keeps the shape, the directions and the ratios', () => {
    const out = layoutWithSessions(
      tree,
      new Map([
        ['p1', 'new-1'],
        ['p2', 'new-2'],
        ['p3', 'new-3'],
      ]),
    );
    expect(JSON.stringify(out)).toBe(
      JSON.stringify(tree)
        .replace('old-1', 'new-1')
        .replace('old-2', 'new-2')
        .replace('old-3', 'new-3'),
    );
  });

  it('keeps each pane where it was, which is the reported bug', () => {
    // Two panes in the same directory are indistinguishable on screen, so an order that depends
    // on how the tree was rebuilt is an order nobody can check and everybody notices.
    const out = layoutWithSessions(
      tree,
      new Map([
        ['p1', 'a'],
        ['p2', 'b'],
        ['p3', 'c'],
      ]),
    );
    expect(panes(out as LayoutNode).map((p) => p.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a name somebody gave a pane', () => {
    const out = layoutWithSessions(tree, new Map([['p1', 'a']]));
    expect(out?.type === 'terminal' ? out.label : '').toBe('top');
  });

  it('prunes a pane nothing was spawned for rather than naming a session that is gone', () => {
    const out = layoutWithSessions(
      tree,
      new Map([
        ['p1', 'a'],
        ['p3', 'c'],
      ]),
    );
    expect(panes(out as LayoutNode).map((p) => p.paneId)).toEqual(['p1', 'p3']);
  });

  it('says so rather than inventing a layout when nothing matched', () => {
    expect(layoutWithSessions(tree, new Map())).toBe(null);
  });
});
