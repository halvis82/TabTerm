import { describe, expect, it } from 'vitest';
import { AttentionMonitor, judgeAttention, type AttentionFacts } from './attention.js';

const healthy: AttentionFacts = {
  installed: true,
  fullDiskAccess: true,
  appPath: '/Users/someone/.local/libexec/tabterm/TabTerm.app',
  hostExecutable: '/Users/someone/.local/libexec/tabterm/TabTerm.app/Contents/MacOS/node',
  bundledNode: '/Users/someone/.local/libexec/tabterm/TabTerm.app/Contents/MacOS/node',
  hostPid: 4242,
  updatePhase: 'current',
  updateMessage: 'Your companion is up to date.',
  ptysUsed: 24,
  ptysMax: 511,
};

/**
 * The doctor script says all of this once, at install. These are the same judgements made
 * live, so the person hears about a missing grant on the afternoon it starts to matter.
 */
describe('what needs attention', () => {
  it('says nothing on a healthy install', () => {
    expect(judgeAttention(healthy)).toEqual([]);
  });

  it('calls a missing Full Disk Access grant a problem, with the path to add', () => {
    const [concern] = judgeAttention({ ...healthy, fullDiskAccess: false });
    expect(concern?.id).toBe('full-disk-access');
    expect(concern?.level).toBe('problem');
    expect(concern?.fix).toContain(healthy.appPath);
    expect(concern?.fix, 'and says to remove a stale entry first').toContain('press minus first');
  });

  it('says nothing about Full Disk Access when it could not be told', () => {
    expect(judgeAttention({ ...healthy, fullDiskAccess: null })).toEqual([]);
  });

  it('says nothing about permissions from a development checkout', () => {
    // A checkout runs as plain node and is not the thing the grant is for.
    expect(judgeAttention({ ...healthy, installed: false, fullDiskAccess: false })).toEqual([]);
  });

  it('notes a host running an older binary, and names the pid to end it', () => {
    const [concern] = judgeAttention({
      ...healthy,
      hostExecutable: '/opt/homebrew/bin/node',
      hostPid: 30859,
    });
    expect(concern?.id).toBe('host-from-before-update');
    expect(concern?.level, 'a note, since fixing it ends every terminal').toBe('note');
    expect(concern?.fix).toContain('kill 30859');
  });

  it('says nothing about a host when none is running', () => {
    expect(judgeAttention({ ...healthy, hostExecutable: null, hostPid: null })).toEqual([]);
  });

  it('calls an interrupted update a problem and a failed check a note', () => {
    expect(judgeAttention({ ...healthy, updatePhase: 'manual' })[0]?.level).toBe('problem');
    expect(judgeAttention({ ...healthy, updatePhase: 'error' })[0]?.level).toBe('note');
    expect(judgeAttention({ ...healthy, updatePhase: 'rolled-back' })[0]?.level).toBe('note');
    expect(judgeAttention({ ...healthy, updatePhase: 'available' })).toEqual([]);
  });

  /**
   * The machine once hit this ceiling and no application could open a terminal until a restart.
   * It is machine-wide, so the fix says so, and it is a problem whatever daemon noticed it.
   */
  it('calls a Mac nearly out of pseudo-terminals a problem, counting every app', () => {
    const [concern] = judgeAttention({ ...healthy, ptysUsed: 470, ptysMax: 511 });
    expect(concern?.id).toBe('ptys-nearly-exhausted');
    expect(concern?.level).toBe('problem');
    expect(concern?.detail).toContain('470 of 511');
    expect(judgeAttention({ ...healthy, ptysUsed: 400, ptysMax: 511 })).toEqual([]);
    expect(
      judgeAttention({ ...healthy, installed: false, ptysUsed: 500, ptysMax: 511 }),
    ).toHaveLength(1);
  });

  it('lists every concern, worst first', () => {
    const all = judgeAttention({
      ...healthy,
      fullDiskAccess: false,
      hostExecutable: '/usr/local/bin/node',
      updatePhase: 'manual',
    });
    expect(all.map((c) => c.id)).toEqual([
      'full-disk-access',
      'host-from-before-update',
      'update-needs-attention',
    ]);
    expect(
      judgeAttention({ ...healthy, fullDiskAccess: false, ptysUsed: 500, ptysMax: 511 }).map(
        (c) => c.id,
      ),
    ).toEqual(['full-disk-access', 'ptys-nearly-exhausted']);
  });
});

describe('the monitor', () => {
  it('speaks only when the answer changes', async () => {
    let facts = { ...healthy };
    const heard: number[] = [];
    const monitor = new AttentionMonitor({
      gather: () => Promise.resolve(facts),
      changed: (concerns) => heard.push(concerns.length),
    });
    await monitor.check();
    await monitor.check();
    expect(heard, 'nothing to say about a healthy install, and not twice').toEqual([]);
    facts = { ...healthy, fullDiskAccess: false };
    await monitor.check();
    await monitor.check();
    expect(heard).toEqual([1]);
    facts = { ...healthy };
    await monitor.check();
    expect(heard, 'and says so when it is fixed').toEqual([1, 0]);
  });
});
