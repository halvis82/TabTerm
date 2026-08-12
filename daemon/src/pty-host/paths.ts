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
export const HOST_SOCKET = join(paths.state, 'ptyhost.sock');
export const HOST_LOCK = join(paths.state, 'ptyhost.lock');
