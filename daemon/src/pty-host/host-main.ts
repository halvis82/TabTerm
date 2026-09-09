import { claimLockFile, releaseLockFile } from '../lockfile.js';
import { error, info, initLog, warn } from '../log.js';
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

/**
 * The host's claim on its lock, which matters more than the daemon's.
 *
 * The socket path is manipulated on the assumption that exactly one host owns it, so two hosts
 * both believing they own it ends with the loser unlinking the winner's socket, and every
 * terminal on the machine becomes unreachable. `claimLockFile` makes the claim one operation the
 * kernel does not interleave. See `lockfile.ts`.
 */
function claimLock(): boolean {
  return claimLockFile(HOST_LOCK);
}

async function main(): Promise<void> {
  initLog('info');

  /**
   * Installed before anything can throw, rather than after the host is listening.
   *
   * They used to be registered at the end of `main`, which left the whole of startup uncovered:
   * `listen()` rejects on error, `main` is called with `void`, and a rejection with no handler
   * ends the process with a bare exit code 1 and not one line said about why. That is how a host
   * that failed to start looked identical to a host that lost the race and left on purpose.
   */
  process.on('uncaughtException', (e) => {
    // Staying up matters more here than anywhere else in the product: this process holds the
    // only handle to everybody's running work.
    error('pty-host.uncaught', { error: String(e), stack: e.stack });
  });
  process.on('unhandledRejection', (reason) => {
    error('pty-host.unhandled-rejection', { reason: String(reason) });
  });

  if (!claimLock()) {
    // Not a failure. Another host is serving, which is exactly what should happen when a daemon
    // restarts and tries to start one again.
    info('pty-host.already-running', {});
    process.exit(0);
  }

  for (const signal of IGNORED) process.on(signal, () => {});

  /**
   * The standalone host leaves when it holds nothing and no daemon is talking to it.
   *
   * Only here. A host embedded in another process, which is every test and the local backend,
   * must never end the process it is part of.
   */
  const host = new PtyHost(HOST_SOCKET, paths.scrollback, undefined, () => {
    info('pty-host.idle-exit', {});
    process.exit(0);
  });
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
    // Only if it is still ours. A lock judged stale and taken over by a successor belongs to that
    // successor now, and removing it here would hand a third starter a free claim while the real
    // owner is running. See `releaseLockFile`.
    releaseLockFile(HOST_LOCK);
    process.exit(0);
  };

  /**
   * A plain SIGTERM does not stop a host that is holding somebody's terminals.
   *
   * This process owns the only handles to every running session, so exiting it makes all of them
   * unreachable through TabTerm forever, which from the person's side is indistinguishable from
   * having killed them. A signal is not a statement of intent: it is what a packaging script, a
   * stray `killall node`, a `launchctl kickstart` aimed at the daemon, or a session manager
   * cleaning up sends without knowing what this is.
   *
   * An empty host stops on request, because there is nothing to lose. A host with sessions says
   * why it is staying and carries on. The deliberate way to end it is Reset, which ends the
   * sessions first and leaves this with nothing to hold; `TABTERM_HOST_FORCE_STOP=1` is the
   * escape hatch for uninstalling.
   */
  process.on('SIGTERM', () => {
    const holding = host.sessionCount;
    if (holding > 0 && process.env['TABTERM_HOST_FORCE_STOP'] !== '1') {
      warn('pty-host.refusing-sigterm', {
        sessions: holding,
        note: 'exiting would make every one of them unreachable; use Reset, or TABTERM_HOST_FORCE_STOP=1',
      });
      return;
    }
    void stop('SIGTERM');
  });
}

/**
 * A startup that fails says so, and says it in the log rather than only in an exit code.
 *
 * The lock is released on the way out. A process that claimed it and then could not serve is not
 * an owner, and leaving the file behind makes the next starter wait for a claim it will never see
 * released by a process that is already gone.
 */
void main().catch((e: unknown) => {
  error('pty-host.start-failed', { error: String(e) });
  releaseLockFile(HOST_LOCK);
  process.exit(1);
});
