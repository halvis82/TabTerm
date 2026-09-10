import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * What happens to a terminal after the server it was running stops.
 *
 * A listening port is a reap protection: killing a running dev server because a tab was closed
 * would be the worst thing this product could do, so a session holding one is never reaped. It is
 * also the row on the start screen that says the server is up.
 *
 * The port was remembered when found and never forgotten when gone. All three places that write it
 * only ever wrote: one set it when found and did nothing when not, one returned early when the port
 * had gone, and the list fell back to the remembered value and saved it again. So a terminal that
 * ran a dev server once and stopped it kept the protection for the life of the daemon and stayed on
 * the list with it, and a server whose session had ended was never on the list at all however
 * plainly it was still listening.
 *
 * Mocked at the boundary, because the fault is not in what `lsof` says. It is in what is done with
 * the answer when the answer is "nothing".
 */
const ports = { value: new Map<number, number>() };
vi.mock('./server-detect.js', () => ({
  listeningPorts: () => Promise.resolve(ports.value),
  localListeners: () => Promise.resolve([]),
}));

const { SessionManager } = await import('./session-manager.js');
const { DEFAULTS } = await import('./config.js');
const { LocalPtyBackend } = await import('./pty-backend.js');
const { initLog } = await import('./log.js');

let manager: InstanceType<typeof SessionManager>;

beforeAll(() => {
  initLog('error');
  manager = new SessionManager(
    { ...DEFAULTS },
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
});

const settle = () => new Promise((r) => setTimeout(r, 30));

/** A client has to have been attached for a detach to mean anything. */
const attached = (clientId: string) => ({ clientId, cols: 80, rows: 24, onOutput: () => {} });

describe('the port a session is remembered as serving on', () => {
  it('is dropped once nothing is listening there any more', async () => {
    const session = manager.create({ cwd: process.cwd(), cols: 80, rows: 24 });
    session.listeningPort = 5173;

    // Nothing listening under this pid now: the server was stopped.
    ports.value = new Map();
    manager.attach(session, attached('test-client'));
    manager.detach(session, 'test-client');
    await settle();

    expect(session.listeningPort).toBeUndefined();
    await manager.terminate(session, { kind: 'user-kill' });
  });

  it('is kept while something still is', async () => {
    const session = manager.create({ cwd: process.cwd(), cols: 80, rows: 24 });
    ports.value = new Map([[session.pid, 5173]]);
    manager.attach(session, attached('test-client'));
    manager.detach(session, 'test-client');
    await settle();

    expect(session.listeningPort).toBe(5173);
    await manager.terminate(session, { kind: 'user-kill' });
  });
});
