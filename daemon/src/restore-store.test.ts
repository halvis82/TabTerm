import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { LayoutNode, Workspace } from '@tabterm/shared';
import { Database } from './database.js';
import { RestoreStore } from './restore-store.js';

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
  it('offers nothing that is already running', () => {
    // During normal operation every workspace is live, so nothing is offered. That is the point:
    // restore is for the case where the sessions are gone.
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    expect(store.list(new Set(['w1']))).toHaveLength(0);
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('offers newest first', () => {
    const store = fresh();
    store.save(workspace('old', ['s1']), () => pane('/old'));
    store.save(workspace('new', ['s2']), () => pane('/new'));
    const listed = store.list(new Set());
    expect(listed[0]?.workspaceId).toBe('new');
  });

  it('honors the limit', () => {
    const store = fresh();
    // Distinct directories, because identical layouts now collapse to one.
    for (let i = 0; i < 20; i++) {
      store.save(workspace(`w${String(i)}`, ['s']), () => pane(`/w/${String(i)}`));
    }
    expect(store.list(new Set(), 5)).toHaveLength(5);
  });

  it('skips a workspace with no panes recorded', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => null);
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
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('prunes anything older than the retention window', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.prune(-1); // everything is older than a negative window
    expect(store.list(new Set())).toHaveLength(0);
  });

  it('keeps recent workspaces when pruning', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => pane('/w'));
    store.prune(60_000);
    expect(store.list(new Set())).toHaveLength(1);
  });
});

describe('what is not worth offering back', () => {
  const trivial = (id: string) => {
    const store = fresh();
    store.save(workspace(id, ['s1']), () => ({ cwd: homedir(), screen: '' }));
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
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('does offer a single pane somewhere other than home', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1']), () => ({ cwd: '/w/app', screen: 'x' }));
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('does offer a multi-pane workspace even in home', () => {
    const store = fresh();
    store.save(workspace('w1', ['s1', 's2']), () => ({ cwd: homedir(), screen: 'x' }));
    expect(store.list(new Set())).toHaveLength(1);
  });

  it('collapses identical layouts to the newest', () => {
    // A daemon that restarted a dozen times leaves a dozen indistinguishable records.
    const store = fresh();
    for (let i = 0; i < 12; i++) {
      store.save(workspace(`w${String(i)}`, ['s1']), () => ({ cwd: '/w/app', screen: 'x' }));
    }
    const listed = store.list(new Set());
    expect(listed).toHaveLength(1);
    expect(listed[0]?.workspaceId).toBe('w11');
  });

  it('keeps layouts that genuinely differ', () => {
    const store = fresh();
    store.save(workspace('a', ['s1']), () => ({ cwd: '/w/one', screen: 'x' }));
    store.save(workspace('b', ['s1']), () => ({ cwd: '/w/two', screen: 'x' }));
    expect(store.list(new Set())).toHaveLength(2);
  });
});
