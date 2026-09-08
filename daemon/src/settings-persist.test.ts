import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from './config.js';
import { clampTimeout } from './server.js';
import { readUserSettings, updateUserSetting } from './user-settings.js';

/**
 * The setting a person chose is on disk, and comes back the way they chose it.
 *
 * Reported twice. The first time the test suite really was overwriting it, and both halves of
 * that are fixed. The second time the file was correct and the picker was not, which is a
 * different fault in the same feature and is why this is checked at the file rather than
 * anywhere further up: what is written and what is read back are the only two things that make a
 * setting persistent.
 */
describe('the background timeout on disk', () => {
  /**
   * The real file, in the temporary home the whole suite runs under.
   *
   * Checked through the same functions the daemon uses rather than by parsing the file here,
   * because what makes a setting persistent is exactly that those two agree.
   */
  const file = join(paths.state, 'settings.json');
  const put = (contents: string): void => {
    mkdirSync(paths.state, { recursive: true });
    writeFileSync(file, contents);
  };

  it('reads back a chosen number', () => {
    put('{"keepBackgroundSeconds":1800}');
    expect(readUserSettings()['keepBackgroundSeconds']).toBe(1800);
  });

  /**
   * Whatever the daemon agrees to store, it is still running with after a restart.
   *
   * This is the property somebody means by "the setting does not stay", and nothing checked it.
   * The two ends used different rules: anything from sixty seconds up was accepted and written,
   * and anything under five minutes was thrown away on the next start in favour of the default.
   * A value in between round-tripped through the file perfectly and still did not survive.
   */
  it('round-trips every value the daemon will accept', () => {
    for (const asked of [1, 30, 60, 299, 300, 900, 1800, 3600, 99 * 3600, null]) {
      const stored = clampTimeout(asked);
      updateUserSetting('keepBackgroundSeconds', stored);
      const read = readUserSettings()['keepBackgroundSeconds'];
      expect(read).toBe(stored);
      // And what the daemon does with it at startup is that same value, not a default.
      expect(clampTimeout(read as number | null)).toBe(stored);
    }
  });

  it('never stores a number the next startup would refuse', () => {
    // The floor that clamps a write is the floor that admits a read. One constant, both ends.
    for (const asked of [1, 5, 59, 60, 120, 299]) {
      expect(clampTimeout(asked)).toBe(5 * 60);
    }
  });

  it('reads back an explicit keep forever, which is a real choice', () => {
    put('{"keepBackgroundSeconds":null}');
    expect(readUserSettings()['keepBackgroundSeconds']).toBeNull();
  });

  it('says nothing at all when nobody has chosen', () => {
    put('{}');
    expect(readUserSettings()['keepBackgroundSeconds']).toBeUndefined();
  });

  it('survives a file that is not readable, rather than throwing', () => {
    // A half-written file is what a crash during a write leaves, and it must not stop the daemon.
    put('{ this is not json');
    expect(readUserSettings()['keepBackgroundSeconds']).toBeUndefined();
  });

  it('writes a choice and reads back exactly that choice', () => {
    put('{}');
    updateUserSetting('keepBackgroundSeconds', 1800);
    expect(readUserSettings()['keepBackgroundSeconds']).toBe(1800);
    updateUserSetting('keepBackgroundSeconds', null);
    expect(readUserSettings()['keepBackgroundSeconds']).toBeNull();
  });

  it('leaves every other setting alone when one changes', () => {
    // The file holds the agent command too, and a write that replaced the file rather than
    // updating it would take that with it.
    put('{"agentCommand":["claude","--dangerously-skip-permissions"]}');
    updateUserSetting('keepBackgroundSeconds', 1800);
    const after = readUserSettings();
    expect(after['agentCommand']).toEqual(['claude', '--dangerously-skip-permissions']);
    expect(after['keepBackgroundSeconds']).toBe(1800);
  });
});

/**
 * The picker is only ever as right as the last thing the daemon told the page.
 *
 * Every setting is answered once and then kept, so a daemon that restarts holding a value read
 * from disk leaves the page showing the value from before it. The page asks again whenever the
 * connection becomes ready, which is what a restart looks like from the page's side.
 */
describe('what the page asks for when a connection becomes ready', () => {
  it('includes every setting the panel can show', () => {
    const source = readFileSync(
      new URL('../../extension/src/terminal/terminal-page.ts', import.meta.url),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('function askForSettings()'),
      source.indexOf('function paneLabel('),
    );
    for (const question of [
      'get-memory-mode',
      'get-notify-policy',
      'get-agent-hooks',
      'get-agent-command',
      'get-shell-integration',
      'get-scrollback-budget',
      'get-background-timeout',
    ]) {
      expect(block, `${question} must be asked for again`).toContain(question);
    }
  });

  it('is called when the connection becomes ready, not only at first load', () => {
    const source = readFileSync(
      new URL('../../extension/src/terminal/terminal-page.ts', import.meta.url),
      'utf8',
    );
    const ready = source.slice(source.indexOf("case 'ready':"), source.indexOf("case 'retrying':"));
    expect(ready).toContain('askForSettings()');
  });
});
