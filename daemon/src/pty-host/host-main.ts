import { existsSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { error, info, initLog } from '../log.js';
import { PtyHost } from './host.js';
import { HOST_LOCK, HOST_SOCKET } from './paths.js';
import { paths } from '../config.js';

/**
 * The PTY host, as a process.
 *
 * Started by the daemon and then deliberately outliving it. Everything here is about not dying
 * for somebody else's reasons. See docs/adr/0017.
 */

/**
 * Signals the daemon receives that this process must ignore.
 *
 * `launchctl kickstart -k` terminates the daemon, and a child in the same process group would go
 * with it. The spawn is detached so the group differs, and these are belt and braces: whatever
 * reaches this process on the way to the daemon's death is not a reason to end somebody's build.
 *
 * SIGTERM is deliberately **not** here. There has to be one way to stop this on purpose.
 */
const IGNORED: NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGPIPE'];

function claimLock(): boolean {
  try {
    if (existsSync(HOST_LOCK)) {
      const pid = Number(readFileSync(HOST_LOCK, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return false; // A host is already running, and it owns the sessions.
        } catch {
          // The pid is gone. The lock is stale and the sessions it described are long dead.
        }
      }
    }
    const fd = openSync(HOST_LOCK, 'w', 0o600);
    closeSync(fd);
    writeFileSync(HOST_LOCK, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  initLog('info');

  if (!claimLock()) {
    // Not a failure. Another host is serving, which is exactly what should happen when a daemon
    // restarts and tries to start one again.
    info('pty-host.already-running', {});
    process.exit(0);
  }

  for (const signal of IGNORED) process.on(signal, () => {});

  const host = new PtyHost(HOST_SOCKET, paths.scrollback);
  await host.listen();
  info('pty-host.listening', { socket: HOST_SOCKET, pid: process.pid });

  const stop = async (signal: string): Promise<void> => {
    /**
     * Stopping serves the socket down, and leaves every process running.
     *
     * A host that killed its sessions on the way out would defeat its own purpose, because the
     * next thing that happens after a stop is usually a start.
     */
    info('pty-host.stopping', { signal, sessions: host.sessionCount });
    await host.close();
    try {
      unlinkSync(HOST_LOCK);
    } catch {
      /* already gone */
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));

  process.on('uncaughtException', (e) => {
    // Staying up matters more here than anywhere else in the product: this process holds the
    // only handle to everybody's running work.
    error('pty-host.uncaught', { error: String(e), stack: e.stack });
  });
  process.on('unhandledRejection', (reason) => {
    error('pty-host.unhandled-rejection', { reason: String(reason) });
  });
}

void main();
