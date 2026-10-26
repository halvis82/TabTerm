import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
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
  const ended = new Set<string>();
  const asked: { name: string; code: string }[] = [];
  const approval = { answer: Promise.resolve(true) };
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
      (id === 's1' || id === 's2') && !ended.has(id)
        ? { cols: 100, rows: 30, data: `screen of ${id}` }
        : null,
    alive: (id) => (id === 's1' || id === 's2') && !ended.has(id),
    write: (sessionId, text) => {
      written.push({ sessionId, text });
      return true;
    },
    onOutput: (l) => (outputs.add(l), () => outputs.delete(l)),
    onTabsChanged: (l) => (tabsChanged.add(l), () => tabsChanged.delete(l)),
    onResized: () => () => {},
    approve: (device) => {
      asked.push(device);
      return approval.answer;
    },
  };
  return {
    host,
    written,
    tabs,
    ended,
    asked,
    approval,
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
  opts: { register?: boolean; resume?: string; whileUnlocking?: object } = {},
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
        if (opts.whileUnlocking) send(opts.whileUnlocking);
        if (opts.resume !== undefined) {
          send({ t: 'resume', ticket: opts.resume });
        } else if (m['mode'] === 'register' || opts.register === true) {
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

let pushes: { url: string; init: RequestInit }[] = [];
let pushStatus = 201;

function connected(host: RemoteHost, secret = SECRET): RemoteControl {
  pushes = [];
  pushStatus = 201;
  const c = new RemoteControl(
    dir,
    host,
    (s) => states.push(s),
    (url, init) => {
      pushes.push({ url, init });
      return Promise.resolve({ status: pushStatus });
    },
  );
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

  it('answers every numbered key, and types each number once however often it comes', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing } = await paired(c);
    const ticket = String(b.last('ready')?.['resume']);
    b.send({ t: 'watch', sessionId: 's1' });
    await until(() => b.has('screen'));
    b.send({ t: 'input', sessionId: 's1', data: 'a', page: 'p1', n: 1 });
    b.send({ t: 'input', sessionId: 's1', data: 'b', page: 'p1', n: 2 });
    expect(await until(() => b.last('got')?.['n'] === 2)).toBe(true);
    b.close();
    // Back on a new connection, the page sends again what it did not hear about, and more.
    const back = browser(relay.url, pairing, authenticator(), { resume: ticket });
    await until(() => back.has('tabs'));
    back.send({ t: 'watch', sessionId: 's1' });
    await until(() => back.has('screen'));
    back.send({ t: 'input', sessionId: 's1', data: 'b', page: 'p1', n: 2 });
    back.send({ t: 'input', sessionId: 's1', data: 'c', page: 'p1', n: 3 });
    expect(await until(() => back.last('got')?.['n'] === 3)).toBe(true);
    expect(fake.written.map((w) => w.text).join('')).toBe('abc');
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

  it('tells a page watching a terminal that it ended, as soon as it does', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    b.send({ t: 'watch', sessionId: 's1' });
    expect(await until(() => b.has('screen'))).toBe(true);
    expect(b.has('ended')).toBe(false);
    fake.ended.add('s1');
    fake.changed();
    expect(await until(() => b.last('ended')?.['sessionId'] === 's1')).toBe(true);
    // And its output, should any still come, goes nowhere.
    fake.emit('s1', 'after the end\r\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(b.bytes.some((x) => x.text.includes('after the end'))).toBe(false);
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

  it('lets a page whose connection dropped come back without the passkey, once', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing } = await paired(c);
    const ticket = String(b.last('ready')?.['resume']);
    expect(ticket.length).toBeGreaterThan(40);
    b.close();

    // A passkey that would be refused, so getting in can only be the ticket's doing.
    const back = browser(relay.url, pairing, authenticator(), { resume: ticket });
    expect(await until(() => back.has('tabs'))).toBe(true);
    const next = String(back.last('ready')?.['resume']);
    expect(next).not.toBe(ticket);
    // Saying anything shows it heard the answer and has its new ticket, so the old one is done.
    back.send({ t: 'visible', visible: true });
    await new Promise((r) => setTimeout(r, 100));
    back.close();

    const again = browser(relay.url, pairing, authenticator(), { resume: ticket });
    expect(await until(() => again.closed() !== null)).toBe(true);
    expect(again.has('ready')).toBe(false);
    // The new one works.
    const third = browser(relay.url, pairing, authenticator(), { resume: next });
    expect(await until(() => third.has('tabs'))).toBe(true);
  });

  it('lets a ticket be used again when the connection dropped before the answer arrived', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing } = await paired(c);
    const ticket = String(b.last('ready')?.['resume']);
    b.close();
    const lost = browser(relay.url, pairing, authenticator(), { resume: ticket });
    await until(() => lost.has('ready'));
    // Lost before the page said anything: as far as the page knows, the answer never came.
    lost.close();
    const back = browser(relay.url, pairing, authenticator(), { resume: ticket });
    expect(await until(() => back.has('tabs'))).toBe(true);
  });

  it('closes the pages when the Mac connects to the relay again, so each comes back', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    // A second connection from the Mac, as one made after giving up on a quiet one.
    const again = new WebSocket(`${relay.url.replace('http', 'ws')}/ws/daemon/${roomOf(dir)}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(await until(() => b.closed() === 4002)).toBe(true);
    again.close();
  });

  it('takes over from a connection the Mac has not yet seen end', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing } = await paired(c);
    const ticket = String(b.last('ready')?.['resume']);
    const back = browser(relay.url, pairing, authenticator(), { resume: ticket });
    expect(await until(() => back.has('tabs'))).toBe(true);
    expect(await until(() => b.last('denied')?.['reason'] === 'resumed')).toBe(true);
  });

  it('honors no ticket of a device that was removed, or from another device', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing } = await paired(c);
    const ticket = String(b.last('ready')?.['resume']);
    const other = await paired(c);
    const theirs = browser(relay.url, other.pairing, authenticator(), { resume: ticket });
    expect(await until(() => theirs.closed() !== null)).toBe(true);
    expect(theirs.has('ready')).toBe(false);

    b.close();
    c.device({ deviceId: c.state.devices[0]?.id ?? '', forget: true });
    // Removed, it is a stranger: nothing the Mac sends opens.
    const back = browser(relay.url, pairing, authenticator(), { resume: ticket });
    expect(await until(() => back.failedToOpen() || back.closed() !== null)).toBe(true);
    expect(back.has('ready')).toBe(false);
  });

  it('does not count a page going out of sight while it unlocks as a failure', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b, pairing, passkey } = await paired(c);
    b.close();
    const back = browser(relay.url, pairing, passkey, {
      whileUnlocking: { t: 'visible', visible: false },
    });
    expect(await until(() => back.has('tabs'))).toBe(true);
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

  it('trusts a new device only once the person at the Mac approves it, by the code it shows', async () => {
    const fake = fakeHost();
    let approve = (_: boolean): void => {};
    fake.approval.answer = new Promise((r) => (approve = r));
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const link = c.pair();
    const pairing = readPairing(new URL(link?.link ?? '').hash);
    if (!pairing) throw new Error('bad link');
    const b = browser(relay.url, pairing, authenticator());
    expect(await until(() => b.has('approve'))).toBe(true);
    const code = String(b.last('approve')?.['code']);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
    expect(fake.asked).toEqual([{ name: 'Test phone', code }]);
    expect(b.has('ready')).toBe(false);
    expect(c.state.devices).toEqual([]);
    approve(true);
    expect(await until(() => b.has('tabs'))).toBe(true);
    expect(c.state.devices.map((d) => d.name)).toEqual(['Test phone']);
  });

  it('turns away a device the Mac does not approve, and its code with it', async () => {
    const fake = fakeHost();
    fake.approval.answer = Promise.resolve(false);
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const link = c.pair();
    const pairing = readPairing(new URL(link?.link ?? '').hash);
    if (!pairing) throw new Error('bad link');
    const b = browser(relay.url, pairing, authenticator());
    expect(await until(() => b.closed() !== null)).toBe(true);
    expect(b.last('denied')?.['reason']).toBe('not-approved');
    expect(c.state.devices).toEqual([]);
    // The same code again opens nothing: it was spent on the device that was turned away.
    const again = browser(relay.url, pairing, authenticator());
    expect(await until(() => again.failedToOpen())).toBe(true);
    expect(fake.asked).toHaveLength(1);
  });

  it('tells a device that failed too often when to come back, rather than just closing', async () => {
    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    const { b, pairing } = await paired(c);
    b.close();
    for (let i = 0; i < 5; i++) {
      const thief = browser(relay.url, pairing, authenticator());
      await until(() => thief.closed() !== null);
    }
    const later = browser(relay.url, pairing, authenticator());
    expect(await until(() => later.has('denied'))).toBe(true);
    expect(later.last('denied')?.['reason']).toBe('wait');
    expect(Number(later.last('denied')?.['seconds'])).toBeGreaterThan(60);
    expect(later.has('challenge')).toBe(false);
  });

  it('makes room for a new page by letting the oldest go, rather than turning it away', async () => {
    const c = connected(fakeHost().host);
    await until(() => c.state.status === 'connected');
    // Forgotten connections, as a phone put away leaves at the relay.
    const old = Array.from({ length: 8 }, () =>
      browser(
        relay.url,
        { room: roomOf(dir), device: 'some-device', key: toBase64Url(randomBytes(32)) },
        authenticator(),
      ),
    );
    await until(() => old.every((o) => o.failedToOpen()));
    const { b } = await paired(c);
    expect(b.has('tabs')).toBe(true);
    expect(await until(() => old[0]?.closed() === 4003)).toBe(true);
    expect(old.slice(1).every((o) => o.closed() === null)).toBe(true);
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

describe('a connection to the relay that has gone quiet', () => {
  /**
   * A relay that answers "ping" for a while and then not at all, with its connection still open,
   * which is what a deploy on Cloudflare can leave behind. `answers` says how many it answers on each connection.
   */
  async function quietRelay(answers: number, old = false, host = '127.0.0.1') {
    const server = new WebSocketServer({ port: 0, host });
    await new Promise((r) => server.once('listening', r));
    const seen = { connections: 0, pings: 0, from: [] as string[] };
    server.on('connection', (ws, req) => {
      seen.connections++;
      seen.from.push(req.socket.remoteAddress ?? '');
      let pings = 0;
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary || data.toString() !== 'ping') return;
        seen.pings++;
        pings++;
        // A relay from before pings closes on any text.
        if (old) ws.close(1003, 'Binary only');
        else if (pings <= answers) ws.send('pong');
      });
    });
    const { port } = server.address() as { port: number };
    return { url: `http://localhost:${String(port)}`, seen, close: () => server.close() };
  }

  function quietControl(url: string): RemoteControl {
    const c = new RemoteControl(dir, fakeHost().host, (s) => states.push(s), undefined, 50);
    c.configure({ enabled: true, relayUrl: url, relaySecret: SECRET });
    control = c;
    return c;
  }

  it('is let go and made again when the relay stops answering', async () => {
    const quiet = await quietRelay(2);
    try {
      const c = quietControl(quiet.url);
      expect(await until(() => c.state.status === 'connected')).toBe(true);
      expect(await until(() => quiet.seen.connections >= 2)).toBe(true);
      expect(await until(() => c.state.status === 'connected')).toBe(true);
    } finally {
      quiet.close();
    }
  });

  it('counts as connected only once the relay answers, and connects again if it never does', async () => {
    const quiet = await quietRelay(0);
    try {
      const c = quietControl(quiet.url);
      expect(await until(() => quiet.seen.connections >= 3)).toBe(true);
      expect(states.some((s) => s.status === 'connected')).toBe(false);
      expect(c.state.status).not.toBe('connected');
    } finally {
      quiet.close();
    }
  });

  it('reaches the relay over IPv4 where both are offered', async () => {
    const quiet = await quietRelay(Infinity, false, '::');
    try {
      const c = quietControl(quiet.url);
      expect(await until(() => c.state.status === 'connected')).toBe(true);
      expect(quiet.seen.from[0]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    } finally {
      quiet.close();
    }
  });

  it('keeps a connection that answers', async () => {
    const quiet = await quietRelay(Infinity);
    try {
      quietControl(quiet.url);
      expect(await until(() => quiet.seen.pings >= 6)).toBe(true);
      expect(quiet.seen.connections).toBe(1);
    } finally {
      quiet.close();
    }
  });

  it('stops asking a relay from before pings, instead of reconnecting over and over', async () => {
    const quiet = await quietRelay(0, true);
    try {
      const c = quietControl(quiet.url);
      expect(await until(() => quiet.seen.connections === 2)).toBe(true);
      expect(await until(() => c.state.status === 'connected')).toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      expect(quiet.seen.pings).toBe(1);
      expect(quiet.seen.connections).toBe(2);
    } finally {
      quiet.close();
    }
  });
});

describe('notifications when an agent needs somebody', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const subscription = {
    endpoint: 'https://web.push.apple.com/QGuQyavXutnMH',
    p256dh: ua.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
  };
  const flip = (fake: ReturnType<typeof fakeHost>, needsYou: boolean): void => {
    const pane = fake.tabs[0]?.panes[0];
    if (pane) pane.needsYou = needsYou;
    fake.changed();
  };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

  async function subscribed() {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    b.send({ t: 'notify', subscription });
    await until(() => b.last('notify')?.['on'] === true);
    return { fake, c, b };
  }

  it('a device turns them on with its push address, and Settings shows it', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    expect(b.last('ready')?.['vapid']).toMatch(/^[\w-]{87}$/);
    expect(b.last('ready')?.['notify']).toBe(false);
    b.send({ t: 'notify', subscription });
    expect(await until(() => b.last('notify')?.['on'] === true)).toBe(true);
    expect(c.state.devices[0]?.notify).toBe(true);
  });

  it('is not sent to a device looking at TabTerm, and is once it looks away', async () => {
    const { fake, b } = await subscribed();
    flip(fake, true);
    await settle();
    expect(pushes).toHaveLength(0);
    // Out of sight now. s2, which was waiting before any of this, stops and starts again.
    b.send({ t: 'visible', visible: false });
    await settle();
    const s2 = fake.tabs[0]?.panes[1];
    if (s2) s2.needsYou = false;
    fake.changed();
    if (s2) s2.needsYou = true;
    fake.changed();
    expect(await until(() => pushes.length === 1)).toBe(true);
  });

  it('goes to a device with nothing open, encrypted, and only once in a while', async () => {
    const { fake, c, b } = await subscribed();
    b.close();
    await until(() => c.state.browsers === 0);

    flip(fake, true);
    expect(await until(() => pushes.length === 1)).toBe(true);
    const push = pushes[0];
    expect(push?.url).toBe(subscription.endpoint);
    const headers = push?.init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers['authorization']).toMatch(/^vapid t=.+, k=/);
    expect(Buffer.from(push?.init.body as Uint8Array).toString('latin1')).not.toContain('needs');

    // Straight back to asking does not send another, and s2, waiting all along, sent none.
    flip(fake, false);
    flip(fake, true);
    await settle();
    expect(pushes).toHaveLength(1);
  });

  it('forgets a subscription the push service says is gone', async () => {
    const { fake, c, b } = await subscribed();
    b.close();
    await until(() => c.state.browsers === 0);
    pushStatus = 410;
    flip(fake, true);
    expect(await until(() => c.state.devices[0]?.notify === false)).toBe(true);
  });

  it('refuses an address that is not a push service, and turns off when asked', async () => {
    const fake = fakeHost();
    const c = connected(fake.host);
    await until(() => c.state.status === 'connected');
    const { b } = await paired(c);
    b.send({ t: 'notify', subscription: { ...subscription, endpoint: 'https://127.0.0.1/x' } });
    b.send({ t: 'notify', subscription });
    expect(await until(() => b.last('notify')?.['on'] === true)).toBe(true);
    expect(b.messages.filter((m) => m['t'] === 'notify')).toHaveLength(1);
    b.send({ t: 'notify', subscription: null });
    expect(await until(() => b.last('notify')?.['on'] === false)).toBe(true);
    expect(c.state.devices[0]?.notify).toBe(false);
  });
});
