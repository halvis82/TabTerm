import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadConfig, ignoredConfigFields, paths } from './config.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A hand-edited optional file must not be able to destabilise the layer that keeps terminals
 * alive.
 *
 * `config.json` was spread whole into the running configuration, so whatever was in it became the
 * truth: a port as a string, a negative reap interval, a chunk size of `1e12`, a `NaN`. Nothing
 * further down refuses any of those, and several of them reach the code that decides when a
 * process may be ended or how much memory to hand out.
 *
 * Validated per field, so one mistyped number does not take the nine correct settings with it.
 */

const FILE = join(paths.config, 'config.json');

const withConfig = async (contents: string) => {
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(FILE, contents);
  ignoredConfigFields.length = 0;
  try {
    return await loadConfig();
  } finally {
    rmSync(FILE, { force: true });
  }
};

describe('what a config file is allowed to say', () => {
  it('takes the fields that make sense', async () => {
    const config = await withConfig('{"scrollbackLines":2500,"shell":"/bin/bash"}');
    expect(config.scrollbackLines).toBe(2500);
    expect(config.shell).toBe('/bin/bash');
    expect(ignoredConfigFields).toEqual([]);
  });

  it('refuses a number that is not one, and says which field', async () => {
    const config = await withConfig('{"port":"7377"}');
    expect(config.port).toBe(DEFAULTS.port);
    expect(ignoredConfigFields).toContain('port');
  });

  it('refuses NaN, infinity and negatives, which nothing further down would', async () => {
    for (const bad of ['{"reapDefaultSeconds":-1}', '{"coalesceMs":0}']) {
      const config = await withConfig(bad);
      expect(config.reapDefaultSeconds).toBe(DEFAULTS.reapDefaultSeconds);
      expect(config.coalesceMs).toBe(DEFAULTS.coalesceMs);
      expect(ignoredConfigFields.length).toBeGreaterThan(0);
    }
  });

  it('refuses an absurd allocation', async () => {
    // Far past anything meant, and well into the sizes that turn an allocation into a crash.
    const config = await withConfig('{"maxChunkBytes":1e15}');
    expect(config.maxChunkBytes).toBe(DEFAULTS.maxChunkBytes);
    expect(ignoredConfigFields).toContain('maxChunkBytes');
  });

  it('refuses a list that is not a list of strings', async () => {
    const config = await withConfig('{"longLivedPrograms":[1,2,3]}');
    expect(config.longLivedPrograms).toEqual(DEFAULTS.longLivedPrograms);
    expect(ignoredConfigFields).toContain('longLivedPrograms');
  });

  it('and one bad field does not take the good ones with it', async () => {
    // The whole point of validating per field. Somebody who mistypes one number should not
    // silently lose the settings they got right.
    const config = await withConfig('{"port":"nope","scrollbackLines":4321,"shell":"/bin/sh"}');
    expect(config.port).toBe(DEFAULTS.port);
    expect(config.scrollbackLines).toBe(4321);
    expect(config.shell).toBe('/bin/sh');
  });

  it('and a file that is not JSON at all still starts the daemon', async () => {
    const config = await withConfig('{ this is not json');
    expect(config.port).toBe(DEFAULTS.port);
  });
});

describe('values that are the right type and still cannot work', () => {
  /**
   * The generic rule accepted anything of the right JavaScript type within a million times the
   * shipped default. So an enum took any string at all, and a port took any positive number:
   * `memoryMode: "banana"` was a string, `logLevel: "chatty"` was a string, and four billion is a
   * number well inside a ceiling derived from 7377.
   *
   * None of those are values this program can do anything with. Refusing them where the file is
   * read, and naming them, is the difference between a typo and a failure somewhere else entirely.
   */
  it('refuses an enum that is not one of the values', async () => {
    const config = await withConfig('{"memoryMode":"banana","logLevel":"chatty"}');
    expect(config.memoryMode).toBe(DEFAULTS.memoryMode);
    expect(config.logLevel).toBe(DEFAULTS.logLevel);
    expect(ignoredConfigFields).toContain('memoryMode');
    expect(ignoredConfigFields).toContain('logLevel');
  });

  it('takes an enum that is one of them', async () => {
    const config = await withConfig('{"memoryMode":"low","logLevel":"warn"}');
    expect(config.memoryMode).toBe('low');
    expect(config.logLevel).toBe('warn');
  });

  it('refuses a port outside the range a port has', async () => {
    for (const bad of [
      '{"port":0}',
      '{"port":70000}',
      '{"port":7377.5}',
      '{"agentBridgePort":-1}',
    ]) {
      const config = await withConfig(bad);
      expect(config.port).toBe(DEFAULTS.port);
      expect(config.agentBridgePort).toBe(DEFAULTS.agentBridgePort);
    }
  });

  it('takes the edges of that range', async () => {
    const config = await withConfig('{"port":1,"agentBridgePort":65535}');
    expect(config.port).toBe(1);
    expect(config.agentBridgePort).toBe(65535);
  });

  it('refuses a list whose items are not usable strings', async () => {
    for (const bad of [
      '{"agentCommand":[""]}',
      '{"longLivedPrograms":[1,2]}',
      '{"agentCommand":"claude"}',
    ]) {
      const config = await withConfig(bad);
      expect(config.agentCommand).toEqual(DEFAULTS.agentCommand);
      expect(config.longLivedPrograms).toEqual(DEFAULTS.longLivedPrograms);
    }
  });

  it('refuses a list long enough to be a mistake', async () => {
    const huge = JSON.stringify({ longLivedPrograms: Array.from({ length: 5000 }, () => 'x') });
    const config = await withConfig(huge);
    expect(config.longLivedPrograms).toEqual(DEFAULTS.longLivedPrograms);
    expect(ignoredConfigFields).toContain('longLivedPrograms');
  });

  it('refuses a boolean that is not one', async () => {
    const config = await withConfig('{"archiveOutput":"yes"}');
    expect(config.archiveOutput).toBe(DEFAULTS.archiveOutput);
    expect(ignoredConfigFields).toContain('archiveOutput');
  });
});
