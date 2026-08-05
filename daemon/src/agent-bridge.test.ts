import { describe, expect, it } from 'vitest';
import { mapHookToState } from './agent-bridge.js';

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
    expect(mapHookToState('SubagentStop')).toBe('idle');
  });

  it('ignores a hook it does not recognise rather than guessing', () => {
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
