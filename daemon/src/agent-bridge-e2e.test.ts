import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBridge, type AgentEvent } from './agent-bridge.js';

/**
 * The bridge as an agent's hook actually meets it: a plain HTTP POST from a separate process
 * that cannot hold a socket.
 */
const PORT = 7996;
const TOKEN = 'a'.repeat(64);
const received: AgentEvent[] = [];
let bridge: AgentBridge;

beforeAll(async () => {
  bridge = new AgentBridge({
    port: PORT,
    verifyToken: (t) => t === TOKEN,
    onEvent: (e) => received.push(e),
  });
  await bridge.listen();
});

afterAll(async () => {
  await bridge.close();
});

async function post(body: unknown, token = TOKEN): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${PORT}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe('agent hook endpoint', () => {
  it('accepts a recognised hook and reports the state', async () => {
    received.length = 0;
    expect(await post({ sessionId: 's1', hook: 'PermissionRequest', detail: 'edit main.ts' })).toBe(
      204,
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.state).toBe('approval');
    expect(received[0]?.detail).toBe('edit main.ts');
  });

  it('rejects a request with the wrong token', async () => {
    received.length = 0;
    expect(await post({ sessionId: 's1', hook: 'Stop' }, 'f'.repeat(64))).toBe(401);
    expect(received, 'nothing must reach the daemon without a valid token').toHaveLength(0);
  });

  it('rejects a request with no token at all', async () => {
    expect(await post({ sessionId: 's1', hook: 'Stop' }, '')).toBe(401);
  });

  it('accepts but ignores an unrecognised hook', async () => {
    received.length = 0;
    // A future agent version emitting something new must not produce a wrong state, and must
    // not look like a failure to whatever is calling.
    expect(await post({ sessionId: 's1', hook: 'InventedNextYear' })).toBe(204);
    expect(received).toHaveLength(0);
  });

  it('rejects a malformed payload without crashing', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/agent-event`, {
      method: 'POST',
      headers: { 'x-tabterm-token': TOKEN },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });

  it('ignores anything but a POST to the event path', async () => {
    const get = await fetch(`http://127.0.0.1:${PORT}/agent-event`);
    expect(get.status).toBe(404);
    const wrongPath = await fetch(`http://127.0.0.1:${PORT}/anything-else`, { method: 'POST' });
    expect(wrongPath.status).toBe(404);
  });

  it('caps how much detail it will accept', async () => {
    received.length = 0;
    await post({ sessionId: 's1', hook: 'Notification', detail: 'x'.repeat(5000) });
    expect(received[0]?.detail?.length).toBeLessThanOrEqual(500);
  });

  it('refuses an oversized body rather than buffering it', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/agent-event`, {
      method: 'POST',
      headers: { 'x-tabterm-token': TOKEN },
      body: JSON.stringify({ sessionId: 's1', hook: 'Stop', detail: 'y'.repeat(200_000) }),
    });
    expect(res.status).toBe(413);
  });

  it('is reachable on loopback only', async () => {
    // Everything the daemon exposes binds to 127.0.0.1. See docs/05-security.md.
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === 'IPv4');
    if (!external) return; // no external interface to test against
    await expect(
      fetch(`http://${external.address}:${String(PORT)}/agent-event`, {
        method: 'POST',
        headers: { 'x-tabterm-token': TOKEN },
        body: '{}',
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toThrow();
  });
});
