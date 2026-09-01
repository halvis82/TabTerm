import { describe, expect, it } from 'vitest';
import { ProjectIndex } from './project-index.js';
import { homedir } from 'node:os';

/** A fake filesystem, so these tests describe the climbing rules rather than a real disk. */
const fs = (...gitDirs: string[]) => {
  const set = new Set(gitDirs);
  const calls: string[] = [];
  const index = new ProjectIndex((path) => {
    calls.push(path);
    return Promise.resolve(set.has(path));
  });
  return { index, calls };
};

const HOME = homedir();

describe('project index', () => {
  it('finds the repository a directory sits in', async () => {
    const { index } = fs(`${HOME}/code/app/.git`);
    const found = await index.find(`${HOME}/code/app/src/deep/nested`);
    expect(found?.root).toBe(`${HOME}/code/app`);
    expect(found?.name).toBe('app');
  });

  it('recognizes a worktree, where .git is a file', async () => {
    const { index } = fs(`${HOME}/code/wt/.git`);
    expect((await index.find(`${HOME}/code/wt/src`))?.root).toBe(`${HOME}/code/wt`);
  });

  it('reports nothing for a directory in no repository', async () => {
    const { index } = fs();
    expect(await index.find(`${HOME}/Downloads`)).toBeNull();
  });

  it('picks the innermost repository, so a submodule is its own project', async () => {
    const { index } = fs(`${HOME}/code/outer/.git`, `${HOME}/code/outer/vendor/inner/.git`);
    expect((await index.find(`${HOME}/code/outer/vendor/inner/src`))?.root).toBe(
      `${HOME}/code/outer/vendor/inner`,
    );
  });

  it('never climbs past home into shared parents', async () => {
    // A stray .git above home would otherwise make every directory one enormous project.
    const { index, calls } = fs('/Users/.git');
    expect(await index.find(`${HOME}/Downloads`)).toBeNull();
    expect(calls.some((c) => c === '/Users/.git')).toBe(false);
  });

  it('answers a repeat lookup without touching the filesystem', async () => {
    // The hot path is every prompt in every session, so a repeat must be a map lookup.
    const { index, calls } = fs(`${HOME}/code/app/.git`);
    await index.find(`${HOME}/code/app/src`);
    const before = calls.length;
    await index.find(`${HOME}/code/app/src`);
    expect(calls.length).toBe(before);
  });

  it('costs one check for a new directory inside a known project, not a fresh climb', async () => {
    const { index, calls } = fs(`${HOME}/code/app/.git`);
    await index.find(`${HOME}/code/app/a/b/c/d`);
    const before = calls.length;
    await index.find(`${HOME}/code/app/a/b/c/d/e`);
    expect(calls.length - before).toBe(1);
  });

  it('caches a negative answer too', async () => {
    const { index, calls } = fs();
    await index.find(`${HOME}/Downloads`);
    const before = calls.length;
    await index.find(`${HOME}/Downloads`);
    expect(calls.length).toBe(before);
  });

  it('is bounded even on an absurdly deep path', async () => {
    const { index, calls } = fs();
    await index.find(`${HOME}/${'a/'.repeat(500)}`);
    expect(calls.length).toBeLessThanOrEqual(41);
  });

  it('ignores a relative path rather than climbing from nowhere', async () => {
    const { index, calls } = fs();
    expect(await index.find('relative/path')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('forgets a directory that has just become a repository', async () => {
    const set = new Set<string>();
    const index = new ProjectIndex((p) => Promise.resolve(set.has(p)));
    expect(await index.find(`${HOME}/code/new/src`)).toBeNull();

    set.add(`${HOME}/code/new/.git`);
    index.invalidate(`${HOME}/code/new`);
    expect((await index.find(`${HOME}/code/new/src`))?.root).toBe(`${HOME}/code/new`);
  });

  it('forgets ancestors whose negative answer was cached through the changed path', async () => {
    // `~/code` was answered "no repository" by climbing through `~/code/new`. Creating a
    // repository there does not change `~/code` itself, and it must not be left stale either.
    const set = new Set<string>();
    const index = new ProjectIndex((p) => Promise.resolve(set.has(p)));
    await index.find(`${HOME}/code/new/src`);
    set.add(`${HOME}/code/new/.git`);
    index.invalidate(`${HOME}/code/new`);
    expect(await index.find(`${HOME}/code`)).toBeNull();
    expect((await index.find(`${HOME}/code/new`))?.root).toBe(`${HOME}/code/new`);
  });
});
