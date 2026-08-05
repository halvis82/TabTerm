import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Which project a directory belongs to.
 *
 * A repository root is the unit people actually think in: history, saved items, and templates
 * are all more useful scoped to "this project" than to "this exact directory". Finding one
 * means walking up looking for `.git`, which is cheap but not free, so it is cached and never
 * done on a hot path.
 *
 * There is no filesystem walk anywhere in here. Going *up* from a known directory is bounded by
 * its depth; going *down* looking for repositories would be unbounded and is not done.
 * See docs/03-data-model.md §3.
 */

/** Deep enough for any real path, shallow enough that a pathological one cannot stall. */
const MAX_CLIMB = 40;

export interface ProjectRef {
  root: string;
  name: string;
}

export class ProjectIndex {
  /** Directory to its root, or null for "checked, not in a repository". */
  readonly #cache = new Map<string, string | null>();
  readonly #exists: (path: string) => Promise<boolean>;

  constructor(exists?: (path: string) => Promise<boolean>) {
    this.#exists =
      exists ??
      (async (path) => {
        try {
          await stat(path);
          return true;
        } catch {
          return false;
        }
      });
  }

  /**
   * The repository containing a directory, if any.
   *
   * Every directory passed on the way up is cached with the same answer, so the second call
   * anywhere inside a repository costs one map lookup. A negative result is cached too:
   * repeatedly failing to find a repository is exactly the case worth not repeating.
   */
  async find(dir: string): Promise<ProjectRef | null> {
    if (!dir.startsWith('/')) return null;

    const cached = this.#cache.get(dir);
    if (cached !== undefined) return cached === null ? null : ref(cached);

    const visited: string[] = [];
    let current = dir;
    const stop = homedir();

    for (let i = 0; i < MAX_CLIMB; i++) {
      const known = this.#cache.get(current);
      if (known !== undefined) {
        for (const d of visited) this.#cache.set(d, known);
        return known === null ? null : ref(known);
      }
      visited.push(current);

      // A `.git` directory in a normal checkout, a file in a worktree or submodule. Both mark
      // a root, so this checks for existence rather than for a directory.
      if (await this.#exists(join(current, '.git'))) {
        for (const d of visited) this.#cache.set(d, current);
        return ref(current);
      }

      // Never climb past home into shared parents. `/Users` is not anyone's project.
      if (current === stop || current === '/') break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    for (const d of visited) this.#cache.set(d, null);
    return null;
  }

  /**
   * Forget what is known about a path and everything under it.
   *
   * Called when a repository is created or removed, so a directory that has just become a
   * project stops reporting that it is not one.
   */
  invalidate(path: string): void {
    for (const key of [...this.#cache.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.#cache.delete(key);
    }
    // A new repository below a cached negative answer also invalidates its ancestors' answers,
    // because those were cached as "not in a repository" on the way up through this path.
    for (const [key, value] of [...this.#cache.entries()]) {
      if (value === null && path.startsWith(`${key}/`)) this.#cache.delete(key);
    }
  }

  /**
   * What is already known about a directory, without touching the filesystem.
   *
   * `undefined` means not looked up yet, `null` means looked up and not in a repository. Used
   * where a synchronous answer is needed and a wrong-but-fast one is not acceptable.
   */
  cached(dir: string): ProjectRef | null | undefined {
    const hit = this.#cache.get(dir);
    if (hit === undefined) return undefined;
    return hit === null ? null : ref(hit);
  }

  get size(): number {
    return this.#cache.size;
  }
}

function ref(root: string): ProjectRef {
  return { root, name: basename(root) || root };
}
