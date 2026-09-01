import { describe, expect, it } from 'vitest';
import { interleaveByAgent, resumeCommand } from './agent-resume.js';

describe('asking an agent to resume', () => {
  it('uses a flag for claude', () => {
    expect(resumeCommand('claude', 'claude', 'abc')).toEqual(['claude', '--resume', 'abc']);
  });

  it('uses a subcommand for codex, which is the whole bug', () => {
    // `codex --resume <id>` is rejected. Every resume of a Codex session was that.
    expect(resumeCommand('codex', 'codex', 'abc')).toEqual(['codex', 'resume', 'abc']);
  });

  it('keeps a configured executable, including a wrapper script', () => {
    expect(resumeCommand('claude', '/opt/wrap/claude', 'x')).toEqual([
      '/opt/wrap/claude',
      '--resume',
      'x',
    ]);
    expect(resumeCommand('codex', '/opt/wrap/codex', 'x')).toEqual([
      '/opt/wrap/codex',
      'resume',
      'x',
    ]);
  });
});

describe('showing both agents in one short list', () => {
  const at = (agent: 'claude' | 'codex', modifiedAt: number) => ({ agent, modifiedAt });

  it('takes turns, so a busy agent cannot hide the other', () => {
    /**
     * The reason this exists: one agent is usually the one in daily use, so its conversations
     * are always the newest. Straight recency in a list cut to a few rows would never show a
     * single row for the other, and resuming it would be unreachable.
     */
    const merged = interleaveByAgent([
      at('claude', 100),
      at('claude', 99),
      at('claude', 98),
      at('codex', 50),
      at('codex', 40),
    ]);
    expect(merged.slice(0, 4).map((s) => s.agent)).toEqual(['claude', 'codex', 'claude', 'codex']);
  });

  it('still leads with the newest thing that happened', () => {
    expect(interleaveByAgent([at('claude', 10), at('codex', 90)])[0]?.agent).toBe('codex');
  });

  it('keeps recency within an agent', () => {
    const merged = interleaveByAgent([at('codex', 1), at('codex', 3), at('codex', 2)]);
    expect(merged.map((s) => s.modifiedAt)).toEqual([3, 2, 1]);
  });

  it('does not make an agent with nothing take a turn', () => {
    const merged = interleaveByAgent([at('claude', 2), at('claude', 1)]);
    expect(merged).toHaveLength(2);
  });

  it('loses nothing', () => {
    const many = [at('claude', 5), at('codex', 4), at('claude', 3), at('codex', 2), at('codex', 1)];
    expect(interleaveByAgent(many)).toHaveLength(many.length);
  });
});
