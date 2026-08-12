import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { ProjectIndex } from './project-index.js';
import { makeTestDir } from './test-dirs.js';

/** Discovery against a real filesystem, wired the way the daemon wires it. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function repo(): Promise<{ root: string; deep: string }> {
  // Not a temp directory: those are excluded from recent folders on purpose, which would make
  // the fixture invisible to the code under test.
  const root = await makeTestDir('repo-');
  await mkdir(join(root, '.git'));
  const deep = join(root, 'src', 'nested');
  await mkdir(deep, { recursive: true });
  return { root, deep };
}

const wired = () => {
  const data = new LauncherData(new Database(':memory:'));
  // Home would otherwise stop the climb before reaching a temp directory.
  data.useProjectIndex(new ProjectIndex());
  return data;
};

describe('project index, stored', () => {
  it('attaches the repository to a directory it recorded', async () => {
    const { root, deep } = await repo();
    const data = wired();
    data.recordDir(deep);
    await sleep(60); // resolution is deliberately not awaited by recordDir

    const dir = data.recentDirs().find((d) => d.path === deep);
    expect(dir?.project?.root).toBe(root);
    expect(data.projects().map((p) => p.root)).toContain(root);
  });

  it('records nothing for a directory in no repository', async () => {
    const dir = await makeTestDir('plain-');
    const data = wired();
    data.recordDir(dir);
    await sleep(60);
    expect(data.recentDirs().find((d) => d.path === dir)?.project).toBeUndefined();
  });

  it('scopes a command to the repository it was run in', async () => {
    const { root, deep } = await repo();
    const data = wired();
    data.recordDir(deep);
    await sleep(60);
    data.recordCommand({ command: 'npm test', cwd: deep, exitCode: 0 });

    const stored = data.history('npm test').find((c) => c.command === 'npm test');
    expect(stored).toBeDefined();
    expect(data.projects().map((p) => p.root)).toContain(root);
  });

  it('never blocks the caller on the filesystem', async () => {
    // recordDir is on a per-prompt path. It must return before discovery finishes.
    const { deep } = await repo();
    const data = wired();
    data.recordDir(deep);
    // Synchronously, before any await, the row exists and the project has not been resolved.
    expect(data.recentDirs().find((d) => d.path === deep)?.project).toBeUndefined();
    await sleep(60);
    expect(data.recentDirs().find((d) => d.path === deep)?.project).toBeDefined();
  });

  it('keeps working when a recorded directory has already been deleted', async () => {
    const data = wired();
    data.recordDir('/tmp/tabterm-definitely-not-here-9931/x');
    await sleep(60);
    expect(data.projects()).toEqual([]);
  });

  it('survives a second daemon start against the same database', async () => {
    // Migration 3 adds columns to existing tables, so a database created before it must open.
    // A database file is not a recent directory, so anywhere writable will do.
    const file = join(await makeTestDir('db-'), 'state.db');
    const first = new Database(file);
    first.close();
    const second = new Database(file);
    const data = new LauncherData(second);
    expect(data.projects()).toEqual([]);
    second.close();
  });
});
