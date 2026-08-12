import { describe, expect, it } from 'vitest';
import { isSticky, needsAttention, StatusMachine, titleStatus } from './status-machine.js';

describe('what a tab shows', () => {
  it('shows nothing at all with no panes', () => {
    expect(new StatusMachine().effective()).toBe('disconnected');
  });

  it('separates a command that succeeded from one that never ran', () => {
    const m = new StatusMachine();
    m.set('a', 'running');
    m.finished('a', 0);
    // Not idle. "Finished" is the thing somebody walked away to find out.
    expect(m.effective()).toBe('success');
  });

  it('refuses to call an unknown outcome a success', () => {
    // Without shell integration there is no exit code, and a tick would claim something no
    // evidence supports.
    const m = new StatusMachine();
    m.finished('a', undefined);
    expect(m.effective()).toBe('done');
    expect(titleStatus(m, 1)).toBe('finished');
  });

  it('surfaces the pane that needs a person, whatever the others are doing', () => {
    const m = new StatusMachine();
    m.set('a', 'running');
    m.set('b', 'success');
    m.set('c', 'approval');
    expect(m.effective()).toBe('approval');
  });

  it('puts waiting above a failure, because one of them is still fixable now', () => {
    const m = new StatusMachine();
    m.set('a', 'failed');
    m.set('b', 'waiting');
    expect(m.effective()).toBe('waiting');
  });
});

describe('outcomes wait to be seen', () => {
  it('keeps success until the tab is actually looked at', () => {
    const m = new StatusMachine();
    m.finished('a', 0);
    expect(m.effective()).toBe('success');
    expect(m.seen()).toBe(true);
    expect(m.effective()).toBe('idle');
  });

  it('keeps a failure the same way', () => {
    const m = new StatusMachine();
    m.finished('a', 1);
    expect(m.effective()).toBe('failed');
    m.seen();
    expect(m.effective()).toBe('idle');
  });

  it('leaves a running pane alone when the tab is looked at', () => {
    const m = new StatusMachine();
    m.set('a', 'running');
    expect(m.seen()).toBe(false);
    expect(m.effective()).toBe('running');
  });

  it('does not clear an approval, which is answered rather than noticed', () => {
    const m = new StatusMachine();
    m.set('a', 'approval');
    m.seen();
    expect(m.effective()).toBe('approval');
  });

  it('reports whether anything changed, so a pointless redraw can be skipped', () => {
    const m = new StatusMachine();
    m.set('a', 'idle');
    expect(m.seen()).toBe(false);
  });
});

describe('which states pulse', () => {
  it('pulses only for the ones that need a person', () => {
    expect(needsAttention('approval')).toBe(true);
    expect(needsAttention('waiting')).toBe(true);
    expect(needsAttention('running')).toBe(false);
    expect(needsAttention('failed')).toBe(false);
  });

  it('makes outcomes sticky and conditions not', () => {
    expect(isSticky('success')).toBe(true);
    expect(isSticky('failed')).toBe(true);
    expect(isSticky('running')).toBe(false);
    expect(isSticky('approval')).toBe(false);
  });
});

describe('the title', () => {
  it('says the most urgent thing and stops', () => {
    const m = new StatusMachine();
    m.set('a', 'running');
    m.set('b', 'approval');
    expect(titleStatus(m, 2)).toBe('needs approval');
  });

  it('counts running panes only when there is more than one pane', () => {
    const m = new StatusMachine();
    m.set('a', 'running');
    expect(titleStatus(m, 1)).toBe('');
    m.set('b', 'running');
    expect(titleStatus(m, 2)).toBe('2 running');
  });

  it('says done for a finished command', () => {
    const m = new StatusMachine();
    m.finished('a', 0);
    expect(titleStatus(m, 1)).toBe('done');
  });
});
