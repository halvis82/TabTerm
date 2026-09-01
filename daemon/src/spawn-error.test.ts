import { describe, expect, it } from 'vitest';
import { readableSpawnError } from './pty-host/client.js';
import { resolveExecutable } from './login-path.js';

describe('what a failed spawn tells the person', () => {
  it('names the command and says where it was looked for', () => {
    // The tab used to show an exit code and nothing else, which cannot distinguish a missing
    // agent CLI from a crash.
    const said = readableSpawnError('Error: claude: command not found');
    expect(said).toContain('claude');
    expect(said).toContain('PATH');
  });

  it('translates the errno cases into something actionable', () => {
    expect(readableSpawnError('spawn ENOENT')).toMatch(/could not be found/);
    expect(readableSpawnError('spawn EACCES')).toMatch(/not executable/);
  });

  it('passes an unrecognized failure through rather than replacing it', () => {
    expect(readableSpawnError('Error: something nobody predicted')).toContain(
      'something nobody predicted',
    );
  });

  it('still says something when there is no message at all', () => {
    expect(readableSpawnError('')).toMatch(/could not be started/);
  });
});

describe('finding a command on a PATH', () => {
  it('finds one that is there', () => {
    expect(resolveExecutable('sh', '/usr/bin:/bin')).toBe('/bin/sh');
  });

  it('returns nothing for one that is not, rather than guessing', () => {
    expect(resolveExecutable('definitely-not-a-real-command', '/usr/bin:/bin')).toBeNull();
  });

  it('takes an absolute path as given', () => {
    expect(resolveExecutable('/bin/sh', '/nowhere')).toBe('/bin/sh');
  });

  it('refuses a relative path, which would depend on where the daemon happens to be', () => {
    expect(resolveExecutable('./thing', '/usr/bin')).toBeNull();
  });
});
