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
