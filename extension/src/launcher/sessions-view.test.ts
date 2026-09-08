import { describe, expect, it } from 'vitest';
import {
  describe as describeSession,
  formatBytes,
  shortPath,
  shortenFromLeft,
  since,
} from './sessions-view.js';
import type { LiveSession } from '@tabterm/shared';

const base: LiveSession = {
  sessionId: 's',
  cwd: '/Users/someone/Projects/app',
  attached: false,
  startedAt: 0,
  preview: [],
  busy: false,
  memoryBytes: 0,
};

describe('paths as a person reads them', () => {
  it('shortens the home directory', () => {
    expect(shortPath('/Users/someone/Projects/app', '/Users/someone')).toBe('~/Projects/app');
  });

  it('shortens home even when the daemon did not say where home is', () => {
    expect(shortPath('/Users/someone/x', '')).toBe('~/x');
  });

  it('leaves a path outside home alone', () => {
    expect(shortPath('/etc/hosts', '/Users/someone')).toBe('/etc/hosts');
  });
});

describe('how long ago', () => {
  const now = 1_000_000_000;
  it('says just now for the last minute', () => {
    expect(since(now - 30_000, now)).toBe('just now');
  });
  it('rolls up through minutes, hours and days', () => {
    expect(since(now - 300_000, now)).toBe('5m ago');
    expect(since(now - 7_200_000, now)).toBe('2h ago');
    expect(since(now - 172_800_000, now)).toBe('2d ago');
  });
});

describe('what a session is doing', () => {
  it('names the running command when one is in flight', () => {
    expect(describeSession({ ...base, busy: true, lastCommand: 'npm test' })).toBe('npm test');
  });

  it('names the program when it is not a plain shell', () => {
    expect(describeSession({ ...base, process: 'nvim' })).toBe('nvim');
  });

  it('says shell rather than zsh, which is not what people call it', () => {
    expect(describeSession({ ...base, process: 'zsh' })).toBe('shell');
    expect(describeSession(base)).toBe('shell');
  });
});

describe('a session somebody named', () => {
  it('is called what they called it, over anything derived', () => {
    // The one line on the card they wrote themselves. A last command is a guess at what the
    // terminal is for; a name is an answer.
    const named = { ...base, name: 'deploy box', process: 'nvim', lastCommand: 'npm test' };
    expect(describeSession(named)).toBe('deploy box');
  });

  it('and a name of only spaces is not a name', () => {
    // Trimmed to nothing on the way out of the daemon, so the card falls back rather than
    // rendering a blank line where the description belongs.
    expect(describeSession({ ...base, process: 'nvim' })).toBe('nvim');
  });
});

describe('a path too long for a card', () => {
  it('keeps the end, which is the part that identifies it', () => {
    const short = shortenFromLeft('~/Documents/personal_coding/TabTerm/daemon/src', 30);
    expect(short.endsWith('daemon/src')).toBe(true);
    expect(short.startsWith('…/')).toBe(true);
  });

  it('drops whole segments, never half a directory name', () => {
    // Cutting mid-name gives "…rsonal_coding/TabTerm", which reads as a typo rather than a path.
    const short = shortenFromLeft('~/Documents/personal_coding/TabTerm/daemon/src', 30);
    for (const segment of short.replace('…/', '').split('/')) {
      expect('~/Documents/personal_coding/TabTerm/daemon/src'.split('/')).toContain(segment);
    }
  });

  it('leaves a path that already fits completely alone', () => {
    expect(shortenFromLeft('~/Projects/app', 30)).toBe('~/Projects/app');
  });

  it('keeps the last segment whole even when it alone is too long', () => {
    // An ellipsis and nothing else says less than a name that overflows its box, which the
    // stylesheet still clips.
    expect(shortenFromLeft('/very/deep/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 20)).toBe(
      '…/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('is the fix for the two things CSS could not do at once', () => {
    /**
     * `direction: rtl` clips on the left but reorders a path, because a path is bidi-neutral:
     * `~/Downloads/test6` was drawn as `Downloads/test6/~`. `unicode-bidi: plaintext` stops the
     * reordering and puts the clip back on the right. Doing it here gets both.
     */
    expect(shortenFromLeft('~/Downloads/test6', 30)).toBe('~/Downloads/test6');
    // Eleven characters plus the ellipsis is exactly the twelve allowed, so it all fits.
    expect(shortenFromLeft('~/Downloads/test6/a/b/c/d/e/f/g/h', 12)).toBe('…/c/d/e/f/g/h');
  });
});

describe('memory as a person reads it', () => {
  it('says nothing when there is nothing to say', () => {
    expect(formatBytes(0)).toBe('');
  });
  it('uses kilobytes below a megabyte', () => {
    expect(formatBytes(200 * 1024)).toBe('200 KB');
  });
  it('keeps one decimal where it matters and drops it where it does not', () => {
    expect(formatBytes(3.45 * 1024 * 1024)).toBe('3.5 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
  });
});

/**
 * What a card says about a session, when almost all of them are shells in different folders.
 *
 * "shell" was the answer for nearly every card, which made the one line meant to tell them apart
 * the one line they all shared.
 */
describe('what a session card calls a session', () => {
  const base: LiveSession = {
    sessionId: 's',
    cwd: '/Users/someone/work',
    attached: false,
    startedAt: 0,
    preview: [],
    busy: false,
    memoryBytes: 0,
  };

  it('says what is running when something is', () => {
    expect(describeSession({ ...base, busy: true, lastCommand: 'npm run build' })).toBe(
      'npm run build',
    );
  });

  it('says the program when it is not a shell', () => {
    expect(describeSession({ ...base, process: 'vim' })).toBe('vim');
  });

  it('says the last command rather than the name of the shell it ran in', () => {
    expect(describeSession({ ...base, process: 'zsh', lastCommand: 'git status' })).toBe(
      'git status',
    );
  });

  it('does not mistake any of the shells for a program worth naming', () => {
    for (const shell of ['zsh', 'bash', 'fish', '-zsh']) {
      expect(describeSession({ ...base, process: shell, lastCommand: 'ls -la' }), shell).toBe(
        'ls -la',
      );
    }
  });

  it('says shell only when nothing has ever run there, where it is the truth', () => {
    expect(describeSession({ ...base, process: 'zsh' })).toBe('shell');
    expect(describeSession(base)).toBe('shell');
  });
});
