import { describe, expect, it } from 'vitest';
import { interleaveByAgent, resumeCommand, resumeCommandLine } from './agent-resume.js';

describe('asking an agent to resume', () => {
  it('uses a flag for claude', () => {
    expect(resumeCommand('claude', ['claude'], 'abc')).toEqual(['claude', '--resume', 'abc']);
  });

  it('uses a subcommand for codex, which is the whole bug', () => {
    // `codex --resume <id>` is rejected. Every resume of a Codex session was that.
    expect(resumeCommand('codex', ['codex'], 'abc')).toEqual(['codex', 'resume', 'abc']);
  });

  it('keeps a configured executable, including a wrapper script', () => {
    expect(resumeCommand('claude', ['/opt/wrap/claude'], 'x')).toEqual([
      '/opt/wrap/claude',
      '--resume',
      'x',
    ]);
    expect(resumeCommand('codex', ['/opt/wrap/codex'], 'x')).toEqual([
      '/opt/wrap/codex',
      'resume',
      'x',
    ]);
  });

  /**
   * And the rest of the configured command, which is what a conversation picked back up was
   * missing.
   *
   * It took the executable and dropped everything after it, so an agent started from the list came
   * up unconfigured: with `--dangerously-skip-permissions` set, a resumed session asked whether to
   * trust the folder, and that dialog took the keystrokes meant for the conversation.
   */
  it('keeps the flags the agent is configured with', () => {
    expect(resumeCommand('claude', ['claude', '--dangerously-skip-permissions'], 'abc')).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--resume',
      'abc',
    ]);
  });

  it('and puts them before the subcommand, where a subcommand CLI wants them', () => {
    expect(resumeCommand('codex', ['codex', '--search'], 'abc')).toEqual([
      'codex',
      '--search',
      'resume',
      'abc',
    ]);
  });

  it('and falls back to the plain name when nothing is configured', () => {
    expect(resumeCommand('claude', [], 'abc')).toEqual(['claude', '--resume', 'abc']);
  });
});

describe('showing both agents in one short list', () => {
  const at = (agent: 'claude' | 'codex', modifiedAt: number) => ({ agent, modifiedAt });

  it('reserves a place for the quieter agent, so a busy one cannot hide it', () => {
    /**
     * One agent is usually the one in daily use, so its conversations are always the newest, and
     * straight recency in a list cut to a few rows would never contain a single row for the
     * other. Resuming it would be present, correct and unreachable.
     */
    const merged = interleaveByAgent([
      at('claude', 100),
      at('claude', 99),
      at('claude', 98),
      at('codex', 50),
      at('codex', 40),
    ]);
    expect(merged.slice(0, 2).map((s) => s.agent)).toEqual(['claude', 'codex']);
  });

  it('and then orders by recency, rather than alternating forever', () => {
    /**
     * Alternating strictly was the first answer and overcorrected: half the rows belonged to
     * whichever agent was used less, however old they were. Measured on a real machine, four of
     * eight rows were codex sessions between two and twenty days old while claude sessions from
     * the same morning were not shown at all, which read as an arbitrary list.
     */
    const merged = interleaveByAgent([
      at('claude', 100),
      at('claude', 99),
      at('claude', 98),
      at('codex', 50),
      at('codex', 40),
    ]);
    // The newest of each, and after that the genuinely most recent.
    expect(merged.map((s) => s.modifiedAt)).toEqual([100, 50, 99, 98, 40]);
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

/**
 * The same thing as one line, because a resumed conversation now runs in a shell.
 *
 * It used to be spawned as the session's own command, which made the conversation the terminal
 * rather than a program running in one: interrupting it left a dead pane and no prompt.
 */
describe('the command line a shell is given', () => {
  it('is the argv, joined', () => {
    expect(resumeCommandLine('claude', ['claude'], 'abc-123')).toBe('claude --resume abc-123');
  });

  it('keeps the flags somebody configured', () => {
    expect(
      resumeCommandLine('claude', ['claude', '--dangerously-skip-permissions'], 'abc-123'),
    ).toBe('claude --dangerously-skip-permissions --resume abc-123');
  });

  it('puts a subcommand agent back together the same way', () => {
    expect(resumeCommandLine('codex', ['codex'], '01a0-ff')).toBe('codex resume 01a0-ff');
  });

  /*
   * This line is read by a shell, unlike the argv, so anything that is not plainly safe is
   * quoted. A wrapper script in a folder with a space in it is the ordinary case.
   */
  it('quotes a path with a space in it', () => {
    expect(resumeCommandLine('claude', ['/Applications/My Tools/claude'], 'id-1')).toBe(
      "'/Applications/My Tools/claude' --resume id-1",
    );
  });

  it('and a quote inside one', () => {
    expect(resumeCommandLine('claude', ["/home/o'brien/claude"], 'id-1')).toBe(
      "'/home/o'\\''brien/claude' --resume id-1",
    );
  });

  it('leaves an ordinary path alone rather than quoting everything', () => {
    // A line somebody reads back off their own screen should look like one they could have typed.
    expect(resumeCommandLine('claude', ['/usr/local/bin/claude'], 'id-1')).toBe(
      '/usr/local/bin/claude --resume id-1',
    );
  });
});
