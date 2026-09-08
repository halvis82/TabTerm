import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completePath } from './complete-path.js';
import { listResumable } from './agent-sessions.js';
import { readHead, readTail } from './file-slice.js';
import { readTranscript } from './agent-transcript.js';
import { initLog } from './log.js';

/**
 * A folder somebody said no to must limit what works, and break nothing.
 *
 * "make sure we don't crash if anyone puts deny btw. i get that functionality will be limited,
 * but app shouldn't crash or anything."
 *
 * macOS denial surfaces as `EPERM` from an ordinary read, which is the same shape as a directory
 * that has had its permissions removed. That is what this uses, because a test cannot press
 * "Don't Allow": the code cannot tell the two apart and neither is allowed to throw.
 */

let dir = '';
let denied = '';

beforeAll(() => {
  initLog('error');
  dir = mkdtempSync(join(tmpdir(), 'tt-denied-'));
  denied = join(dir, 'no-entry');
  mkdirSync(denied);
  writeFileSync(join(denied, 'something.txt'), 'unreadable');
  // No permissions at all, which is what a refused folder behaves like from the outside.
  chmodSync(denied, 0o000);
});

afterAll(() => {
  try {
    chmodSync(denied, 0o700);
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('a folder that cannot be read', () => {
  it('completes to nothing rather than throwing', () => {
    expect(() => completePath(`${denied}/`, dir)).not.toThrow();
    expect(completePath(`${denied}/`, dir).matches).toEqual([]);
  });

  it('offers no agent sessions from it rather than throwing', async () => {
    await expect(listResumable({ store: denied, limit: 5 })).resolves.toEqual([]);
  });

  it('reads no transcript from it rather than throwing', async () => {
    await expect(readTranscript(join(denied, 'something.txt'))).resolves.toEqual([]);
  });

  it('reports the head and tail of an unreadable file as a failure to read, not a crash', async () => {
    // These two throw by design, because their callers decide what an unreadable file means.
    // What matters is that it is a rejected promise and not an exception escaping a listener.
    await expect(readHead(join(denied, 'something.txt'), 16)).rejects.toBeTruthy();
    await expect(readTail(join(denied, 'something.txt'), 16)).rejects.toBeTruthy();
  });

  it('completes a readable folder normally, so the guard has not disabled everything', () => {
    mkdirSync(join(dir, 'visible'), { recursive: true });
    expect(completePath(`${dir}/`, dir).matches).toContain('visible');
  });
});
