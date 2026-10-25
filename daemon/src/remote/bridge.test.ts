import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  NONCE_BYTES,
  Sealer,
  connectionKeys,
  fromBase64Url,
  packHello,
  packMessage,
  randomBytes,
  readHello,
  readPairing,
  toBase64Url,
  unpack,
  type RemoteAccessState,
  type RemoteTab,
} from '@tabterm/shared';
import { startRelay } from '../../../test/remote/relay-shim.mjs';
import type { RemoteHost } from './bridge.js';
import { RemoteControl } from './index.js';
import { authenticator } from './test-authenticator.js';
import type { Expected } from './webauthn.js';

/**
 * Remote access end to end: the real relay code, the real bridge and store, and a browser played
 * by this test with a software passkey. Only the daemon's sessions are stood in for, by a host
 * that records what it is asked to do.
 */

const SECRET = 'a-relay-secret-long-enough-to-count';

function fakeHost() {
  const outputs = new Set<(id: string, chunk: string) => void>();
  const tabsChanged = new Set<() => void>();
  const written: { sessionId: string; text: string }[] = [];
  const tabs: RemoteTab[] = [
    {
      id: 'w1',
      title: 'api',
      panes: [
        {
          sessionId: 's1',
          stream: 0,
          title: 'npm run dev',
          cwd: '/x/api',
          busy: true,
          needsYou: false,
        },
        { sessionId: 's2', stream: 0, title: 'claude', cwd: '/x/api', busy: false, needsYou: true },
      ],
    },
  ];
  const host: RemoteHost = {
    tabs: () => tabs,
    screen: (id) =>
      id === 's1' || id === 's2' ? { cols: 100, rows: 30, data: `screen of ${id}` } : null,
    write: (sessionId, text) => {
      written.push({ sessionId, text });
      return true;
    },
    onOutput: (l) => (outputs.add(l), () => outputs.delete(l)),
    onTabsChanged: (l) => (tabsChanged.add(l), () => tabsChanged.delete(l)),
    onResized: () => () => {},
  };
  return {
    host,
    written,
    tabs,
    emit: (id: string, chunk: string) => {
      for (const l of outputs) l(id, chunk);
    },
    changed: () => {
      for (const l of tabsChanged) l();
    },
  };
}

const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

/** A browser, as the page behaves: hello, keys, the passkey, then messages. */
function browser(
  relayUrl: string,
  pairing: { room: string; device: string; key: string },
  passkey: ReturnType<typeof authenticator>,
  opts: { register?: boolean } = {},
) {
  const socket = new WebSocket(`${relayUrl.replace('http', 'ws')}/ws/browser/${pairing.room}`);
  const nonce = randomBytes(NONCE_BYTES);
  let sealer: Sealer | null = null;
  let chain = Promise.resolve();
  const messages: Record<string, unknown>[] = [];
  const bytes: { stream: number; text: string }[] = [];
  let closed: number | null = null;
  let failedToOpen = false;
  const origin = new URL(relayUrl).origin;
  const send = (m: object): void => {
    const s = sealer;
    if (!s) return;
    chain = chain.then(async () => socket.send(await s.seal(packMessage(m))));
  };
  socket.on('open', () =>
    socket.send(packHello({ device: pairing.device, nonce: toBase64Url(nonce) })),
  );
  socket.on('close', (code) => (closed = code));
  socket.on('message', (data: Buffer) => {
    const frame = new Uint8Array(data);
    chain = chain.then(async () => {
      const hello = readHello(frame);
      if (hello) {
        sealer = new Sealer(
          await connectionKeys(
            fromBase64Url(pairing.key),
            nonce,
            fromBase64Url(String(hello['nonce'])),
            'browser',
          ),
        );
        return;
      }
      if (!sealer) return;
      let opened;
      try {
        opened = unpack(await sealer.open(frame));
      } catch {
        failedToOpen = true;
        return;
      }
      if (!opened) return;
      if (opened.kind === 'bytes') {
        bytes.push({ stream: opened.stream, text: new TextDecoder().decode(opened.data) });
        return;
      }
      const m = opened.message;
      messages.push(m);
      if (m['t'] === 'challenge') {
        const e: Expected = {
          challenge: fromBase64Url(String(m['challenge'])),
          origin,
          rpId: String(m['rpId']),
        };
        if (m['mode'] === 'register' || opts.register === true) {
          const r = passkey.register(e);
          send({
            t: 'register',
            name: 'Test phone',
            clientDataJSON: toBase64Url(r.clientDataJSON),
            attestationObject: toBase64Url(r.attestationObject),
          });
        } else {
          const a = passkey.assert(e);
          send({
            t: 'unlock',
            credentialId: a.credentialId,
            clientDataJSON: toBase64Url(a.clientDataJSON),
            authenticatorData: toBase64Url(a.authenticatorData),
            signature: toBase64Url(a.signature),
          });
        }
      }
    });
  });
  return {
    send,
    messages,
    bytes,
    has: (t: string) => messages.some((m) => m['t'] === t),
    last: (t: string) => [...messages].reverse().find((m) => m['t'] === t),
    closed: () => closed,
    failedToOpen: () => failedToOpen,
    close: () => socket.close(),
  };
}

let dir: string;
let relay: Awaited<ReturnType<typeof startRelay>>;
let control: RemoteControl | undefined;
let states: RemoteAccessState[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tabterm-remote-'));
  relay = await startRelay({ secret: SECRET });
  states = [];
});

afterEach(async () => {
  control?.stop();
  control = undefined;
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

function connected(host: RemoteHost, secret = SECRET): RemoteControl {
  const c = new RemoteControl(dir, host, (s) => states.push(s));
  c.configure({ enabled: true, relayUrl: relay.url, relaySecret: secret });
  control = c;
  return c;
}

async function paired(c: RemoteControl, passkey = authenticator()) {
  const link = c.pair();
  if (!link) throw new Error('no link');
  const pairing = readPairing(new URL(link.link).hash);
  if (!pairing) throw new Error('bad link');
  const b = browser(relay.url, pairing, passkey);
  await until(() => b.has('tabs'));
  return { b, pairing, passkey };
}

describe('remote access, end to end', () => {
  it('is off until turned on, and makes no connection while off', () => {
    const c = new RemoteControl(dir, fakeHost().host, (s) => states.push(s));
    control = c;
    expect(c.state.enabled).toBe(false);
    expect(c.state.status).toBe('off');
  });

  it('connects out to the relay, and keeps its secrets in a file only this user can read', async () => {
    const c = connected(fakeHost().host);
    expect(await until(() => c.state.status === 'connected')).toBe(true);
    expect(statSync(join(dir, 'remote.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(c.state)).not.toContain(SECRET);
  });

  it('says so when the relay refuses the secret', async () => {
    const c = connected(fakeHost().host, 'a-wrong-secret-that-is-long-enough');
    expect(await until(() => c.state.detail === 'The relay refused the secret')).toBe(true);
  });

  it('pairs a device with a passkey, lists the tabs, shows a terminal, and types into it', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    expect(b.last('ready')?.['name']).toBe('Test phone');
    const tabs = b.last('tabs')?.['tabs'] as RemoteTab[];
    expect(tabs[0]?.panes.map((p) => p.title)).toEqual(['npm run dev', 'claude']);
    expect(c.state.devices.map((d) => d.name)).toEqual(['Test phone']);

    b.send({ t: 'watch', sessionId: 's1' });
    expect(await until(() => b.bytes.some((x) => x.text === 'screen of s1'))).toBe(true);
    const stream = Number(b.last('screen')?.['stream']);

    fake.emit('s1', 'live line\r\n');
    fake.emit('s2', 'not watched\r\n');
    expect(await until(() => b.bytes.some((x) => x.text.includes('live line')))).toBe(true);
    expect(b.bytes.every((x) => x.stream === stream)).toBe(true);
    expect(b.bytes.some((x) => x.text.includes('not watched'))).toBe(false);

    b.send({ t: 'input', sessionId: 's1', data: 'ls\r' });
    expect(await until(() => fake.written.length === 1)).toBe(true);
    expect(fake.written[0]).toEqual({ sessionId: 's1', text: 'ls\r' });
  });

  it('keeps the list current as the tabs change on the Mac', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    fake.tabs.push({ id: 'w2', title: 'new tab', panes: [] });
    fake.changed();
    expect(
      await until(() =>
        (b.last('tabs')?.['tabs'] as RemoteTab[]).some((t) => t.title === 'new tab'),
      ),
    ).toBe(true);
  });

  it('asks the same passkey again on every new connection, and refuses any other', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing, passkey } = await paired(c);
    b.close();

    const again = browser(relay.url, pairing, passkey);
    expect(await until(() => again.has('ready'))).toBe(true);
    expect(again.last('challenge')?.['mode']).toBe('unlock');
    again.close();

    const thief = browser(relay.url, pairing, authenticator());
    expect(await until(() => thief.closed() !== null)).toBe(true);
    expect(thief.has('ready')).toBe(false);
    expect(thief.has('tabs')).toBe(false);
  });

  it('gives a stranger nothing: an id nobody issued opens nothing', async () => {
    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    const stranger = browser(
      relay.url,
      { room: roomOf(dir), device: 'nobody-issued-this', key: toBase64Url(randomBytes(32)) },
      authenticator(),
    );
    expect(await until(() => stranger.failedToOpen())).toBe(true);
    expect(stranger.messages).toEqual([]);
  });

  it('uses a pairing link once', async () => {
    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    const { pairing } = await paired(c);
    // The same link again, from another device: its key now belongs to a trusted device with its
    // own passkey, so registering a new one is refused.
    const copy = browser(relay.url, pairing, authenticator(), { register: true });
    expect(await until(() => copy.closed() !== null)).toBe(true);
    expect(c.state.devices).toHaveLength(1);
  });

  it('lets a device that may only watch, watch, and ignores what it types', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    const id = c.state.devices[0]?.id ?? '';
    c.device({ deviceId: id, typing: false });
    // An open page is told at once, so it can take its keys away.
    expect(await until(() => b.last('tabs')?.['typing'] === false)).toBe(true);
    b.send({ t: 'watch', sessionId: 's1' });
    await until(() => b.has('screen'));
    b.send({ t: 'input', sessionId: 's1', data: 'rm -rf ~\r' });
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.written).toEqual([]);
  });

  it('types only into the terminal being watched', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    b.send({ t: 'watch', sessionId: 's1' });
    await until(() => b.has('screen'));
    b.send({ t: 'input', sessionId: 's2', data: 'x' });
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.written).toEqual([]);
  });

  it('has nothing for a browser to end a session, open a tab, or resize with', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    for (const t of [
      'kill-session',
      'resize',
      'create-session',
      'open-url',
      'remote-set',
      'remote-device',
    ]) {
      b.send({ t, sessionId: 's1', cols: 10, rows: 5, enabled: false, forget: true });
    }
    b.send({ t: 'ping' });
    expect(await until(() => b.has('pong'))).toBe(true);
    expect(fake.written).toEqual([]);
    expect(c.state.enabled).toBe(true);
    expect(c.state.devices).toHaveLength(1);
  });

  it('cuts a removed device off at once', async () => {
    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    c.device({ deviceId: c.state.devices[0]?.id ?? '', forget: true });
    expect(await until(() => b.closed() !== null)).toBe(true);
    expect(b.last('denied')?.['reason']).toBe('removed');
    expect(c.state.devices).toEqual([]);
  });

  it('tells a browser when the Mac is offline, and when it goes offline', async () => {
    const offline = browser(
      relay.url,
      {
        room: 'a-room-nobody-is-in-0001',
        device: 'some-device',
        key: toBase64Url(randomBytes(32)),
      },
      authenticator(),
    );
    expect(await until(() => offline.closed() === 4002)).toBe(true);

    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    c.stop();
    expect(await until(() => b.closed() !== null)).toBe(true);
  });

  it('stops everything when turned off', async () => {
    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    c.configure({ enabled: false });
    expect(c.state.status).toBe('off');
    expect(await until(() => b.closed() !== null)).toBe(true);
  });
});

function roomOf(stateDir: string): string {
  // The room is in the store's file. Read rather than exposed, since nothing else needs it.
  return (JSON.parse(readFileSync(join(stateDir, 'remote.json'), 'utf8')) as { room: string }).room;
}
