import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A scratch directory that behaves like a real one.
 *
 * `os.tmpdir()` will not do for anything touching recent folders: temporary directories are
 * deliberately excluded from them, because a build or a test run works in one and every one of
 * them is gone by the time anybody would click it. A fixture under tmp is therefore invisible to
 * exactly the code these tests are checking.
 *
 * This lives under the cache directory instead: a real path, not special-cased anywhere, and
 * removable.
 */
const BASE = join(homedir(), '.cache', 'tabterm-test');

export async function makeTestDir(prefix = 'dir-'): Promise<string> {
  mkdirSync(BASE, { recursive: true });
  return mkdtemp(join(BASE, prefix));
}

export async function removeTestDir(path: string): Promise<void> {
  if (!path.startsWith(BASE)) return;
  await rm(path, { recursive: true, force: true });
}

/**
 * Remove every scratch directory this helper has made.
 *
 * They live in a real location deliberately, which is exactly why they cannot be left behind:
 * a directory here is indistinguishable from a folder somebody actually works in, and the
 * launcher offers it as one. Twenty six of them accumulated before anybody noticed, and the
 * list of recent folders read as debris.
 */
export async function removeAllTestDirs(): Promise<void> {
  await rm(BASE, { recursive: true, force: true });
}
