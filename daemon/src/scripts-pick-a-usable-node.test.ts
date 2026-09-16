import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every command that opens the database goes through the runtime picker.
 *
 * `node:sqlite` needs Node 22 or newer and the Node on somebody's PATH is whatever it is: on this
 * machine it is 20, which is why `scripts/pick-node.mjs` exists. A command that skips it does not
 * fail cleanly. `diagnostics` threw `ERR_UNKNOWN_BUILTIN_MODULE`, carried on, and **still wrote a
 * report**, so what landed on the Desktop looked like a finished diagnostic and contained none of
 * the session data. That is worse than not running: it is a bug report that quietly omits the part
 * somebody is reporting about.
 *
 * Checked against `package.json` rather than by running the commands, because the property is that
 * the wrapper is there at all. Running them would need a daemon and would pass on any machine whose
 * default Node happens to be new enough, which is the situation that hid this one.
 */
describe('the commands that reach the database', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const scripts = manifest.scripts;

  /** Everything that ends up importing the daemon, which imports `node:sqlite`. */
  const needsSqlite = ['test', 't', 't:changed', 'test:browser', 'diagnostics'];

  for (const name of needsSqlite) {
    it(`\`${name}\` picks a runtime that can open the database`, () => {
      const command = scripts[name];
      expect(command, `${name} is missing from package.json`).toBeDefined();
      expect(command).toContain('with-node.mjs');
    });
  }
});
