import WebSocket from 'ws';
import {
  NONCE_BYTES,
  RELAY_GONE,
  REMOTE_MAX_FRAME,
  Sealer,
  connectionKeys,
  envelope,
  fromBase64Url,
  openEnvelope,
  packBytes,
  packHello,
  packMessage,
  randomBytes,
  readHello,
  toBase64Url,
  unpack,
  type RemoteTab,
} from '@tabterm/shared';
import { info, warn } from '../log.js';
import {
  saneSubscription,
  type RemoteStore,
  type TrustedDevice,
  type PendingPairing,
} from './store.js';
import { verifyAssertion, verifyRegistration, type Expected } from './webauthn.js';
import { sendPush, type Fetch } from './webpush.js';

/**
 * The daemon's side of remote access: one outgoing connection to the relay, and every browser
 * that reaches this Mac through it.
 *
 * **What a browser can do is decided here and nowhere else.** It can list what is running, watch
 * one terminal, and type into it when its device is allowed to. It cannot end a session, open
 * a tab, change a size, or touch a setting, because no message here does any of those things.
 * There is nothing to switch off, since there is nothing there.
 *
 * **It never joins a session.** Watching is listening to the same output the history archive
 * listens to, so a browser is invisible to everything that counts views: the size the terminal
 * runs at, whether a tab has it, and when a session in the background is ended. A phone opening
 * a terminal changes nothing about it on the Mac.
 *
 * **A slow browser cannot slow the Mac.** Output is never held back for it. When the relay
 * connection has too much waiting, that browser stops being sent output and is sent the whole
 * screen again once it has caught up.
 */

/** What the daemon offers this module. Kept small, so what a browser can reach is easy to read. */
export interface RemoteHost {
  tabs(): RemoteTab[];
  screen(sessionId: string): { cols: number; rows: number; data: string } | null;
  /** Whether it was written. False for a session that is gone. */
  write(sessionId: string, text: string): boolean;
  onOutput(listener: (sessionId: string, chunk: string) => void): () => void;
  onTabsChanged(listener: () => void): () => void;
  onResized(listener: (sessionId: string, cols: number, rows: number) => void): () => void;
}

export interface BridgeStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  detail?: string;
  browsers: number;
}

/** A browser that has not unlocked in this long is let go. */
const UNLOCK_WINDOW_MS = 60_000;
/** Output is gathered for this long before going out, so a busy terminal is a few frames a second. */
const BATCH_MS = 40;
/** Past this much waiting on the relay socket, browsers are paused and resynced. */
const BEHIND_BYTES = 4 * 1024 * 1024;
/** What one keystroke message may carry. A paste is bigger than a key and smaller than this. */
const MAX_INPUT = 64 * 1024;
/** Failed unlocks before a device is refused for a while. */
const MAX_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
/** One notification per terminal in this long, however often an agent flips back to asking. */
const NOTIFY_GAP_MS = 30_000;

type Phase = 'hello' | 'unlock' | 'ready';

interface Browser {
  id: number;
  phase: Phase;
  sealer?: Sealer;
  device?: TrustedDevice;
  pairing?: PendingPairing;
  challenge?: Uint8Array;
  watching?: string;
  streams: Map<string, number>;
  pendingOut: Map<string, string>;
  behind: boolean;
  /** Being let go: its last message, saying why, may still go out. */
  leaving?: boolean;
  /** Whether its page is on screen, as it last said. A page out of sight gets notifications. */
  visible: boolean;
  chain: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteBridge {
  readonly #host: RemoteHost;
  readonly #store: RemoteStore;
  readonly #browsers = new Map<number, Browser>();
  readonly #failures = new Map<string, { count: number; until: number }>();
  #socket: WebSocket | undefined;
  #status: BridgeStatus = { state: 'off', browsers: 0 };
  #retryMs = 1000;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  #unsubscribe: (() => void)[] = [];
  #onStatus: (status: BridgeStatus) => void;
  readonly #fetch: Fetch | undefined;
  /** Terminals whose agent needs somebody right now, so only a change is notified. */
  #needing = new Set<string>();
  readonly #notifiedAt = new Map<string, number>();

  constructor(
    host: RemoteHost,
    store: RemoteStore,
    onStatus: (s: BridgeStatus) => void = () => {},
    pushFetch?: Fetch,
  ) {
    this.#host = host;
    this.#store = store;
    this.#onStatus = onStatus;
    this.#fetch = pushFetch;
  }

  get status(): BridgeStatus {
    return { ...this.#status, browsers: this.#readyCount() };
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#unsubscribe = [
      this.#host.onOutput((sessionId, chunk) => this.#output(sessionId, chunk)),
      this.#host.onTabsChanged(() => this.#tabsChanged()),
      this.#host.onResized((sessionId, cols, rows) => {
        for (const b of this.#browsers.values()) {
          if (b.phase === 'ready' && b.watching === sessionId) {
            this.#send(b, packMessage({ t: 'size', sessionId, cols, rows }));
          }
        }
      }),
    ];
    // What already needs somebody when this starts is not news.
    this.#needing = this.#needingNow();
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    for (const u of this.#unsubscribe) u();
    this.#unsubscribe = [];
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#flushTimer);
    for (const b of this.#browsers.values()) clearTimeout(b.timer);
    this.#browsers.clear();
    this.#socket?.close(1000, 'off');
    this.#socket = undefined;
    this.#setStatus({ state: 'off', browsers: 0 });
  }

  /** A device was removed or changed in Settings: its open connections follow at once. */
  deviceChanged(deviceId: string): void {
    for (const b of this.#browsers.values()) {
      if (b.device?.id !== deviceId) continue;
      const now = this.#store.device(deviceId);
      if (!now) {
        this.#drop(b, 'removed');
        continue;
      }
      b.device = now;
      // The list carries whether it may type, so an open page hides its keys at once.
      if (b.phase === 'ready') this.#sendTabs(b);
    }
  }

  #readyCount(): number {
    let n = 0;
    for (const b of this.#browsers.values()) if (b.phase === 'ready') n++;
    return n;
  }

  #setStatus(status: BridgeStatus): void {
    this.#status = status;
    this.#onStatus(this.status);
  }

  // --- the relay -------------------------------------------------------------------------------

  #connect(): void {
    if (this.#stopped) return;
    const { relayUrl, relaySecret, room } = this.#store.state;
    let url: URL;
    try {
      url = new URL(relayUrl);
    } catch {
      this.#setStatus({
        state: 'error',
        detail: 'The relay address is not a web address',
        browsers: 0,
      });
      return;
    }
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/daemon/${room}`;
    this.#setStatus({ state: 'connecting', browsers: 0 });
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${relaySecret}` },
      maxPayload: REMOTE_MAX_FRAME + 16,
      handshakeTimeout: 15_000,
    });
    this.#socket = socket;
    socket.binaryType = 'nodebuffer';
    socket.on('open', () => {
      this.#retryMs = 1000;
      info('remote.relay.connected', {});
      this.#setStatus({ state: 'connected', browsers: 0 });
    });
    socket.on('unexpected-response', (_req, res) => {
      const detail =
        res.statusCode === 401
          ? 'The relay refused the secret'
          : `The relay answered ${String(res.statusCode)}`;
      this.#setStatus({ state: 'error', detail, browsers: 0 });
      socket.terminate();
    });
    socket.on('message', (data: Buffer) => this.#fromRelay(new Uint8Array(data)));
    socket.on('error', (e) => {
      if (this.#status.state !== 'error') {
        this.#setStatus({ state: 'error', detail: e.message, browsers: 0 });
      }
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      for (const b of this.#browsers.values()) clearTimeout(b.timer);
      this.#browsers.clear();
      if (this.#stopped) return;
      if (this.#status.state === 'connected') {
        this.#setStatus({ state: 'connecting', detail: 'Reconnecting', browsers: 0 });
      }
      this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
      this.#retryTimer.unref?.();
      this.#retryMs = Math.min(60_000, this.#retryMs * 2);
    });
  }

  #fromRelay(bytes: Uint8Array): void {
    const env = openEnvelope(bytes);
    if (!env || env.id === 0) return;
    if (env.body.length === 0) {
      this.#join(env.id);
      return;
    }
    const b = this.#browsers.get(env.id);
    if (env.body.length === 1 && env.body[0] === RELAY_GONE) {
      if (b) this.#forget(b);
      return;
    }
    if (!b || env.body.length > REMOTE_MAX_FRAME) return;
    // In order, since every frame's counter must be opened after the one before it.
    b.chain = b.chain
      .then(() => this.#receive(b, env.body))
      .catch((e: unknown) => {
        warn('remote.browser.refused', { reason: e instanceof Error ? e.message : 'unknown' });
        this.#drop(b, 'refused');
      });
  }

  #raw(id: number, body: Uint8Array): void {
    const s = this.#socket;
    if (s?.readyState === WebSocket.OPEN) s.send(envelope(id, body));
  }

  #send(b: Browser, plain: Uint8Array): void {
    const sealer = b.sealer;
    if (!sealer) return;
    b.chain = b.chain.then(async () => {
      if (!this.#browsers.has(b.id) && b.leaving !== true) return;
      this.#raw(b.id, await sealer.seal(plain));
    });
  }

  // --- one browser ---------------------------------------------------------------------------

  #join(id: number): void {
    const existing = this.#browsers.get(id);
    if (existing) this.#forget(existing);
    const b: Browser = {
      id,
      phase: 'hello',
      streams: new Map(),
      pendingOut: new Map(),
      behind: false,
      visible: true,
      chain: Promise.resolve(),
      timer: setTimeout(() => {
        if (b.phase !== 'ready') this.#drop(b, 'too-slow');
      }, UNLOCK_WINDOW_MS),
    };
    b.timer.unref?.();
    this.#browsers.set(id, b);
  }

  #forget(b: Browser): void {
    clearTimeout(b.timer);
    this.#browsers.delete(b.id);
    this.#onStatus(this.status);
  }

  /** Tell it why, sealed when it can be, and let it go. The relay closes its socket. */
  #drop(b: Browser, reason: string): void {
    b.leaving = true;
    if (b.sealer) this.#send(b, packMessage({ t: 'denied', reason }));
    void b.chain.then(() => this.#raw(b.id, new Uint8Array([RELAY_GONE])));
    this.#forget(b);
  }

  #expected(challenge: Uint8Array): Expected {
    const url = new URL(this.#store.state.relayUrl);
    return { challenge, origin: url.origin, rpId: url.hostname };
  }

  async #receive(b: Browser, body: Uint8Array): Promise<void> {
    if (b.phase === 'hello') {
      const hello = readHello(body);
      if (!hello || typeof hello['device'] !== 'string' || typeof hello['nonce'] !== 'string') {
        throw new Error('bad-hello');
      }
      const deviceId = hello['device'];
      const blocked = this.#failures.get(deviceId);
      if (blocked && blocked.count >= MAX_FAILURES && Date.now() < blocked.until) {
        throw new Error('cooling-down');
      }
      const device = this.#store.device(deviceId);
      const pairing = device ? undefined : this.#store.pendingFor(deviceId);
      // An id nobody issued is answered like any other, and then nothing it sends will open.
      const key = device?.key ?? pairing?.key ?? toBase64Url(randomBytes(32));
      const browserNonce = fromBase64Url(hello['nonce']);
      if (browserNonce.length !== NONCE_BYTES) throw new Error('bad-nonce');
      const daemonNonce = randomBytes(NONCE_BYTES);
      b.sealer = new Sealer(
        await connectionKeys(fromBase64Url(key), browserNonce, daemonNonce, 'daemon'),
      );
      if (device) b.device = device;
      if (pairing) b.pairing = pairing;
      this.#raw(b.id, packHello({ nonce: toBase64Url(daemonNonce) }));
      b.challenge = randomBytes(32);
      b.phase = 'unlock';
      const url = new URL(this.#store.state.relayUrl);
      this.#send(
        b,
        packMessage({
          t: 'challenge',
          mode: device ? 'unlock' : 'register',
          challenge: toBase64Url(b.challenge),
          rpId: url.hostname,
          ...(device
            ? { credentialId: device.passkey.credentialId }
            : { userId: deviceId, room: this.#store.state.room }),
        }),
      );
      return;
    }

    const sealer = b.sealer;
    if (!sealer) throw new Error('no-keys');
    const frame = unpack(await sealer.open(body));
    if (!frame || frame.kind !== 'message') return;
    const m = frame.message;

    if (b.phase === 'unlock') {
      this.#unlock(b, m);
      return;
    }

    switch (m['t']) {
      case 'watch': {
        const sessionId = typeof m['sessionId'] === 'string' ? m['sessionId'] : '';
        this.#watch(b, sessionId);
        return;
      }
      case 'input': {
        const sessionId = m['sessionId'];
        const data = m['data'];
        // Only into the terminal it is looking at, and only from a device allowed to type.
        if (!b.device?.typing || typeof sessionId !== 'string' || sessionId !== b.watching) return;
        if (typeof data !== 'string') return;
        if (data.length > MAX_INPUT) return;
        this.#host.write(sessionId, data);
        return;
      }
      case 'tabs':
        this.#sendTabs(b);
        return;
      case 'ping':
        this.#send(b, packMessage({ t: 'pong' }));
        return;
      case 'visible':
        b.visible = m['visible'] !== false;
        return;
      case 'notify': {
        // Notifications for this device, on with where to send them, or off with null.
        const device = b.device;
        if (!device) return;
        const sub = m['subscription'];
        if (sub === null) this.#store.setPush(device.id, undefined);
        else if (saneSubscription(sub)) this.#store.setPush(device.id, sub);
        else return;
        b.device = this.#store.device(device.id) ?? device;
        this.#send(b, packMessage({ t: 'notify', on: b.device.push !== undefined }));
        this.#onStatus(this.status);
        return;
      }
      default:
        // Anything else is not something a browser can ask for, and is ignored.
        return;
    }
  }

  #unlock(b: Browser, m: Record<string, unknown>): void {
    const bytes = (k: string): Uint8Array => {
      const v = m[k];
      if (typeof v !== 'string') throw new Error(`missing-${k}`);
      return fromBase64Url(v);
    };
    const challenge = b.challenge;
    if (!challenge) throw new Error('no-challenge');
    const expected = this.#expected(challenge);
    delete b.challenge;
    try {
      if (b.device && m['t'] === 'unlock') {
        const count = verifyAssertion(expected, b.device.passkey, {
          credentialId: typeof m['credentialId'] === 'string' ? m['credentialId'] : '',
          clientDataJSON: bytes('clientDataJSON'),
          authenticatorData: bytes('authenticatorData'),
          signature: bytes('signature'),
        });
        this.#store.seen(b.device.id, count);
      } else if (b.pairing && m['t'] === 'register') {
        const passkey = verifyRegistration(expected, {
          clientDataJSON: bytes('clientDataJSON'),
          attestationObject: bytes('attestationObject'),
        });
        const name = typeof m['name'] === 'string' ? m['name'] : 'Device';
        b.device = this.#store.trust(b.pairing, name, passkey);
        delete b.pairing;
        info('remote.device.paired', { device: b.device.id.slice(0, 6) });
      } else {
        throw new Error('unexpected-unlock');
      }
    } catch (e) {
      const id = b.device?.id ?? b.pairing?.id ?? '';
      const f = this.#failures.get(id) ?? { count: 0, until: 0 };
      f.count++;
      f.until = Date.now() + FAILURE_COOLDOWN_MS;
      this.#failures.set(id, f);
      throw e;
    }
    this.#failures.delete(b.device.id);
    clearTimeout(b.timer);
    b.phase = 'ready';
    info('remote.browser.ready', { device: b.device.id.slice(0, 6) });
    this.#send(
      b,
      packMessage({
        t: 'ready',
        name: b.device.name,
        typing: b.device.typing,
        notify: b.device.push !== undefined,
        vapid: this.#store.vapid().publicKey,
      }),
    );
    this.#sendTabs(b);
    this.#onStatus(this.status);
  }

  // --- what it sees --------------------------------------------------------------------------

  #streamOf(b: Browser, sessionId: string): number {
    let n = b.streams.get(sessionId);
    if (n === undefined) {
      n = b.streams.size + 1;
      b.streams.set(sessionId, n);
    }
    return n;
  }

  #sendTabs(b: Browser): void {
    const tabs = this.#host.tabs().map((tab) => ({
      ...tab,
      panes: tab.panes.map((p) => ({ ...p, stream: this.#streamOf(b, p.sessionId) })),
    }));
    this.#send(b, packMessage({ t: 'tabs', tabs, typing: b.device?.typing === true }));
  }

  #tabsChanged(): void {
    for (const b of this.#browsers.values()) if (b.phase === 'ready') this.#sendTabs(b);
    this.#notifyNewlyNeeding();
  }

  // --- notifications -------------------------------------------------------------------------

  #needingNow(): Set<string> {
    const out = new Set<string>();
    for (const tab of this.#host.tabs()) {
      for (const p of tab.panes) if (p.needsYou) out.add(p.sessionId);
    }
    return out;
  }

  /**
   * An agent just started needing somebody: every device that asked for notifications and is not
   * looking at TabTerm right now gets one. Sent from here to the device's push service, encrypted
   * to the device, so the relay is not involved and the push service cannot read it.
   */
  #notifyNewlyNeeding(): void {
    const tabs = this.#host.tabs();
    const now = new Set<string>();
    const fresh: { sessionId: string; title: string; body: string }[] = [];
    for (const tab of tabs) {
      for (const p of tab.panes) {
        if (!p.needsYou) continue;
        now.add(p.sessionId);
        if (this.#needing.has(p.sessionId)) continue;
        const last = this.#notifiedAt.get(p.sessionId) ?? 0;
        if (Date.now() - last < NOTIFY_GAP_MS) continue;
        this.#notifiedAt.set(p.sessionId, Date.now());
        fresh.push({
          sessionId: p.sessionId,
          title: tab.title === p.title ? 'TabTerm' : tab.title,
          body: `${p.title} needs you`,
        });
      }
    }
    this.#needing = now;
    if (fresh.length === 0) return;
    const looking = new Set<string>();
    for (const b of this.#browsers.values()) {
      if (b.phase === 'ready' && b.visible && b.device) looking.add(b.device.id);
    }
    const relay = this.#store.state.relayUrl;
    const subject = relay.startsWith('https://')
      ? new URL(relay).origin
      : 'mailto:tabterm@localhost';
    for (const device of this.#store.state.devices) {
      const sub = device.push;
      if (!sub || looking.has(device.id)) continue;
      for (const n of fresh) {
        void sendPush(
          sub,
          { title: n.title, body: n.body, session: n.sessionId },
          this.#store.vapid(),
          subject,
          this.#fetch,
        ).then((result) => {
          info('remote.notify', { device: device.id.slice(0, 6), result });
          // Unsubscribed on the device, or expired: forgotten, and Settings says so.
          if (result === 'gone' && this.#store.device(device.id)?.push?.endpoint === sub.endpoint) {
            this.#store.setPush(device.id, undefined);
            this.#onStatus(this.status);
          }
        });
      }
    }
  }

  #watch(b: Browser, sessionId: string): void {
    const screen = this.#host.screen(sessionId);
    if (!screen) {
      this.#send(b, packMessage({ t: 'ended', sessionId }));
      return;
    }
    b.watching = sessionId;
    b.pendingOut.clear();
    b.behind = false;
    const stream = this.#streamOf(b, sessionId);
    this.#send(
      b,
      packMessage({ t: 'screen', sessionId, stream, cols: screen.cols, rows: screen.rows }),
    );
    this.#send(b, packBytes(stream, new TextEncoder().encode(screen.data)));
  }

  #output(sessionId: string, chunk: string): void {
    let any = false;
    for (const b of this.#browsers.values()) {
      if (b.phase !== 'ready' || b.watching !== sessionId || b.behind) continue;
      b.pendingOut.set(sessionId, (b.pendingOut.get(sessionId) ?? '') + chunk);
      any = true;
    }
    if (any && this.#flushTimer === undefined) {
      this.#flushTimer = setTimeout(() => this.#flush(), BATCH_MS);
      this.#flushTimer.unref?.();
    }
  }

  #flush(): void {
    this.#flushTimer = undefined;
    const waiting = this.#socket?.bufferedAmount ?? 0;
    for (const b of this.#browsers.values()) {
      if (b.pendingOut.size === 0) continue;
      if (waiting > BEHIND_BYTES) {
        // Too much queued: stop sending this one output, and give it the whole screen later.
        b.pendingOut.clear();
        if (!b.behind) {
          b.behind = true;
          this.#catchUp(b);
        }
        continue;
      }
      for (const [sessionId, text] of b.pendingOut) {
        const data = new TextEncoder().encode(text);
        const stream = this.#streamOf(b, sessionId);
        // Split so no frame is larger than the relay accepts.
        for (let i = 0; i < data.length; i += REMOTE_MAX_FRAME / 2) {
          this.#send(b, packBytes(stream, data.subarray(i, i + REMOTE_MAX_FRAME / 2)));
        }
      }
      b.pendingOut.clear();
    }
  }

  #catchUp(b: Browser): void {
    const check = setInterval(() => {
      if (!this.#browsers.has(b.id)) return clearInterval(check);
      if ((this.#socket?.bufferedAmount ?? 0) > BEHIND_BYTES / 4) return;
      clearInterval(check);
      b.behind = false;
      if (b.watching) this.#watch(b, b.watching);
    }, 250);
    check.unref?.();
  }
}
