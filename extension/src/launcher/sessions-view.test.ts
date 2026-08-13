import { describe, expect, it } from 'vitest';
import { describe as describeSession, shortPath, since } from './sessions-view.js';
import type { LiveSession } from '@tabterm/shared';

const base: LiveSession = {
  sessionId: 's',
  cwd: '/Users/someone/Projects/app',
  attached: false,
  startedAt: 0,
  preview: [],
  busy: false,
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
