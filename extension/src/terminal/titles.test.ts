import { describe, expect, it } from 'vitest';
import { composeTitle } from './titles.js';

/**
 * A tab strip is read sideways, at a glance, and cut off.
 *
 * So the useful half of a title is the front of it, and the rule is the same shape every time:
 * what this is, then where it is. Where is the folder's own name rather than a path, because a
 * path puts the answer at the end of a string that has already been truncated.
 */
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
});
