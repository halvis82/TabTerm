import { describe, expect, it } from 'vitest';
import { PluginHost, type TabTermPlugin } from './plugin-api.js';

const plugin = (over: Partial<TabTermPlugin> & { id?: string } = {}): TabTermPlugin => ({
  manifest: {
    id: over.id ?? 'test',
    name: 'Test plugin',
    capabilities: [
      'read-output',
      'read-cwd',
      'read-command-text',
      'contribute-status',
      'contribute-launcher',
    ],
    ...over.manifest,
  },
  ...over,
});

const session = { sessionId: 's1', cwd: '/w/app', command: 'npm test' };

describe('registration', () => {
  it('accepts a well-formed plugin', () => {
    expect(new PluginHost().register(plugin()).ok).toBe(true);
  });

  it('refuses a duplicate id', () => {
    const host = new PluginHost();
    host.register(plugin());
    expect(host.register(plugin()).ok).toBe(false);
  });

  it('refuses an id that is not a simple name', () => {
    const host = new PluginHost();
    for (const id of ['', '../escape', 'a'.repeat(100), 'has space']) {
      expect(host.register(plugin({ id })).ok).toBe(false);
    }
  });

  it('refuses an unknown capability rather than ignoring it', () => {
    // A plugin asking for something that does not exist is out of date or wrong about what it
    // does. Both deserve to be visible.
    const host = new PluginHost();
    const result = host.register({
      manifest: { id: 'x', name: 'x', capabilities: ['read-everything' as never] },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('unknown capability');
  });
});

describe('capabilities gate what a plugin can see', () => {
  it('withholds the cwd from a plugin that did not ask for it', () => {
    let seen: unknown = 'never called';
    const host = new PluginHost();
    host.register({
      manifest: { id: 'p', name: 'p', capabilities: ['contribute-status'] },
      paneStatus: (ctx) => {
        seen = ctx;
        return { state: 'idle' };
      },
    });
    host.status(session);
    expect(seen).toEqual({ sessionId: 's1' });
  });

  it('withholds the command text from a plugin that did not ask for it', () => {
    let seen: { command?: string } = {};
    const host = new PluginHost();
    host.register({
      manifest: { id: 'p', name: 'p', capabilities: ['read-cwd', 'contribute-status'] },
      paneStatus: (ctx) => {
        seen = ctx;
        return null;
      },
    });
    host.status(session);
    expect(seen.command).toBeUndefined();
    expect(seen).toHaveProperty('cwd', '/w/app');
  });

  it('does not call a hook the plugin has no capability for', () => {
    let called = false;
    const host = new PluginHost();
    host.register({
      manifest: { id: 'p', name: 'p', capabilities: ['read-cwd'] },
      decorateText: () => {
        called = true;
        return [];
      },
      launcherItems: () => {
        called = true;
        return [];
      },
    });
    host.decorate('some text', session);
    host.launcher({ cwd: '/w' });
    expect(called).toBe(false);
  });
});

describe('a plugin that misbehaves', () => {
  it('is disabled on its first throw rather than throwing forever', () => {
    // A hook on a hot path that fails once fails on every line of output. A log full of the
    // same error is worse than a missing feature.
    let calls = 0;
    const host = new PluginHost();
    host.register({
      manifest: { id: 'bad', name: 'bad', capabilities: ['read-output'] },
      decorateText: () => {
        calls++;
        throw new Error('boom');
      },
    });

    expect(() => host.decorate('line one', session)).not.toThrow();
    host.decorate('line two', session);
    host.decorate('line three', session);
    expect(calls).toBe(1);
    expect(host.disabledReason('bad')).toContain('boom');
    expect(host.failures[0]?.hook).toBe('decorateText');
  });

  it('stops appearing in the plugin list once disabled', () => {
    const host = new PluginHost();
    host.register({
      manifest: { id: 'bad', name: 'bad', capabilities: ['read-output'] },
      decorateText: () => {
        throw new Error('boom');
      },
    });
    host.decorate('x', session);
    expect(host.plugins).toHaveLength(0);
  });

  it('does not take other plugins down with it', () => {
    const host = new PluginHost();
    host.register({
      manifest: { id: 'bad', name: 'bad', capabilities: ['read-output'] },
      decorateText: () => {
        throw new Error('boom');
      },
    });
    host.register({
      manifest: { id: 'good', name: 'good', capabilities: ['read-output'] },
      decorateText: () => [{ start: 0, length: 4, kind: 'note', title: 'ok' }],
    });
    expect(host.decorate('line', session)).toHaveLength(1);
  });
});

describe('decorations are bounded and cannot land on the wrong text', () => {
  it('drops a span that falls outside the line', () => {
    // A decoration in the wrong place is worse than none, so this drops rather than clamps.
    const host = new PluginHost();
    host.register(
      plugin({
        decorateText: () => [
          { start: 0, length: 100, kind: 'link', title: 'too long' },
          { start: -5, length: 2, kind: 'link', title: 'negative' },
          { start: 2, length: 0, kind: 'link', title: 'empty' },
          { start: 1.5, length: 2, kind: 'link', title: 'fractional' },
          { start: 0, length: 4, kind: 'link', title: 'fine' },
        ],
      }),
    );
    const out = host.decorate('line', session);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('fine');
  });

  it('caps how many decorations one line can carry', () => {
    const host = new PluginHost();
    host.register(
      plugin({
        decorateText: () =>
          Array.from({ length: 500 }, () => ({
            start: 0,
            length: 1,
            kind: 'note' as const,
            title: 'x',
          })),
      }),
    );
    expect(host.decorate('a line of text', session).length).toBeLessThanOrEqual(64);
  });

  it('truncates a title rather than letting it into a tooltip whole', () => {
    const host = new PluginHost();
    host.register(
      plugin({
        decorateText: () => [{ start: 0, length: 1, kind: 'note', title: 'x'.repeat(5000) }],
      }),
    );
    expect(host.decorate('a', session)[0]?.title.length).toBeLessThanOrEqual(200);
  });
});

describe('status contributions', () => {
  it('takes the most severe, using the host ordering', () => {
    // A plugin cannot promote itself past another by returning something louder: the priority
    // is the host's, exactly as it is for core pane status.
    const host = new PluginHost();
    host.register(plugin({ id: 'a', paneStatus: () => ({ state: 'running' }) }));
    host.register(plugin({ id: 'b', paneStatus: () => ({ state: 'approval' }) }));
    host.register(plugin({ id: 'c', paneStatus: () => ({ state: 'idle' }) }));
    expect(host.status(session)?.state).toBe('approval');
  });

  it('ignores a state that is not one of the known ones', () => {
    const host = new PluginHost();
    host.register(plugin({ paneStatus: () => ({ state: 'on fire' as never }) }));
    expect(host.status(session)).toBeNull();
  });

  it('returns null when nothing contributed', () => {
    expect(new PluginHost().status(session)).toBeNull();
  });
});

describe('launcher contributions', () => {
  it('namespaces ids, so two plugins cannot collide', () => {
    const host = new PluginHost();
    host.register(plugin({ id: 'a', launcherItems: () => [{ id: 'go', title: 'A' }] }));
    host.register(plugin({ id: 'b', launcherItems: () => [{ id: 'go', title: 'B' }] }));
    expect(host.launcher({}).map((i) => i.id)).toEqual(['a:go', 'b:go']);
  });

  it('never lets an inserted command span two lines', () => {
    // The same rule as everywhere else: what is staged at a prompt must not become two commands.
    const host = new PluginHost();
    host.register(
      plugin({ launcherItems: () => [{ id: 'x', title: 'x', insert: 'a\nrm -rf ~' }] }),
    );
    expect(host.launcher({})[0]?.insert).toBe('a rm -rf ~');
  });

  it('caps how many items are taken', () => {
    const host = new PluginHost();
    host.register(
      plugin({
        launcherItems: () =>
          Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: `item ${String(i)}` })),
      }),
    );
    expect(host.launcher({}).length).toBeLessThanOrEqual(12);
  });

  it('drops an item with no id or title', () => {
    const host = new PluginHost();
    host.register(
      plugin({
        launcherItems: () => [
          { id: '', title: 'no id' },
          { id: 'x', title: '' },
          { id: 'ok', title: 'fine' },
        ],
      }),
    );
    expect(host.launcher({})).toHaveLength(1);
  });

  it('withholds the cwd from a plugin without the capability', () => {
    let seen: { cwd?: string } | undefined;
    const host = new PluginHost();
    host.register({
      manifest: { id: 'p', name: 'p', capabilities: ['contribute-launcher'] },
      launcherItems: (ctx) => {
        seen = ctx;
        return [];
      },
    });
    host.launcher({ cwd: '/secret/place' });
    expect(seen).toEqual({});
  });
});

describe('session events', () => {
  it('delivers to every plugin, filtered by capability', () => {
    const seen: Record<string, unknown> = {};
    const host = new PluginHost();
    host.register({
      manifest: { id: 'full', name: 'full', capabilities: ['read-cwd', 'read-command-text'] },
      onSessionEvent: (e) => {
        seen['full'] = e.session;
      },
    });
    host.register({
      manifest: { id: 'bare', name: 'bare', capabilities: [] },
      onSessionEvent: (e) => {
        seen['bare'] = e.session;
      },
    });

    host.notify({ type: 'command-start', session });
    expect(seen['full']).toEqual({ sessionId: 's1', cwd: '/w/app', command: 'npm test' });
    expect(seen['bare']).toEqual({ sessionId: 's1' });
  });

  it('survives a plugin that throws in an event handler', () => {
    const host = new PluginHost();
    host.register({
      manifest: { id: 'bad', name: 'bad', capabilities: [] },
      onSessionEvent: () => {
        throw new Error('nope');
      },
    });
    expect(() => host.notify({ type: 'cwd-change', session })).not.toThrow();
    expect(host.disabledReason('bad')).toContain('nope');
  });
});
