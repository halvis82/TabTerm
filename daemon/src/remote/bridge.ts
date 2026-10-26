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
  /** Whether it is still running, and so can be watched. */
  alive(sessionId: string): boolean;
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
/** Pages whose last key is remembered, so one sent again is not typed twice. */
const MAX_PAGES_TYPING = 64;
/** Failed unlocks before a device is refused for a while. */
const MAX_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
/** One notification per terminal in this long, however often an agent flips back to asking. */
const NOTIFY_GAP_MS = 30_000;
/**
 * How often the relay is asked whether this connection still reaches it. A deploy or a network
 * change can leave a connection that looks open on this side and goes nowhere, and without asking,
 * the Mac would wait on it forever while every device was told it was offline.
 */
const PING_MS = 15_000;
/**
 * How long after a connection drops its page may come back without the passkey. A phone on a train,
 * or the relay letting go of the Mac for a second, should not mean Face ID again; a page gone for
 * longer, or one closed and opened again, unlocks as usual.
 */
const RESUME_MS = 10 * 60_000;
/**
 * A ticket just used stays good this long, until its page says something on the new connection.
 * A connection that drops again before the page heard the Mac's answer, with its new ticket, can
 * then still come back with the old one.
 */
const RESUME_GRACE_MS = 30_000;
/** Resume tickets one device may hold at once, one per open page. */
const MAX_RESUMES = 4;
/** What a page still unlocking may send. Anything else is ignored, never counted as a failure. */
const UNLOCKING = new Set(['unlock', 'register', 'resume']);
/** What a connection says when there is no way to the relay over the address family it tried. */
const NO_ROUTE = new Set([
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'EAI_AGAIN',
]);
/** How long a new connection has to answer its first ping before it is made again. */
const FIRST_ANSWER_MS = 5_000;

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
  /** Said something since it was ready, so any ticket it came back with is used up. */
  confirmed?: boolean;
  /** Whether its page is on screen, as it last said. A page out of sight gets notifications. */
  visible: boolean;
  /** What it sent, opened in order, since each frame's counter must follow the one before. */
  inbox: Promise<void>;
  /**
   * What goes to it, sealed in order. Apart from the inbox, so a key typed while a screenful is
   * being sealed is not held up behind it.
   */
  outbox: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteBridge {
  readonly #host: RemoteHost;
  readonly #store: RemoteStore;
  readonly #browsers = new Map<number, Browser>();
  readonly #failures = new Map<string, { count: number; until: number }>();
  /** The last key each page has had written, by the page's own id, newest last. */
  readonly #typedUpTo = new Map<string, number>();
  /**
   * Resume tickets, by ticket. Each is 32 random bytes made here, sent to one unlocked page inside
   * its sealed connection, and kept by that page in memory only. Good once, for one device, and
   * from the moment its page's connection ends for RESUME_MS. The relay never sees one.
   */
  readonly #resumes = new Map<
    string,
    { device: string; browser: number; until: number; spent?: boolean }
  >();
  #socket: WebSocket | undefined;
  #status: BridgeStatus = { state: 'off', browsers: 0 };
  #retryMs = 1000;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #flushedAt = 0;
  #stopped = true;
  #unsubscribe: (() => void)[] = [];
  #onStatus: (status: BridgeStatus) => void;
  readonly #fetch: Fetch | undefined;
  /** Terminals whose agent needs somebody right now, so only a change is notified. */
  #needing = new Set<string>();
  readonly #notifiedAt = new Map<string, number>();
  readonly #pingMs: number;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  /** A relay from before it answered "ping" closes on any text. It is then not asked again. */
  #relayPings = true;
  #ipv4 = true;

  constructor(
    host: RemoteHost,
    store: RemoteStore,
    onStatus: (s: BridgeStatus) => void = () => {},
    pushFetch?: Fetch,
    pingMs = PING_MS,
  ) {
    this.#host = host;
    this.#store = store;
    this.#onStatus = onStatus;
    this.#fetch = pushFetch;
    this.#pingMs = pingMs;
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
    clearInterval(this.#pingTimer);
    for (const b of this.#browsers.values()) clearTimeout(b.timer);
    this.#browsers.clear();
    this.#resumes.clear();
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
        for (const [t, r] of this.#resumes) if (r.device === deviceId) this.#resumes.delete(t);
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
      // Everything sent is encrypted, which does not compress, so compression would only cost memory.
      perMessageDeflate: false,
      /*
       * IPv4 where there is any. Over IPv6 from a home connection, Cloudflare was measured dropping
       * the Mac's side of the connection, without telling the Mac, moments after a device closed
       * its own: about one run in two over IPv6, none in twelve over IPv4. A network with no IPv4
       * at all is tried over IPv6 next time.
       */
      ...(this.#ipv4 ? { family: 4 } : {}),
    });
    this.#socket = socket;
    socket.binaryType = 'nodebuffer';
    /*
     * Asked, and not answered by the next time: the connection is let go and made again. The first
     * ask is the moment it opens, and it counts as connected only once answered: just after the
     * relay is deployed, a connection can open onto the copy being shut down and reach nothing.
     */
    let asked = false;
    let answered = false;
    let firstCheck: ReturnType<typeof setTimeout> | undefined;
    const ask = (): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      asked = true;
      socket.send('ping');
    };
    const ready = (): void => {
      this.#retryMs = 1000;
      info('remote.relay.connected', {});
      this.#setStatus({ state: 'connected', browsers: 0 });
    };
    socket.on('open', () => {
      clearInterval(this.#pingTimer);
      if (!this.#relayPings) {
        ready();
        return;
      }
      ask();
      firstCheck = setTimeout(
        () => {
          if (answered) return;
          warn('remote.relay.unreachable', {});
          socket.terminate();
        },
        Math.min(FIRST_ANSWER_MS, this.#pingMs),
      );
      firstCheck.unref?.();
      this.#pingTimer = setInterval(() => {
        if (asked && answered) {
          warn('remote.relay.silent', {});
          socket.terminate();
          return;
        }
        if (answered) ask();
      }, this.#pingMs);
      this.#pingTimer.unref?.();
    });
    socket.on('unexpected-response', (_req, res) => {
      const detail =
        res.statusCode === 401
          ? 'The relay refused the secret'
          : `The relay answered ${String(res.statusCode)}`;
      this.#setStatus({ state: 'error', detail, browsers: 0 });
      socket.terminate();
    });
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.#fromRelay(new Uint8Array(data));
      } else if (data.toString() === 'pong') {
        asked = false;
        if (!answered) {
          answered = true;
          clearTimeout(firstCheck);
          ready();
        }
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (socket.readyState !== WebSocket.OPEN && NO_ROUTE.has(e.code ?? '')) {
        this.#ipv4 = !this.#ipv4;
      }
      if (this.#status.state !== 'error') {
        this.#setStatus({ state: 'error', detail: e.message, browsers: 0 });
      }
    });
    socket.on('close', (code: number, reason: Buffer) => {
      if (this.#socket !== socket) return;
      info('remote.relay.closed', { code, reason: reason.toString().slice(0, 60) });
      clearInterval(this.#pingTimer);
      clearTimeout(firstCheck);
      if (code === 1003 && !answered) this.#relayPings = false;
      for (const b of this.#browsers.values()) {
        clearTimeout(b.timer);
        this.#released(b);
      }
      this.#browsers.clear();
      if (this.#stopped) return;
      if (this.#status.state === 'connected') {
        this.#setStatus({ state: 'connecting', detail: 'Reconnecting', browsers: 0 });
      }
      this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
      this.#retryTimer.unref?.();
      // Kept short: every device is waiting on this, asking again every few seconds itself.
      this.#retryMs = Math.min(10_000, this.#retryMs * 2);
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
    b.inbox = b.inbox
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
    b.outbox = b.outbox.then(async () => {
      if (!this.#browsers.has(b.id) && b.leaving !== true) return;
      this.#raw(b.id, await sealer.seal(plain));
    });
  }

  // --- one browser ---------------------------------------------------------------------------

  #join(id: number): void {
    info('remote.browser.join', {});
    const existing = this.#browsers.get(id);
    if (existing) this.#forget(existing);
    const b: Browser = {
      id,
      phase: 'hello',
      streams: new Map(),
      pendingOut: new Map(),
      behind: false,
      visible: true,
      inbox: Promise.resolve(),
      outbox: Promise.resolve(),
      timer: setTimeout(() => {
        if (b.phase !== 'ready') this.#drop(b, 'too-slow');
      }, UNLOCK_WINDOW_MS),
    };
    b.timer.unref?.();
    this.#browsers.set(id, b);
  }

  #forget(b: Browser): void {
    clearTimeout(b.timer);
    this.#released(b);
    this.#browsers.delete(b.id);
    this.#onStatus(this.status);
  }

  /** Its page's connection ended: the page's ticket now runs out in RESUME_MS. */
  #released(b: Browser): void {
    for (const r of this.#resumes.values()) {
      if (r.browser === b.id && r.until === Infinity) r.until = Date.now() + RESUME_MS;
    }
  }

  /** A new ticket for a page that just unlocked or resumed. */
  #ticket(b: Browser, device: string): string {
    const now = Date.now();
    const mine: string[] = [];
    for (const [t, r] of this.#resumes) {
      if (r.until <= now) this.#resumes.delete(t);
      else if (r.device === device) mine.push(t);
    }
    // The oldest go first, so a device with many pages cannot fill this up.
    for (const t of mine.slice(0, Math.max(0, mine.length - MAX_RESUMES + 1))) {
      this.#resumes.delete(t);
    }
    const ticket = toBase64Url(randomBytes(32));
    this.#resumes.set(ticket, { device, browser: b.id, until: Infinity });
    return ticket;
  }

  /** Tell it why, sealed when it can be, and let it go. The relay closes its socket. */
  #drop(b: Browser, reason: string): void {
    info('remote.browser.dropped', { reason });
    b.leaving = true;
    if (b.sealer) this.#send(b, packMessage({ t: 'denied', reason }));
    void b.outbox.then(() => this.#raw(b.id, new Uint8Array([RELAY_GONE])));
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
      // A page tells the Mac when it goes out of sight, which Face ID coming up can do.
      if (!UNLOCKING.has(String(m['t']))) return;
      this.#unlock(b, m);
      return;
    }

    if (!b.confirmed) {
      // It heard the Mac's answer, new ticket and all, so the one it came back with is done.
      b.confirmed = true;
      for (const [t, r] of this.#resumes) {
        if (r.spent === true && r.browser === b.id) this.#resumes.delete(t);
      }
    }

    switch (m['t']) {
      case 'watch': {
        const sessionId = typeof m['sessionId'] === 'string' ? m['sessionId'] : '';
        this.#watch(b, sessionId);
        return;
      }
      case 'unwatch':
        // Back on the list: its terminal's output stops coming, rather than streaming unseen.
        delete b.watching;
        b.pendingOut.clear();
        return;
      case 'input': {
        const sessionId = m['sessionId'];
        const data = m['data'];
        /*
         * Numbered by the page that typed it, and answered, so a page whose connection dropped can
         * send again what it never heard back about. Written once however often it arrives: a key
         * sent twice into a shell is a command run twice.
         */
        const page = typeof m['page'] === 'string' ? m['page'].slice(0, 32) : '';
        const n = typeof m['n'] === 'number' && Number.isSafeInteger(m['n']) ? m['n'] : -1;
        if (page !== '' && n >= 0) {
          this.#send(b, packMessage({ t: 'got', n }));
          const last = this.#typedUpTo.get(page) ?? -1;
          if (n <= last) return;
          this.#typedUpTo.delete(page);
          this.#typedUpTo.set(page, n);
          for (const old of this.#typedUpTo.keys()) {
            if (this.#typedUpTo.size <= MAX_PAGES_TYPING) break;
            this.#typedUpTo.delete(old);
          }
        }
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
      } else if (b.device && m['t'] === 'resume') {
        const ticket = typeof m['ticket'] === 'string' ? m['ticket'] : '';
        const r = this.#resumes.get(ticket);
        if (!r || r.device !== b.device.id || r.until <= Date.now()) {
          this.#resumes.delete(ticket);
          throw new Error('bad-resume');
        }
        // The connection it replaces may not have been noticed ending yet: it goes now.
        const old = this.#browsers.get(r.browser);
        if (old && old !== b) this.#drop(old, 'resumed');
        Object.assign(r, { browser: b.id, until: Date.now() + RESUME_GRACE_MS, spent: true });
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
        resume: this.#ticket(b, b.device.id),
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
    for (const b of this.#browsers.values()) {
      if (b.phase !== 'ready') continue;
      // The terminal being watched has ended, by exit or by closing it on the Mac: said at once, so
      // the page does not sit on a screen that will never change again.
      if (b.watching && !this.#host.alive(b.watching)) {
        this.#send(b, packMessage({ t: 'ended', sessionId: b.watching }));
        delete b.watching;
      }
      this.#sendTabs(b);
    }
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
      /*
       * Output after a quiet spell goes at once: that is a key's echo, and waiting on it is lag
       * the person typing feels. Output that keeps coming is gathered for BATCH_MS at a time.
       */
      const quiet = Date.now() - this.#flushedAt >= BATCH_MS;
      this.#flushTimer = setTimeout(() => this.#flush(), quiet ? 0 : BATCH_MS);
      this.#flushTimer.unref?.();
    }
  }

  #flush(): void {
    this.#flushTimer = undefined;
    this.#flushedAt = Date.now();
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
