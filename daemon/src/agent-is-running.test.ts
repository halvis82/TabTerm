import { describe, expect, it } from 'vitest';
import { agentIsRunning } from './server-detect.js';

describe('agentIsRunning', () => {
  it('is true for a session an agent has reported from', () => {
    expect(agentIsRunning({ agentState: 'idle' })).toBe(true);
  });
  it('is true for an agent command, past runners and variables', () => {
    expect(agentIsRunning({ pendingCommand: 'claude --resume abc' })).toBe(true);
    expect(agentIsRunning({ pendingCommand: 'FOO=1 npx codex' })).toBe(true);
    expect(agentIsRunning({ foregroundProcess: 'codex' })).toBe(true);
  });
  it('is false for a server somebody started', () => {
    expect(agentIsRunning({ pendingCommand: 'npm run dev', foregroundProcess: 'node' })).toBe(
      false,
    );
    expect(agentIsRunning({})).toBe(false);
  });
});
