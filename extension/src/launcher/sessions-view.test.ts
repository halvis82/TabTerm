import { describe, expect, it } from 'vitest';
import {
  badgeTextFor,
  describe as describeSession,
  formatBytes,
  isInATab,
  shortPath,
  shortenFromLeft,
  since,
} from './sessions-view.js';
import type { LiveSession } from '@tabterm/shared';

const base: LiveSession = {
  sessionId: 's',
  cwd: '/Users/someone/Projects/app',
  attached: false,
  inTab: false,
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

  /*
   * Days on their own are too coarse for this list. "2d ago" covers two days to nearly three, and
   * these are terminals somebody left running: which of two is older, and whether the one they are
   * thinking of is from yesterday evening or the morning before, is what the line is read for.
   */
  it('says the hours after the days, when there are any', () => {
    const hour = 3_600_000;
    expect(since(now - (2 * 24 + 5) * hour, now)).toBe('2d 5h ago');
    expect(since(now - (1 * 24 + 1) * hour, now)).toBe('1d 1h ago');
  });

  /*
   * And not "2d 0h", which is a number said for the sake of the shape of the sentence.
   */
  it('and leaves them off when there are none', () => {
    expect(since(now - 3 * 24 * 3_600_000, now)).toBe('3d ago');
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
    inTab: false,
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

/**
 * A tab Chrome has put to sleep is still a tab.
 *
 * `attached` is a live page. Chrome discards tabs it has not needed for a while: the tab stays in
 * the strip, the page is thrown away, and the socket goes with it. Terminals sitting in a second
 * window were therefore labelled `background`, which is also the name of the state that starts the
 * timer that ends a session, so the label was alarming as well as wrong.
 *
 * Nothing was ever at risk. The rule that ends a session asks whether a tab holds it, which is the
 * question this label now asks too.
 */
describe('what a session card says about where a session is', () => {
  const base = {
    sessionId: 's1',
    cwd: '/tmp',
    startedAt: Date.now(),
    preview: [],
    busy: false,
    memoryBytes: 0,
  };

  it('says it is in a tab when a page is showing it', () => {
    expect(badgeTextFor({ ...base, attached: true, inTab: true })).toBe('open in a tab');
  });

  it('and still says so when the tab is asleep and no page is attached', () => {
    expect(badgeTextFor({ ...base, attached: false, inTab: true })).toBe('open in a tab');
  });

  it('and says background only when no tab holds it at all', () => {
    expect(badgeTextFor({ ...base, attached: false, inTab: false })).toBe('background');
  });

  /*
   * And the card is painted from the same answer.
   *
   * The dot and the badge take their colour from `data-state`, which was worked out from
   * `attached` while the words were worked out from "a tab holds it". Once a sleeping tab counted
   * as held, two cards could say the same thing in different colours, which is a distinction the
   * interface was drawing that nothing meant.
   */
  it('and the look agrees with the words, including for a tab that is asleep', () => {
    for (const session of [
      { ...base, attached: true, inTab: true },
      { ...base, attached: false, inTab: true },
      { ...base, attached: false, inTab: false },
    ]) {
      const saysInTab = badgeTextFor(session) === 'open in a tab';
      expect(isInATab(session)).toBe(saysInTab);
    }
  });
});
