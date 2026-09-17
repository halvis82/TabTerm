import { describe, expect, it } from 'vitest';
import { resumeCommandFor } from './resume-command.js';

/**
 * Taking an agent conversation to another terminal.
 *
 * `claude --resume <id>` does work from any directory, which was checked rather than assumed. What
 * it does not do is put the agent back in the folder the conversation was about, so a resumed
 * session read and wrote the wrong files while showing the right transcript. The directory is
 * therefore part of what gets copied.
 */
describe('the command that resumes an agent session', () => {
  it('goes to the folder first, then resumes', () => {
    expect(resumeCommandFor('abc-123', '/Users/someone/work')).toBe(
      'cd /Users/someone/work && claude --resume abc-123',
    );
  });

  /*
   * `&&` rather than `;`. A folder that has been renamed since should stop the command, not start
   * an agent wherever the paste happened to land.
   */
  it('and stops if the folder is not there any more', () => {
    expect(resumeCommandFor('abc-123', '/tmp/gone')).toContain(' && ');
    expect(resumeCommandFor('abc-123', '/tmp/gone')).not.toContain(';');
  });

  it('quotes a folder with a space in it, because this is pasted into a shell', () => {
    expect(resumeCommandFor('abc', '/Users/someone/My Work')).toBe(
      "cd '/Users/someone/My Work' && claude --resume abc",
    );
  });

  it('is just the resume when nothing knows where the session was', () => {
    expect(resumeCommandFor('abc', '')).toBe('claude --resume abc');
  });
});
