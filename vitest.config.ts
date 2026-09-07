import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * A home of the run's own, so no test can touch the machine it runs on.
 *
 * Every path this product uses is derived from `HOME` when `config` is first imported: the
 * settings file, the database, the scrollback, the logs. Nine test files build a real daemon and
 * only one of them redirected anything, so the suite had been reading and writing the state
 * directory of whoever ran it.
 *
 * It was not theoretical. A test that deliberately sends a malformed message included
 * `set-background-timeout` with the string `forever`, which the daemon could not make a number of
 * and stored as "keep terminals forever" **in the real settings file**. Reported as the setting
 * resetting itself hours after being changed, and it was resetting itself: every run of the unit
 * suite set it.
 *
 * Made here rather than in each test, because the ones that need it are exactly the ones that do
 * not know they do.
 */
const realHome = process.env['HOME'] ?? tmpdir();
/**
 * Under the real home rather than under the temporary directory.
 *
 * Not for tidiness: the product deliberately ignores directories under `/tmp` and `/var/folders`
 * when it records where somebody has been, because those are not places anybody works. A test
 * home there makes every path a test creates invisible to the thing it is testing.
 *
 * So it lives beside the other scratch directories the suite makes, which the same sweeper
 * already cleans up, and it is still nowhere near the settings, database or logs of whoever ran
 * the suite.
 */
const base = join(realHome, '.cache', 'tabterm-test');
mkdirSync(base, { recursive: true });
const home = mkdtempSync(join(base, 'home-'));

export default defineConfig({
  test: {
    include: ['{shared,daemon,extension}/src/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { HOME: home, XDG_STATE_HOME: join(home, '.local', 'state') },
  },
});
