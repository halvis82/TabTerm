import { describe, expect, it } from 'vitest';
import { adoptedState, mapHookToState } from './agent-bridge.js';

describe('mapping agent hooks to state', () => {
  it('treats prompt submission and tool use as working', () => {
    expect(mapHookToState('UserPromptSubmit')).toBe('working');
    expect(mapHookToState('PreToolUse')).toBe('working');
  });

  it('distinguishes waiting for input from needing approval', () => {
    // These deserve different favicons: one is a question, the other is a gate.
    expect(mapHookToState('Notification')).toBe('waiting');
    expect(mapHookToState('PermissionRequest')).toBe('approval');
  });

  it('treats stopping as idle', () => {
    expect(mapHookToState('Stop')).toBe('idle');
  });

  it('does not let a subagent finishing say the agent is idle', () => {
    // It arrives mid-turn, and read as idle it ended the person's turn early.
    expect(mapHookToState('SubagentStop')).toBeNull();
  });

  it('ignores a hook it does not recognize rather than guessing', () => {
    // A future version emitting something new must not produce a confidently wrong state.
    // Showing nothing is better than showing the wrong thing.
    expect(mapHookToState('SomethingAddedNextYear')).toBeNull();
    expect(mapHookToState('')).toBeNull();
    expect(mapHookToState('preTooluse')).toBeNull();
  });

  it('never returns a state for arbitrary text', () => {
    for (const junk of ['../../etc/passwd', '{"a":1}', 'Stop; rm -rf /', 'STOP']) {
      expect(mapHookToState(junk), junk).toBeNull();
    }
  });
});

describe('which events change what the agent is doing', () => {
  it('takes a notification during a turn as the agent asking for somebody', () => {
    expect(adoptedState('Notification', 'waiting', 'working')).toBe('waiting');
  });

  it('leaves out the idle reminder that follows every finished turn', () => {
    // Sent about a minute after the agent stops. The stop was the news.
    expect(adoptedState('Notification', 'waiting', 'idle')).toBeNull();
    expect(adoptedState('Notification', 'waiting', 'starting')).toBeNull();
    expect(adoptedState('Notification', 'waiting', undefined)).toBeNull();
  });

  it('does not let a notification turn an approval into a wait', () => {
    expect(adoptedState('Notification', 'waiting', 'approval')).toBeNull();
  });

  it('passes every other event through', () => {
    expect(adoptedState('Stop', 'idle', 'working')).toBe('idle');
    expect(adoptedState('PreToolUse', 'working', 'idle')).toBe('working');
    expect(adoptedState('PermissionRequest', 'approval', 'working')).toBe('approval');
  });
});
