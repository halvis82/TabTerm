import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';

/**
 * A program run the way a tab's shell is run, for the answer only a tab would get.
 *
 * The Full Disk Access check asked from the daemon, which macOS can credit differently from a
 * tab's shell. This is the same spawn as a terminal's, and it must come back with an exit code and
 * leave no session behind.
 */
const config: Config = { ...DEFAULTS };

function manager(): SessionManager {
  initLog('error');
  return new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
}

describe('probeAsATab', () => {
  it('reports whether zsh could open a file, and leaves no session', async () => {
    const sessions = manager();
    const dir = mkdtempSync(join(tmpdir(), 'tabterm-probe-'));
    const readable = join(dir, 'ok');
    writeFileSync(readable, 'x');
    const locked = join(dir, 'locked');
    writeFileSync(locked, 'x');
    chmodSync(locked, 0o000);
    const ask = (path: string) =>
      sessions.probeAsATab(['/bin/zsh', '-f', '-c', ': < "$1"', 'zsh', path], dir);
    expect(await ask(readable)).toBe(0);
    expect(await ask(locked)).not.toBe(0);
    expect(sessions.all).toHaveLength(0);
  });

  it('gives up rather than wait forever', async () => {
    const sessions = manager();
    expect(await sessions.probeAsATab(['/bin/sleep', '5'], tmpdir(), 300)).toBeNull();
  });
});
