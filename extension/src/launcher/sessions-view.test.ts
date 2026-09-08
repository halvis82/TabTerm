import { describe, expect, it } from 'vitest';
import { describe as describeSession, formatBytes, shortPath, since } from './sessions-view.js';
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
