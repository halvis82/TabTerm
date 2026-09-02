import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { decideReap, describeReap, type ReapInput } from './cleanup.js';

const config: Config = { ...DEFAULTS };

/**
 * `hasOpenTab: false` in the base, deliberately.
 *
 * Every timer in this policy only starts once the tab is known to be gone, so a fixture that
 * left this unknown would test nothing but the "we cannot tell, so keep it" rule.
 */
const base: ReapInput = {
  pinned: false,
  persistent: false,
  attachedClients: 0,
  hasOpenTab: false,
  inWorkspace: false,
  exited: false,
  hasExplicitCommand: false,
  neverUsed: false,
  keepBackgroundSeconds: null,
};

const decide = (over: Partial<ReapInput>) => decideReap({ ...base, ...over }, config);

describe('reap policy', () => {
  it('never reaps a pinned session', () => {
    const d = decide({ pinned: true });
    expect(d.afterSeconds).toBeNull();
    expect(d.reason).toBe('pinned');
  });

  it('never reaps a session marked persistent', () => {
    expect(decide({ persistent: true }).afterSeconds).toBeNull();
  });

  it('never reaps a session someone is still looking at', () => {
    const d = decide({ attachedClients: 1 });
    expect(d.afterSeconds).toBeNull();
    expect(d.reason).toBe('still-attached');
  });

  it('never reaps a pane in a workspace', () => {
    // Workspaces are pinned by default, so closing a tab must not destroy a layout someone
    // deliberately built. See ADR-0012.
    const d = decide({ inWorkspace: true });
    expect(d.afterSeconds).toBeNull();
    expect(d.reason).toBe('in-a-workspace');
  });

  it('never reaps a session holding a listening socket', () => {
    // Killing someone's dev server because they closed a tab would be the worst possible
    // behavior, so it is protected and they get warned instead.
    const d = decide({ listeningPort: 3000 });
    expect(d.afterSeconds).toBeNull();
    expect(d.reason).toBe('server-listening');
  });

  it('cleans up quickly after the process has already exited', () => {
    const d = decide({ exited: true });
    expect(d.afterSeconds).toBeGreaterThan(0);
    expect(d.afterSeconds).toBeLessThan(60);
    expect(d.reason).toBe('process-exited');
  });

  it('gives an editor or agent the longer grace period', () => {
    const d = decide({ foregroundProgram: 'nvim', hasExplicitCommand: true });
    expect(d.afterSeconds).toBe(config.reapAgentOrEditorSeconds);
    expect(d.reason).toBe('long-lived-program');
  });

  it('recognizes a long-lived program given by absolute path', () => {
    const d = decide({ foregroundProgram: '/opt/homebrew/bin/nvim', hasExplicitCommand: true });
    expect(d.reason).toBe('long-lived-program');
  });

  it('gives a plain idle shell the shortest grace period', () => {
    const d = decide({});
    expect(d.afterSeconds).toBe(config.reapIdleShellSeconds);
    expect(d.reason).toBe('idle-shell');
  });

  it('gives an arbitrary command the default grace period', () => {
    const d = decide({ foregroundProgram: 'make', hasExplicitCommand: true });
    expect(d.afterSeconds).toBe(config.reapDefaultSeconds);
    expect(d.reason).toBe('default');
  });

  it('puts protection ahead of expiry when several rules could apply', () => {
    // A pinned, exited, workspace-resident session must still be protected: the most
    // protective rule wins, never the most eager one.
    const d = decide({ pinned: true, exited: true, inWorkspace: true, listeningPort: 8080 });
    expect(d.afterSeconds).toBeNull();
    expect(d.reason).toBe('pinned');
  });

  it('protects a workspace pane even when it is an idle shell', () => {
    expect(decide({ inWorkspace: true, hasExplicitCommand: false }).afterSeconds).toBeNull();
  });

  it('always explains itself', () => {
    for (const over of [
      { pinned: true },
      { exited: true },
      { listeningPort: 1 },
      { foregroundProgram: 'vim', hasExplicitCommand: true },
      {},
    ]) {
      const d = decide(over);
      expect(describeReap(d)).toMatch(/\w/);
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it('honors configured grace periods rather than hardcoding them', () => {
    const custom: Config = { ...DEFAULTS, reapIdleShellSeconds: 7, reapAgentOrEditorSeconds: 11 };
    expect(decideReap(base, custom).afterSeconds).toBe(7);
    expect(
      decideReap({ ...base, foregroundProgram: 'vim', hasExplicitCommand: true }, custom)
        .afterSeconds,
    ).toBe(11);
  });
});

describe('a pane whose tab was closed', () => {
  it('is kept forever when that is what was chosen', () => {
    // ADR-0012's original behavior, still available by choosing it.
    const decision = decideReap(
      { ...base, inWorkspace: true, keepBackgroundSeconds: null },
      DEFAULTS,
    );
    expect(decision.afterSeconds).toBe(null);
    expect(decision.reason).toBe('in-a-workspace');
  });

  it('expires after the configured time by default', () => {
    // Sessions survive restarts now, so "forever" became literal and they accumulated.
    const decision = decideReap(
      { ...base, inWorkspace: true, keepBackgroundSeconds: 900 },
      DEFAULTS,
    );
    expect(decision.afterSeconds).toBe(900);
    expect(decision.reason).toBe('tab-closed');
  });

  it('is still kept while a tab is showing it', () => {
    const decision = decideReap(
      { ...base, inWorkspace: true, attachedClients: 1, keepBackgroundSeconds: 900 },
      DEFAULTS,
    );
    expect(decision.afterSeconds).toBe(null);
  });

  it('is still kept when it holds a listening server', () => {
    // Killing somebody's dev server on a timer would be the worst version of this feature.
    const decision = decideReap(
      { ...base, inWorkspace: false, listeningPort: 3000, keepBackgroundSeconds: 900 },
      DEFAULTS,
    );
    expect(decision.afterSeconds).toBe(null);
  });
});

describe('a tab opened and closed without being used', () => {
  const unused: ReapInput = {
    ...base,
    inWorkspace: true,
    neverUsed: true,
    keepBackgroundSeconds: 900,
  };

  it('goes quickly rather than being held for the background timeout', () => {
    // Otherwise a machine accumulates dozens of identical shells in the home directory, which
    // is what made the session list unreadable.
    const decision = decideReap(unused, config);
    expect(decision.reason).toBe('never-used');
    expect(decision.afterSeconds).toBe(30);
  });

  it('is still recoverable for a few seconds, so an accidental close is not final', () => {
    expect(decideReap(unused, config).afterSeconds).toBeGreaterThan(0);
  });

  it('does not apply once something has been run', () => {
    expect(decideReap({ ...unused, neverUsed: false }, config).reason).toBe('tab-closed');
  });

  it('never applies to a session holding a listening socket', () => {
    // A dev server started from a pane means the pane was used, whatever the flags say.
    expect(decideReap({ ...unused, listeningPort: 3000 }, config).reason).not.toBe('never-used');
  });

  it('never applies to a session opened to run a specific command', () => {
    expect(decideReap({ ...unused, hasExplicitCommand: true }, config).reason).not.toBe(
      'never-used',
    );
  });

  it('is still outranked by pinning', () => {
    expect(decideReap({ ...unused, pinned: true }, config).afterSeconds).toBeNull();
  });
});

describe('a tab that still exists', () => {
  /**
   * The defect this answers: a session was reaped while its tab was plainly open, seventeen
   * hours after its last command. The tab had been discarded or the machine had slept, so the
   * socket was gone and the daemon counted zero attached clients. A connection is evidence that
   * somebody is looking right now. It was never evidence that the tab had been closed.
   */
  it('is never reaped, whatever else is true of it', () => {
    expect(decide({ hasOpenTab: true, inWorkspace: true, keepBackgroundSeconds: 60 })).toEqual({
      afterSeconds: null,
      reason: 'tab-open',
    });
    // Not even the never-used rule, which is otherwise the most eager one there is.
    expect(decide({ hasOpenTab: true, inWorkspace: true, neverUsed: true })).toEqual({
      afterSeconds: null,
      reason: 'tab-open',
    });
  });

  it('is kept when nobody could tell us either way', () => {
    // Chrome closed, crashed, or not yet reported. All of them are a gap in what we know, and
    // the only safe reading of "I do not know" is to keep the terminal.
    expect(decide({ hasOpenTab: null, inWorkspace: true, keepBackgroundSeconds: 60 })).toEqual({
      afterSeconds: null,
      reason: 'no-report',
    });
  });

  it('starts its clock only once the tab is actually gone', () => {
    expect(decide({ hasOpenTab: false, inWorkspace: true, keepBackgroundSeconds: 1800 })).toEqual({
      afterSeconds: 1800,
      reason: 'tab-closed',
    });
  });

  it('still lets an explicit choice to keep everything win', () => {
    expect(decide({ hasOpenTab: false, inWorkspace: true, keepBackgroundSeconds: null })).toEqual({
      afterSeconds: null,
      reason: 'in-a-workspace',
    });
  });
});
