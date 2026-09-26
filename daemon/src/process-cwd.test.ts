import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLog } from './log.js';
import { forgetCwd, processCwd } from './process-cwd.js';
import { forgetProcessTable } from './process-table.js';

initLog('error');

/**
 * Asking where several sessions are, in one question.
 *
 * `lsof` was run once per session, so a start screen with seven terminals forked seven of them at
 * once. One call answers for all of them, and the whole risk of that is telling the answers apart:
 * a batch that mixed them up would put one terminal's clickable paths in another terminal's
 * directory. So these are two real processes in two different directories, asked for together.
 */
describe('where a process is', () => {
  const sleeper = (cwd: string) =>
    spawn('/bin/sh', ['-c', 'sleep 30'], { cwd, stdio: 'ignore', detached: false });

  it('answers each of several processes with its own directory', async () => {
    const a = mkdtempSync(join(tmpdir(), 'tt-cwd-a-'));
    const b = mkdtempSync(join(tmpdir(), 'tt-cwd-b-'));
    const one = sleeper(a);
    const two = sleeper(b);
    try {
      // A moment for both to be running, then both asked for in the same turn, which is what a
      // start screen does and what the batch exists for.
      await new Promise((r) => setTimeout(r, 400));
      forgetProcessTable();
      forgetCwd(one.pid ?? 0);
      forgetCwd(two.pid ?? 0);
      const [first, second] = await Promise.all([
        processCwd(one.pid ?? 0),
        processCwd(two.pid ?? 0),
      ]);
      expect(first).toContain('tt-cwd-a-');
      expect(second).toContain('tt-cwd-b-');
    } finally {
      one.kill('SIGKILL');
      two.kill('SIGKILL');
    }
  }, 30000);

  it('says nothing, rather than waiting for ever, about a process that is not there', async () => {
    forgetProcessTable();
    const answer = await processCwd(2_147_483_600);
    expect(answer).toBeNull();
  }, 30000);

  it('answers the same process twice from what it already knows', async () => {
    const mine = await processCwd(process.pid);
    expect(await processCwd(process.pid)).toBe(mine);
  }, 30000);
});
