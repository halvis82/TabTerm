import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { decideReap, describeReap, type ReapInput } from './cleanup.js';

const config: Config = { ...DEFAULTS };

const base: ReapInput = {
  pinned: false,
  persistent: false,
  attachedClients: 0,
  inWorkspace: false,
  exited: false,
  hasExplicitCommand: false,
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

  it('recognises a long-lived program given by absolute path', () => {
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
