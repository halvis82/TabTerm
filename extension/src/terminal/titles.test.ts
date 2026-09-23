import { describe, expect, it } from 'vitest';
import { composeTitle } from './titles.js';

/**
 * A tab strip is read sideways, at a glance, and cut off.
 *
 * So the useful half of a title is the front of it, and the rule is the same shape every time:
 * what this is, then where it is. Where is the folder's own name rather than a path, because a
 * path puts the answer at the end of a string that has already been truncated.
 */
/**
 * An agent is called by its name, not by the command that started it.
 *
 * The configured command carries flags, and a tab strip read
 * `<name> — claude --dangerously-skip-permissions`, where everything past the first word is the
 * same on every agent tab somebody has.
 */
describe('a tab running an agent', () => {
  it('is called by the agent, not by its flags', () => {
    expect(
      composeTitle({ lastCommand: 'claude --dangerously-skip-permissions', cwd: '/Users/me/app' }),
    ).toBe('claude — app');
  });

  it('and by the agent when it was started through a path', () => {
    expect(composeTitle({ lastCommand: '/opt/wrap/codex --search', cwd: '/Users/me/app' })).toBe(
      'codex — app',
    );
  });

  it('while an ordinary command is still said as it was typed', () => {
    expect(composeTitle({ lastCommand: 'npm run build', cwd: '/Users/me/app' })).toBe(
      'npm run build — app',
    );
  });

  it('and a long one is still cut', () => {
    const long = 'npm run build --workspace daemon --verbose';
    expect(composeTitle({ lastCommand: long, cwd: '/Users/me/app' })).toBe(
      'npm run build --workspac… — app',
    );
  });
});

describe('what a tab is called', () => {
  it('is just the product on the page you land on', () => {
    expect(composeTitle({ startScreen: true, cwd: '/Users/someone' })).toBe('TabTerm — ~');
  });

  it('is the last command and the folder, for one terminal', () => {
    expect(composeTitle({ cwd: '/Users/someone/code/eeg', lastCommand: 'npm test' })).toBe(
      'npm test — eeg',
    );
  });

  it('shortens a long command rather than letting the folder fall off the end', () => {
    const title = composeTitle({
      cwd: '/Users/someone/code/eeg',
      lastCommand: 'npm run build --workspace daemon --silent',
    });
    expect(title.endsWith('— eeg')).toBe(true);
    expect(title.length).toBeLessThan(40);
  });

  it('names the agent rather than the command that started it', () => {
    expect(composeTitle({ cwd: '/Users/someone/code/eeg', process: 'claude' })).toBe(
      'claude — eeg',
    );
    expect(composeTitle({ cwd: '/Users/someone/code/eeg', process: 'codex' })).toBe('codex — eeg');
  });

  it('prefers the agent to whatever was last typed, since the agent is what is there', () => {
    expect(
      composeTitle({ cwd: '/Users/someone/code/eeg', process: 'claude', lastCommand: 'ls' }),
    ).toBe('claude — eeg');
  });

  it('names a layout after its template', () => {
    expect(composeTitle({ cwd: '/Users/someone/code/eeg', template: 'review', paneCount: 3 })).toBe(
      'review — eeg',
    );
  });

  /**
   * And stops, the moment it is not that template any more.
   *
   * Closing a pane makes an arrangement that is not the thing somebody opened, and a title that
   * kept the name would be quietly wrong for the rest of the tab's life.
   */
  it('falls back to the count when a pane has gone', () => {
    expect(composeTitle({ cwd: '/Users/someone/code/eeg', paneCount: 2 })).toBe('2 panes — eeg');
  });

  it('says the shell when nothing has been run yet', () => {
    // A fresh terminal has no command to name and is not the start screen. It is a shell.
    expect(composeTitle({ cwd: '/Users/someone/code/eeg' })).toBe('zsh — eeg');
  });

  it('never produces an empty title, even knowing nothing at all', () => {
    expect(composeTitle({})).not.toBe('');
  });

  /**
   * A name somebody typed goes in front of what the tab would have been called anyway.
   *
   * It is the one part of a title that was chosen rather than derived, and a tab strip is read
   * from the left, so it has to be the half that survives being cut off.
   */
  describe('a session somebody named', () => {
    const fields = { cwd: '/Users/someone/code/eeg', process: 'claude' };

    it('puts the name first and keeps the rest', () => {
      expect(composeTitle(fields, undefined, 'training run')).toBe('training run — claude — eeg');
    });

    it('keeps the status on the end where it always was', () => {
      expect(composeTitle(fields, 'waiting', 'training run')).toBe(
        'training run — claude — eeg · waiting',
      );
    });

    it('goes in front even when all the tab can say is that it is a shell', () => {
      expect(composeTitle({}, undefined, 'scratch')).toBe('scratch — zsh');
    });

    it('ignores a name that is only spaces', () => {
      // The form trims before it stores, and a title is not the place to find out it did not.
      expect(composeTitle(fields, undefined, '   ')).toBe('claude — eeg');
    });

    it('is absent when the tab holds more than one pane', () => {
      // Decided by the caller, which only passes a name for a tab that is one session. Asserted
      // here so the rule is written down where the composition is.
      expect(composeTitle({ cwd: '/Users/someone/code/eeg', paneCount: 3 })).toBe('3 panes — eeg');
    });
  });
});
