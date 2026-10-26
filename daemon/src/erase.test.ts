import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eraseStoredState } from './erase.js';

/**
 * Erase everything, against a state folder laid out as a real one is: what somebody did in
 * TabTerm goes, and what the installer and macOS keep stays.
 */
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('erasing everything TabTerm has stored', () => {
  it('removes history, settings, remote access and copies, and keeps the token and logs', () => {
    dir = mkdtempSync(join(tmpdir(), 'tabterm-erase-'));
    for (const name of [
      'tabterm.sqlite',
      'tabterm.sqlite-wal',
      'settings.json',
      'remote.json',
      'token',
      'sign-identity',
      'asked-for-folders',
    ]) {
      writeFileSync(join(dir, name), 'x');
    }
    for (const folder of ['scrollback', 'dropped', 'logs', 'updates']) {
      mkdirSync(join(dir, folder));
      writeFileSync(join(dir, folder, 'a.log'), 'x');
    }
    expect(eraseStoredState(dir)).toBe(6);
    expect(readdirSync(dir).sort()).toEqual([
      'asked-for-folders',
      'dropped',
      'logs',
      'scrollback',
      'sign-identity',
      'token',
      'updates',
    ]);
    expect(readdirSync(join(dir, 'scrollback'))).toEqual([]);
    expect(readdirSync(join(dir, 'dropped'))).toEqual([]);
    expect(readdirSync(join(dir, 'logs'))).toEqual(['a.log']);
  });

  it('is fine with a folder that has nothing in it', () => {
    dir = mkdtempSync(join(tmpdir(), 'tabterm-erase-'));
    expect(eraseStoredState(dir)).toBe(0);
  });
});
