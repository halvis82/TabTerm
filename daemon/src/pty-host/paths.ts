import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../config.js';

/**
 * Where the host lives, in a module that does nothing when imported.
 *
 * Deliberately separate from `host-main.ts`. That file starts a host as a side effect of being
 * loaded, so anything importing a constant from it would quietly become a host, serve a socket,
 * and take every session down with it when it exited. That is not hypothetical: it is what the
 * first version of this did, and the symptom was terminals dying with whatever last touched them.
 */

/**
 * How long a unix socket path may be.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, and going over does not
 * truncate or warn: `listen` fails with `EINVAL`, which names nothing about the length. The
 * daemon read that as "no host" and fell back to owning the PTYs itself, so terminals stopped
 * surviving a daemon restart, which is the product's central promise, and the only trace was one
 * warning line in a log.
 *
 * Found because the browser suites run against a daemon in a temporary home, and the temporary
 * directory was long enough to push the socket over. Anybody with a deep enough home directory
 * would have hit the same thing, silently.
 */
const MAX_SOCKET_PATH = 100;

/**
 * A short path in the per-user temporary directory, for when the natural one does not fit.
 *
 * `tmpdir()` on macOS is per-user and private (`/var/folders/…/T`), which is the reason to
 * prefer it over `/tmp`: a predictable name under a world-writable directory is a socket
 * somebody else can create first. The name is derived from the state directory, so two
 * installations that keep separate state keep separate hosts, and it is stable, so a restarted
 * daemon finds the host it left running rather than starting a second one beside it.
 */
function shortSocketPath(suffix: string): string {
  const key = createHash('sha256').update(paths.state).digest('hex').slice(0, 12);
  return join(tmpdir(), `tabterm-${key}.${suffix}`);
}

/**
 * The natural path when it fits, a short one when it does not.
 *
 * Preferred rather than always short, so an installation that already has a host running keeps
 * finding it. Moving every socket unconditionally would mean the daemon coming back from an
 * update looks in a new place, finds nothing, starts a second host, and leaves the first one
 * holding everybody's terminals with nothing connected to it.
 */
function hostPath(suffix: string): string {
  const natural = join(paths.state, `ptyhost.${suffix}`);
  return Buffer.byteLength(natural) <= MAX_SOCKET_PATH ? natural : shortSocketPath(suffix);
}

export const HOST_SOCKET = hostPath('sock');
export const HOST_LOCK = hostPath('lock');

/**
 * A pointer to where the host actually is, always at the obvious place.
 *
 * A regular file has no length limit, so this can sit in the state directory even when the
 * socket cannot. It exists so that finding the host does not require re-deriving a hash: a
 * person debugging, and the test harness, can read one file rather than reimplement a rule that
 * would then drift out of step with this one.
 */
export const HOST_POINTER = join(paths.state, 'ptyhost.where');
