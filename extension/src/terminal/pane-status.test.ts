import { describe, expect, it } from 'vitest';
import { PaneStatus, STATUS_PRIORITY } from './pane-status.js';

describe('reducing many panes to one tab indicator', () => {
  it('reports disconnected when there are no panes yet', () => {
    expect(new PaneStatus().effective()).toBe('disconnected');
  });

  it('reports the only pane when there is one', () => {
    const s = new PaneStatus();
    s.set('a', 'running');
    expect(s.effective()).toBe('running');
  });

  it('lets something waiting on a person beat anything merely running', () => {
    const s = new PaneStatus();
    s.set('a', 'running');
    s.set('b', 'approval');
    s.set('c', 'idle');
    expect(s.effective()).toBe('approval');
  });

  it('ranks a failure above a pane still working', () => {
    const s = new PaneStatus();
    s.set('a', 'running');
    s.set('b', 'failed');
    expect(s.effective()).toBe('failed');
  });

  it('prefers running over idle, so a busy tab does not look finished', () => {
    const s = new PaneStatus();
    s.set('a', 'idle');
    s.set('b', 'running');
    expect(s.effective()).toBe('running');
  });

  it('holds the documented priority order exactly', () => {
    expect(STATUS_PRIORITY).toEqual([
      'approval',
      'failed',
      'waiting',
      'running',
      'idle',
      'disconnected',
    ]);
  });

  it('falls back once the urgent pane goes away', () => {
    const s = new PaneStatus();
    s.set('a', 'approval');
    s.set('b', 'running');
    expect(s.effective()).toBe('approval');
    s.forget('a');
    expect(s.effective()).toBe('running');
  });

  it('drops panes that no longer exist', () => {
    const s = new PaneStatus();
    s.set('a', 'approval');
    s.set('b', 'idle');
    s.retain(['b']);
    expect(s.size).toBe(1);
    expect(s.effective()).toBe('idle');
  });

  it('counts panes in a state, for a title suffix', () => {
    const s = new PaneStatus();
    s.set('a', 'running');
    s.set('b', 'running');
    s.set('c', 'idle');
    expect(s.countIn('running')).toBe(2);
    expect(s.countIn('failed')).toBe(0);
  });
});
