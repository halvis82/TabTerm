import { Terminal } from '@xterm/xterm';
import {
  NONCE_BYTES,
  Sealer,
  connectionKeys,
  fromBase64Url,
  importDeviceKey,
  packHello,
  packMessage,
  randomBytes,
  readHello,
  readPairing,
  toBase64Url,
  unpack,
  type RemoteTab,
} from '../../shared/src/remote.js';
import { Predictor } from './predict.js';
import { startScan, type Scan } from './scan.js';

/**
 * TabTerm in a browser away from the Mac: the page the relay serves.
 *
 * What it can do is what the daemon allows a browser and no more: list what is running, watch a
 * terminal, and type into it when this device may. There is no button here to end a session or to
 * open anything on the Mac, and if there were, the daemon would not act on it.
 *
 * The device key lives in IndexedDB as a WebCrypto key that cannot be read back out, and every
 * connection is unlocked with this device's passkey, so Face ID, Touch ID or the passcode stands
 * between somebody holding the phone and the terminals.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// What this device keeps
// ---------------------------------------------------------------------------

interface Paired {
  room: string;
  device: string;
  key: CryptoKey;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tabterm', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pairing');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
  });
}

async function loadPairing(): Promise<Paired | null> {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction('pairing').objectStore('pairing').get('this');
    req.onsuccess = () => resolve((req.result as Paired | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function savePairing(p: Paired): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pairing', 'readwrite');
    tx.objectStore('pairing').put(p, 'this');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb'));
  });
}

async function forgetPairing(): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pairing', 'readwrite');
    tx.objectStore('pairing').delete('this');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb'));
  });
}

/**
 * How long this device stays unlocked while nobody uses the page: through a reload, the app closed
 * and opened again, or a connection lost. Longer away, it asks for Face ID or Touch ID again. The
 * Mac holds each ticket to the same time, counted from when the page was last connected.
 */
const AWAY_MS = 30 * 60_000;

interface Resume {
  ticket: string;
  /** When the page was last in use, which the time away is counted from. */
  seen: number;
}

async function loadResume(): Promise<Resume | null> {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction('pairing').objectStore('pairing').get('resume');
    req.onsuccess = () => resolve((req.result as Resume | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

/** Kept beside the pairing, or let go with null. Best effort: memory still has it. */
function saveResume(r: Resume | null): void {
  void idb()
    .then((db) => {
      const tx = db.transaction('pairing', 'readwrite');
      if (r) tx.objectStore('pairing').put(r, 'resume');
      else tx.objectStore('pairing').delete('resume');
    })
    .catch(() => undefined);
}

/** A name for this device in the Mac's list, so somebody can tell their phone from their iPad. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : 'Safari';
  // Added to the Home Screen it is an app of its own, paired apart from Safari.
  const app =
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return app ? `${what}, Home Screen app` : `${what}, ${browser}`;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

type Screen = 'lock' | 'list' | 'terminal';

function show(screen: Screen): void {
  for (const s of ['lock', 'list', 'terminal'] as const) $(`screen-${s}`).hidden = s !== screen;
  document.body.dataset['screen'] = screen;
}

function say(text: string, tone: 'plain' | 'warn' | 'busy' = 'plain'): void {
  const el = $('lock-status');
  el.textContent = text;
  el.dataset['tone'] = tone;
}

// ---------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  scrollback: 5000,
  cursorBlink: false,
  allowProposedApi: false,
  theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
});
/*
 * The phone never answers a program's questions about the terminal.
 *
 * Programs ask what kind of terminal they are in, where the cursor is, what the background color
 * is. The view on the Mac answers, and a phone answering as well would type a second answer into
 * the program, which arrives as stray characters at the prompt or in an agent's input. So every
 * question is swallowed here, unanswered. Setting a color is still applied; only asking is ignored.
 */
const swallow = (): boolean => true;
for (const id of [
  { final: 'c' },
  { prefix: '>', final: 'c' },
  { prefix: '=', final: 'c' },
  { final: 'n' },
  { prefix: '?', final: 'n' },
  { prefix: '>', final: 'q' },
  { intermediates: '$', final: 'p' },
  { prefix: '?', intermediates: '$', final: 'p' },
  { prefix: '?', final: 'u' },
  { final: 't' },
]) {
  term.parser.registerCsiHandler(id, swallow);
}
for (const id of [
  { intermediates: '$', final: 'q' },
  { intermediates: '+', final: 'q' },
]) {
  term.parser.registerDcsHandler(id, swallow);
}
for (const code of [4, 10, 11, 12, 17, 19, 104]) {
  term.parser.registerOscHandler(code, (data) => data.includes('?'));
}
/**
 * Instant typing: keys shown before the Mac's echo arrives, drawn over the terminal and checked
 * against every echo. See predict.ts for when a guess is shown and when it is not.
 */
const guessLayer = document.createElement('div');
guessLayer.className = 'guesses';
guessLayer.setAttribute('aria-hidden', 'true');
const predictor = new Predictor(term, () => drawGuesses());

function drawGuesses(): void {
  const screen = termOpened ? $('term').querySelector<HTMLElement>('.xterm-screen') : null;
  if (!screen) return;
  if (guessLayer.parentElement !== screen) screen.append(guessLayer);
  const w = screen.offsetWidth / term.cols;
  const h = screen.offsetHeight / term.rows;
  const top = term.buffer.active.viewportY;
  const cell = (x: number, y: number, cls: string, text: string): HTMLElement | null => {
    if (y - top < 0 || y - top >= term.rows) return null;
    const span = el('span', cls, text);
    span.style.left = `${String(x * w)}px`;
    span.style.top = `${String((y - top) * h)}px`;
    span.style.width = `${String(w)}px`;
    span.style.height = span.style.lineHeight = `${String(h)}px`;
    return span;
  };
  const spans = predictor.shown.map((g) =>
    cell(g.x, g.y, g.erase ? 'erased' : 'guess', g.erase ? '' : g.ch),
  );
  const cursor = predictor.cursor;
  if (cursor) spans.push(cell(cursor.x, cursor.y, 'guess-cursor', ''));
  guessLayer.style.fontFamily = term.options.fontFamily ?? 'monospace';
  guessLayer.style.fontSize = `${String(term.options.fontSize ?? 12)}px`;
  guessLayer.replaceChildren(...spans.filter((s): s is HTMLElement => s !== null));
}

/** Focus in and out, which a program that asked for them would read as the Mac's view moving. */
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O']);

let termOpened = false;
let size = { cols: 80, rows: 24 };
let zoom = 1;
/** A phone or tablet, as opposed to a computer with a mouse. */
const touch = matchMedia('(pointer: coarse)').matches;

/**
 * Which way the terminal fills the screen, switched with the button beside A- and A+.
 *
 * Height: the rows fill the screen from top to bottom and a wide terminal scrolls sideways, the
 * way to read it on a phone. Width: the whole terminal is shown, as wide as the screen, with empty
 * space above and below it. Asked for as "just the option, a quick button to choose which to view".
 */
type FitMode = 'height' | 'width';
let fitMode: FitMode = touch ? 'height' : 'width';
try {
  const saved = localStorage.getItem('tabterm.fitMode');
  if (saved === 'height' || saved === 'width') fitMode = saved;
  // The Fit switch this replaced, which meant the same as width.
  else if (localStorage.getItem('tabterm.fitAll') === '1') fitMode = 'width';
} catch {
  // Storage refused: start with the default.
}

/**
 * A cell's width and height for each pixel of font size, measured from what xterm drew. Starts as
 * a monospace font's usual shape, and is measured again once there is something on screen.
 */
let cell = { w: 0.6, h: 1.17 };
function measureCell(): void {
  const screen = $('term').querySelector<HTMLElement>('.xterm-screen');
  const px = term.options.fontSize ?? 12;
  if (!screen || screen.offsetWidth === 0) return;
  cell = {
    w: screen.offsetWidth / (size.cols * px),
    h: screen.offsetHeight / (size.rows * px),
  };
}

/**
 * The Mac's size, made as large as the fit mode allows.
 *
 * The terminal keeps the Mac's columns and rows, since the program in it drew for those, and a
 * phone watching never changes the size on the Mac. Height fills the screen from top to bottom and
 * scrolls sideways, and A- and A+ scale from there. Width shows all of it, as wide as the screen or
 * as tall, whichever runs out first, centered with the space around it left empty.
 */
const LARGEST_PX = 32;
function fitFont(): void {
  const wrap = $('term-wrap');
  const across = (wrap.clientWidth - 8) / (size.cols * cell.w);
  const down = (wrap.clientHeight - 8) / (size.rows * cell.h);
  const px =
    fitMode === 'width'
      ? Math.max(3, Math.min(LARGEST_PX, across, down))
      : Math.max(5, Math.min(LARGEST_PX, down * zoom));
  const rounded = Math.floor(px * 4) / 4;
  if (term.options.fontSize !== rounded) term.options.fontSize = rounded;
  const fit = $('fit');
  fit.textContent = fitMode === 'width' ? 'Width' : 'Height';
  fit.setAttribute(
    'aria-label',
    fitMode === 'width'
      ? 'Showing the whole width. Tap to fill the height and scroll sideways'
      : 'Filling the height. Tap to show the whole width',
  );
  wrap.dataset.fit = fitMode;
  $<HTMLButtonElement>('zoom-in').disabled = fitMode === 'width';
  $<HTMLButtonElement>('zoom-out').disabled = fitMode === 'width';
}

/**
 * Fitted, then fitted again with the cell as drawn, since a font's real shape is only known then.
 * Rows and columns are drawn on whole pixels, so the drawn terminal can still come out a little
 * larger than the fitted one: when the fitted size is the one in use, it steps down until it fits.
 */
function refit(): void {
  fitFont();
  if (!termOpened) return;
  requestAnimationFrame(() => {
    measureCell();
    fitFont();
    if (fitMode === 'height' && zoom !== 1) return;
    const screen = $('term').querySelector<HTMLElement>('.xterm-screen');
    const wrap = $('term-wrap');
    const overOne = (): boolean =>
      !!screen &&
      (screen.offsetWidth > wrap.clientWidth - 8 || screen.offsetHeight > wrap.clientHeight - 8);
    // Filling the height scrolls sideways on purpose, so there only taller than the screen is too big.
    const tooTall = (): boolean => !!screen && screen.offsetHeight > wrap.clientHeight - 8;
    const tooBig = fitMode === 'height' ? tooTall : overOne;
    for (let i = 0; i < 16 && tooBig() && (term.options.fontSize ?? 0) > 3; i++) {
      term.options.fontSize = (term.options.fontSize ?? 12) - 0.25;
    }
  });
}

function setSize(cols: number, rows: number): void {
  size = { cols, rows };
  term.resize(cols, rows);
  refit();
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/**
 * One connection to the Mac, and everything that belongs to it alone: its keys, and what it has
 * sent and is sending. Kept together so a connection that has been replaced can never touch the
 * one after it, whatever it still had queued.
 */
interface Conn {
  socket: WebSocket;
  sealer: Sealer | null;
  /** What arrived, opened in order, since each frame's counter must follow the one before. */
  inbox: Promise<void>;
  /** What goes out, sealed in order. Apart from the inbox, so a key never waits on output. */
  outbox: Promise<void>;
  /** A sealed frame has opened, so this device's key is the one the Mac used. */
  opened: boolean;
  /** Unlocked, so it may say more than how it unlocks. */
  ready: boolean;
  /** When anything last arrived, which a ping checks for. */
  heard: number;
  /** Why the Mac let it go, when it said. */
  denied: string | null;
  /** How long until it may try again, when the reason is too many failed unlocks. */
  waitSeconds: number;
  timers: number[];
}

let conn: Conn | null = null;
let retryTimer = 0;
let tabs: RemoteTab[] = [];
let watching: string | null = null;
/** The stream the watched terminal's output comes on. -1 for none. */
let watchingStream = -1;
let typing = false;
let pendingChallenge: Record<string, unknown> | null = null;
let retry = 1000;
/**
 * The Mac's resume ticket: a dropped connection, a reload or the app opened again comes back with
 * it instead of the passkey, within AWAY_MS of the page last being used. Kept until the Mac
 * answers, and replaced on every unlock.
 */
let ticket: string | null = null;
let ticketSavedAt = 0;
function setTicket(value: string | null): void {
  ticket = value;
  ticketSavedAt = Date.now();
  saveResume(value ? { ticket: value, seen: ticketSavedAt } : null);
}
/** The page is in use: its time away starts again from now. */
function stillHere(): void {
  if (ticket && Date.now() - ticketSavedAt > 30_000) setTicket(ticket);
}
/** The Mac run that gave the last ticket, to tell one that restarted and forgot its keys. */
let lastBoot: string | null = null;
/** Coming back with the ticket just now, so a refusal means unlocking as usual instead. */
let resuming = false;
let resumeRefused = false;
/** Set when the Mac said why it is letting go, which outranks the connection closing. */
let removed = false;
/**
 * Set when what came back sealed did not open with this device's key. The Mac answers an id it
 * does not know as it would any other, so this is how a pairing that expired before it was trusted,
 * or one removed while this page was away, looks from here. Asking again cannot help.
 */
let unknown = false;
/**
 * Keys typed and not yet answered by the Mac, numbered. A connection that drops takes whatever it
 * was carrying with it, so these are sent again on the next one, and the Mac writes each number
 * once. Kept to a little: typing, not a paste into a dead connection.
 */
let unanswered: { n: number; sessionId: string; data: string }[] = [];
let keyNumber = 0;
const UNANSWERED_MAX = 16 * 1024;
/** This page, to the Mac, for numbering its keys. New on every load. */
const pageId = toBase64Url(randomBytes(12));
/**
 * The code this device shows while the Mac asks the person there to approve it. Set from the
 * Mac's word until it lets this device in or turns it away, through any reconnect in between.
 */
let approvingCode: string | null = null;
/** Connections in a row that did not reach the Mac, so one hiccup is not announced as trouble. */
let failures = 0;
/** The Mac's key for notifications, and whether this device has them on. */
let vapid = '';
let notifyOn = false;
/** A terminal to open once unlocked, from a notification that was tapped. */
let openWhenReady: string | null = null;

/** How often an open connection is checked, and how long an answer may take. */
const PING_EVERY_MS = 15_000;
const PING_ANSWER_MS = 5_000;
/** How long a new connection may take to say hello before it is given up on. */
const HELLO_MS = 6_000;
/** What a frame that would not open is, as opposed to anything else going wrong. */
const NOT_OPENED = new Error('not-opened');

const isReady = (): boolean => conn?.ready === true;

/** Sealed and sent on the current connection. False when there is none to send on. */
function send(message: object): boolean {
  const c = conn;
  const sealer = c?.sealer;
  if (!c || !sealer) return false;
  c.outbox = c.outbox
    .then(async () => {
      if (c.socket.readyState === WebSocket.OPEN)
        c.socket.send(await sealer.seal(packMessage(message)));
    })
    .catch(() => undefined);
  return true;
}

/** Typed into the watched terminal, and kept until the Mac says it has it. */
function sendKeys(data: string): void {
  if (!typing || !watching) return;
  const held = unanswered.reduce((sum, k) => sum + k.data.length, 0);
  if (held + data.length > UNANSWERED_MAX) return;
  const key = { n: ++keyNumber, sessionId: watching, data };
  unanswered.push(key);
  // Only once the Mac shows this terminal on this connection, since it takes keys for that alone.
  if (isReady() && watchingStream !== -1) {
    predictor.key(data);
    sendKey(key);
  } else predictor.reset();
}

function sendKey(key: { n: number; sessionId: string; data: string }): void {
  send({ t: 'input', sessionId: key.sessionId, data: key.data, page: pageId, n: key.n });
}

function after(c: Conn, ms: number, run: () => void): void {
  c.timers.push(window.setTimeout(run, ms));
}

/** Let a connection go, quietly: nothing it does from now on reaches the page. */
function retire(c: Conn): void {
  for (const t of c.timers) clearTimeout(t);
  c.timers = [];
  c.socket.onopen = c.socket.onclose = c.socket.onmessage = c.socket.onerror = null;
  try {
    c.socket.close();
  } catch {
    // Already closed.
  }
}

/** Asked whether it still reaches the Mac: anything arriving in time says yes. */
function ping(paired: Paired, c: Conn): void {
  if (conn !== c || !c.ready) return;
  const asked = Date.now();
  send({ t: 'ping' });
  after(c, PING_ANSWER_MS, () => {
    if (conn === c && c.heard < asked) lose(paired, c, 1006);
  });
}

function connect(paired: Paired): void {
  clearTimeout(retryTimer);
  retryTimer = 0;
  if (conn) retire(conn);
  conn = null;
  if (removed) return;
  pendingChallenge = null;
  unknown = false;
  // What the page says while it keeps trying stays put, rather than flicking back each time.
  if (failures === 0 && !approvingCode) say('Connecting to your Mac', 'busy');
  $<HTMLButtonElement>('unlock').hidden = true;
  $<HTMLButtonElement>('repair').hidden = true;
  const c: Conn = {
    socket: new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/browser/${paired.room}`),
    sealer: null,
    inbox: Promise.resolve(),
    outbox: Promise.resolve(),
    opened: false,
    ready: false,
    heard: Date.now(),
    denied: null,
    waitSeconds: 0,
    timers: [],
  };
  conn = c;
  c.socket.binaryType = 'arraybuffer';
  const myNonce = randomBytes(NONCE_BYTES);
  c.socket.onopen = () => {
    c.socket.send(packHello({ device: paired.device, nonce: toBase64Url(myNonce) }));
  };
  c.socket.onclose = (e) => lose(paired, c, e.code);
  c.socket.onmessage = (event) => {
    if (conn !== c) return;
    c.heard = Date.now();
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    c.inbox = c.inbox
      .then(() => receive(paired, c, bytes, myNonce))
      .catch((e: unknown) => {
        if (conn !== c) return;
        if (e === NOT_OPENED) {
          // The first sealed frame not opening means the Mac used another key: it does not know
          // this device. A later one not opening is a broken connection, and is simply made again.
          if (!c.opened) unknown = true;
          lose(paired, c, 1006);
        }
      });
  };
  // A connection that never gets as far as hello, as on a network that swallows it, is given up.
  after(c, HELLO_MS, () => {
    if (conn === c && !c.sealer) lose(paired, c, 1006);
  });
}

/** The connection is gone, by closing or by not answering. */
function lose(paired: Paired, c: Conn, code: number): void {
  if (conn !== c) return;
  conn = null;
  retire(c);
  watchingStream = -1;
  predictor.reset();
  // With a ticket the page stays as it is while it comes back, rather than locking.
  if (ticket && !removed) {
    $('reconnecting').hidden = false;
  } else {
    show('lock');
  }
  $<HTMLButtonElement>('unlock').hidden = true;
  $('name-field').hidden = true;
  // The reason arrives sealed, so it may still be being opened: wait for it before saying anything.
  void c.inbox.then(() => closed(paired, code, c.denied, c.waitSeconds));
}

function again(paired: Paired, ms: number): void {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    if (!conn) connect(paired);
  }, ms);
}

/**
 * What the page says and does once a connection has ended. Never "trying and failing": either the
 * page is on its way back and says so with a turning ring, or it knows why it cannot get in and
 * says what to do, or this device is not paired and the page shows how to pair it.
 */
function closed(paired: Paired, code: number, denied: string | null, seconds: number): void {
  if (removed || conn) return;
  if (unknown || denied === 'not-approved') {
    /*
     * The Mac does not know this device: its code ran out or was spent, it was removed while this
     * page was away, or the person at the Mac said no. It cannot get in as it is, so it is not
     * paired, and the page says so and shows how to pair.
     */
    const refused = denied === 'not-approved' || approvingCode !== null;
    approvingCode = null;
    $('approve-code').hidden = true;
    unpair(
      refused
        ? 'Your Mac did not approve this device. To try again, scan a new code in TabTerm Settings on your Mac.'
        : 'This device is not paired with your Mac anymore. Scan the code in TabTerm Settings on your Mac, or paste its link.',
    );
    return;
  }
  if (approvingCode) {
    // Dropped while the person at the Mac decides: the decision stands, so it simply waits on.
    show('lock');
    again(paired, 2000);
    return;
  }
  if (denied === 'busy') {
    say('Your Mac is approving another device. This one is next.', 'busy');
    again(paired, 3000);
    return;
  }
  if (denied === 'wait') {
    setTicket(null);
    $('reconnecting').hidden = true;
    show('lock');
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    say(
      `Too many tries that did not unlock. Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`,
      'warn',
    );
    again(paired, Math.max(5, seconds) * 1000 + 500);
    return;
  }
  if (resumeRefused) {
    // The ticket was refused, by a Mac restarted or a ticket run out: unlocked as usual instead.
    resumeRefused = false;
    setTicket(null);
    $('reconnecting').hidden = true;
    show('lock');
    again(paired, 300);
    return;
  }
  if (ticket) {
    $('reconnecting').textContent =
      code === 4002 ? 'Your Mac is offline. Reconnecting' : 'Reconnecting';
    again(paired, retry);
    retry = code === 4002 ? 3000 : Math.min(5000, retry * 2);
    return;
  }
  $('reconnecting').hidden = true;
  show('lock');
  // Pairing again is offered only when the Mac turned this device's passkey down.
  $<HTMLButtonElement>('repair').hidden = denied !== 'refused';
  if (denied === 'too-slow' || denied === 'silent') {
    // Left on Unlock for a minute: a fresh connection brings a fresh Unlock, once anybody looks.
    say('Locked');
    if (!document.hidden) again(paired, 300);
    return;
  }
  if (denied === 'refused') {
    say('Not unlocked. Tap Unlock to try again.', 'warn');
    again(paired, 300);
    return;
  }
  failures++;
  if (code === 4002) {
    say(
      'Your Mac is offline or asleep, or remote access is turned off on it. This page connects by itself once it is back.',
    );
    again(paired, 3000);
    retry = 3000;
    return;
  }
  // A dropped connection, or one that never got through: on the way back, every few seconds, and
  // the relay is asked why, so the page says what is wrong rather than spin.
  if (!navigator.onLine)
    say('This device is offline. It connects by itself once it is back online.');
  else void diagnose(paired);
  again(paired, retry);
  retry = Math.min(5000, retry * 2);
}

/**
 * Why the last connection did not get through, from the relay itself: it cannot be reached, it
 * is failing, the Mac is not connected to it, or the Mac is and this device still is not let
 * through. A browser is never told why a connection failed, so this asks separately.
 */
async function diagnose(paired: Paired): Promise<void> {
  const tried = failures;
  let text: string;
  let tone: 'warn' | 'plain' | 'busy' = 'warn';
  try {
    const stop = new AbortController();
    const timer = window.setTimeout(() => stop.abort(), 5000);
    const r = await fetch(`/status/${paired.room}`, { cache: 'no-store', signal: stop.signal });
    clearTimeout(timer);
    if (!r.ok) {
      text = `Your relay is not working right now (error ${String(r.status)}), so this device cannot reach your Mac. Deploying the relay again may fix it.`;
    } else if (((await r.json()) as { mac?: unknown }).mac !== true) {
      text =
        'Your Mac is offline or asleep, or remote access is turned off on it. This page connects by itself once it is back.';
      tone = 'plain';
    } else if (tried < 2) {
      text = 'Connecting to your Mac';
      tone = 'busy';
    } else {
      text =
        'Your Mac is online, but the relay is not letting this device through to it. This page keeps at it, and it is worth checking Remote access in TabTerm Settings on your Mac.';
    }
  } catch {
    text = 'This device cannot reach your relay. Check its internet connection.';
  }
  // Got through meanwhile, or let go: nothing to say.
  if (conn?.sealer || removed || failures !== tried) return;
  say(text, tone);
}

/** Not paired anymore: forgotten here, and the page shows how to pair. */
function unpair(text: string): void {
  removed = true;
  setTicket(null);
  $('reconnecting').hidden = true;
  $<HTMLButtonElement>('unlock').hidden = true;
  $('name-field').hidden = true;
  show('lock');
  void forgetPairing().then(() => showPairing(text));
}

async function receive(
  paired: Paired,
  c: Conn,
  bytes: Uint8Array,
  myNonce: Uint8Array,
): Promise<void> {
  if (conn !== c) return;
  const hello = readHello(bytes);
  if (hello) {
    if (typeof hello['nonce'] !== 'string') throw NOT_OPENED;
    c.sealer = new Sealer(
      await connectionKeys(paired.key, myNonce, fromBase64Url(hello['nonce']), 'browser'),
    );
    failures = 0;
    return;
  }
  if (!c.sealer) return;
  let opened: Uint8Array;
  try {
    opened = await c.sealer.open(bytes);
  } catch {
    throw NOT_OPENED;
  }
  c.opened = true;
  if (conn !== c) return;
  const frame = unpack(opened);
  if (!frame) return;
  if (frame.kind === 'bytes') {
    if (frame.stream === watchingStream) term.write(frame.data, () => predictor.check());
    return;
  }
  const m = frame.message;
  switch (m['t']) {
    case 'challenge':
      if (approvingCode && m['mode'] === 'register') {
        // Back while the Mac still asks: nothing to do but wait for the answer.
        lose(paired, c, 1000);
        return;
      }
      if (approvingCode) {
        // Approved while this page was away. It now unlocks as any trusted device does.
        approvingCode = null;
        $('approve-code').hidden = true;
      }
      if (ticket && m['mode'] === 'unlock') {
        // Kept until the Mac answers: a connection lost before then comes back with it again.
        resuming = true;
        send({ t: 'resume', ticket });
        return;
      }
      $('reconnecting').hidden = true;
      show('lock');
      /*
       * Unlocking afresh rather than coming back: the Mac may have restarted, and would not know
       * which keys it already wrote. Keys not answered are let go rather than risk typing twice.
       */
      unanswered = [];
      pendingChallenge = m;
      say(m['mode'] === 'register' ? 'Make a passkey for this device' : 'Locked');
      $<HTMLButtonElement>('unlock').textContent =
        m['mode'] === 'register' ? 'Trust this device' : 'Unlock';
      /*
       * Named here, since a web page cannot learn a phone's own name, and every iPhone would
       * otherwise be "iPhone, Safari" in the Mac's list. It can be renamed in Settings later.
       */
      if (m['mode'] === 'register') {
        const input = $<HTMLInputElement>('name-input');
        if (!input.value) input.value = deviceName();
        $('name-field').hidden = false;
      }
      $<HTMLButtonElement>('unlock').hidden = false;
      return;
    case 'approve':
      /*
       * The passkey is made, and now the person at the Mac decides. Touch ID or the Mac's password
       * comes up there, naming this code, so they can tell this device from any other.
       */
      approvingCode = typeof m['code'] === 'string' ? m['code'] : '';
      say(
        'Approve this device on your Mac with Touch ID or its password. Your Mac shows this code:',
        'busy',
      );
      $('approve-code').textContent = approvingCode;
      $('approve-code').hidden = false;
      return;
    case 'ready':
      approvingCode = null;
      $('approve-code').hidden = true;
      retry = 1000;
      c.ready = true;
      resuming = false;
      pingLoop(paired, c);
      setTicket(typeof m['resume'] === 'string' ? m['resume'] : null);
      // A Mac that restarted does not know which keys it already wrote: they are let go.
      if (lastBoot !== null && m['boot'] !== lastBoot) unanswered = [];
      lastBoot = typeof m['boot'] === 'string' ? m['boot'] : null;
      $('reconnecting').hidden = true;
      typing = m['typing'] === true;
      vapid = typeof m['vapid'] === 'string' ? m['vapid'] : '';
      notifyOn = m['notify'] === true;
      drawNotify();
      void refreshNotify().catch(() => undefined);
      send({ t: 'visible', visible: document.visibilityState === 'visible' });
      $('device-name').textContent = typeof m['name'] === 'string' ? m['name'] : '';
      if (openWhenReady) {
        const target = openWhenReady;
        openWhenReady = null;
        const state: unknown = history.state;
        openPane(target, isTerminalEntry(state) && state.terminal === target);
      } else if (watching) send({ t: 'watch', sessionId: watching });
      else show('list');
      return;
    case 'got': {
      const n = Number(m['n']);
      unanswered = unanswered.filter((k) => k.n > n);
      return;
    }
    case 'notify':
      notifyOn = m['on'] === true;
      drawNotify();
      return;
    case 'tabs':
      tabs = Array.isArray(m['tabs']) ? (m['tabs'] as RemoteTab[]) : [];
      typing = m['typing'] === true;
      drawList();
      drawTerminalHeader();
      return;
    case 'screen':
      if (m['sessionId'] !== watching) return;
      watchingStream = Number(m['stream']);
      term.reset();
      predictor.reset();
      show('terminal');
      setSize(Number(m['cols']) || 80, Number(m['rows']) || 24);
      drawTerminalHeader();
      // Keys typed while the connection came back, or lost with the last one, now that it is.
      unanswered = unanswered.filter((k) => k.sessionId === watching);
      if (typing) for (const k of unanswered) sendKey(k);
      // A computer has no keyboard to bring up, so it is ready to type whatever opened it.
      if (typing && !touch) term.focus();
      return;
    case 'size':
      if (m['sessionId'] === watching) setSize(Number(m['cols']) || 80, Number(m['rows']) || 24);
      return;
    case 'ended':
      if (m['sessionId'] === watching) {
        const title = paneOf(watching)?.title;
        watching = null;
        term.blur();
        show('list');
        // Back would only lead to a terminal that is gone.
        if (isTerminalEntry(history.state)) history.replaceState(null, '', location.pathname);
        sayEnded(title ? `Terminal ended: ${title}` : 'The terminal ended.');
      }
      return;
    case 'denied':
      c.denied = typeof m['reason'] === 'string' ? m['reason'] : 'refused';
      c.waitSeconds = Number(m['seconds']) || 0;
      if (m['reason'] === 'removed') {
        removed = true;
        await forgetPairing();
        showPairing(
          'This device was removed on your Mac. Pair it again with a new code from TabTerm Settings.',
        );
      } else if (resuming) {
        resuming = false;
        resumeRefused = true;
      }
      return;
    default:
      return;
  }
}

/** Every so often while unlocked, so a connection that has quietly died is found. */
function pingLoop(paired: Paired, c: Conn): void {
  after(c, PING_EVERY_MS, () => {
    if (document.visibilityState === 'visible') stillHere();
    ping(paired, c);
    pingLoop(paired, c);
  });
}

/** What the person called this device, or what it is. */
function named(): string {
  return $<HTMLInputElement>('name-input').value.trim().slice(0, 60) || deviceName();
}

/** Run from the button, since a passkey may only be asked for in answer to a tap. */
async function unlock(): Promise<void> {
  const c = pendingChallenge;
  if (!c) return;
  pendingChallenge = null;
  // The connection this challenge came on. Face ID takes a while, and if the connection was made
  // again meanwhile, this answer is for a challenge the Mac no longer has.
  const on = conn;
  $<HTMLButtonElement>('unlock').hidden = true;
  $('name-field').hidden = true;
  const challenge = new Uint8Array(fromBase64Url(String(c['challenge'])));
  const rpId = String(c['rpId']);
  try {
    if (c['mode'] === 'register') {
      say('Waiting for Face ID, Touch ID or your passcode');
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { id: rpId, name: 'TabTerm' },
          user: {
            id: new Uint8Array(new TextEncoder().encode(String(c['userId']))),
            name: `TabTerm, ${named()}`,
            displayName: 'TabTerm',
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
          attestation: 'none',
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error('cancelled');
      if (conn !== on) return;
      const r = cred.response as AuthenticatorAttestationResponse;
      send({
        t: 'register',
        name: named(),
        clientDataJSON: toBase64Url(new Uint8Array(r.clientDataJSON)),
        attestationObject: toBase64Url(new Uint8Array(r.attestationObject)),
      });
    } else {
      say('Waiting for Face ID, Touch ID or your passcode');
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge,
          rpId,
          allowCredentials: [
            { type: 'public-key', id: new Uint8Array(fromBase64Url(String(c['credentialId']))) },
          ],
          userVerification: 'required',
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error('cancelled');
      if (conn !== on) return;
      const r = cred.response as AuthenticatorAssertionResponse;
      send({
        t: 'unlock',
        credentialId: toBase64Url(new Uint8Array(cred.rawId)),
        clientDataJSON: toBase64Url(new Uint8Array(r.clientDataJSON)),
        authenticatorData: toBase64Url(new Uint8Array(r.authenticatorData)),
        signature: toBase64Url(new Uint8Array(r.signature)),
      });
    }
    say('Checking with your Mac');
  } catch {
    if (conn !== on) return;
    say('Not unlocked. Tap to try again.', 'warn');
    // A fresh challenge, since this one has been used up.
    if (on) {
      const p = await loadPairing();
      if (p && conn === on) connect(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Notifications come from the Mac through the device's own push service, encrypted to this
 * device, and only say which terminal needs you. On an iPhone they need the page added to the Home
 * Screen, which is the only place iOS lets a web page have them.
 */
function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function flat(sub: PushSubscription): object {
  const json = sub.toJSON();
  return { endpoint: json.endpoint, p256dh: json.keys?.['p256dh'], auth: json.keys?.['auth'] };
}

/**
 * The Mac is told this device's subscription each time it connects, since a browser may replace
 * one on its own. And if the browser no longer has one, the Mac stops sending to the old address.
 */
async function refreshNotify(): Promise<void> {
  if (!notifyOn || !pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  send({ t: 'notify', subscription: sub ? flat(sub) : null });
}

let endedTimer = 0;
/** Said on the list for a few seconds, so leaving the terminal does not look like a hiccup. */
function sayEnded(text: string): void {
  const note = $('ended-note');
  note.textContent = text;
  note.hidden = false;
  clearTimeout(endedTimer);
  endedTimer = window.setTimeout(() => (note.hidden = true), 6000);
}

function drawNotify(): void {
  const button = $<HTMLButtonElement>('notify');
  const hint = $('notify-hint');
  // On a phone or tablet only: a computer has TabTerm on it already, or is beside the Mac.
  const supported = touch && pushSupported() && vapid !== '';
  button.hidden = !supported;
  button.textContent = notifyOn ? 'Notifications on' : 'Notify me';
  button.setAttribute('aria-pressed', String(notifyOn));
  const iphone = touch && /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  hint.hidden = supported || !iphone;
  hint.textContent =
    'To get a notification when an agent needs you, add this page to your Home Screen and open it from there.';
}

async function toggleNotify(): Promise<void> {
  const button = $<HTMLButtonElement>('notify');
  button.disabled = true;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (notifyOn) {
      await existing?.unsubscribe();
      send({ t: 'notify', subscription: null });
      return;
    }
    if ((await Notification.requestPermission()) !== 'granted') {
      $('notify-hint').hidden = false;
      $('notify-hint').textContent = 'Notifications are turned off for this page in your settings.';
      return;
    }
    // Always a fresh one: an old one may be for another Mac, or one the push service let go.
    await existing?.unsubscribe();
    const key = new Uint8Array(fromBase64Url(vapid));
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    send({ t: 'notify', subscription: flat(sub) });
  } catch {
    $('notify-hint').hidden = false;
    $('notify-hint').textContent = 'This browser would not turn on notifications.';
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function drawList(): void {
  const list = $('tabs');
  if (tabs.length === 0) {
    list.replaceChildren(el('p', 'empty', 'Nothing is running on your Mac right now.'));
    return;
  }
  list.replaceChildren(
    ...tabs.map((tab) => {
      const group = el('section', 'tab');
      group.append(el('h2', 'tab-title', tab.title));
      for (const pane of tab.panes) {
        const row = el('button', 'pane');
        row.type = 'button';
        const top = el('span', 'pane-top');
        top.append(el('span', 'pane-title', pane.title));
        if (pane.needsYou) top.append(el('span', 'badge needs', 'Needs you'));
        else if (pane.busy) top.append(el('span', 'badge busy', 'Running'));
        row.append(top, el('span', 'pane-cwd', pane.cwd.replace(/^\/Users\/[^/]+/, '~')));
        row.addEventListener('click', () => openPane(pane.sessionId));
        group.append(row);
      }
      return group;
    }),
  );
}

function paneOf(sessionId: string | null): RemoteTab['panes'][number] | undefined {
  for (const t of tabs) for (const p of t.panes) if (p.sessionId === sessionId) return p;
  return undefined;
}

function drawTerminalHeader(): void {
  const pane = paneOf(watching);
  $('term-title').textContent = pane?.title ?? '';
  $('keys').hidden = !typing;
  $('watch-only').hidden = typing;
}

/** A history entry for a terminal, so the browser's Back and Forward move in and out of it. */
function isTerminalEntry(state: unknown): state is { terminal: string } {
  return typeof (state as { terminal?: unknown } | null)?.terminal === 'string';
}

function openPane(sessionId: string, fromHistory = false): void {
  if (!fromHistory) {
    const entry = { terminal: sessionId };
    const url = `${location.pathname}#t=${sessionId}`;
    // Opening another terminal from one replaces it, so Back goes to the list, not through each.
    if (isTerminalEntry(history.state)) history.replaceState(entry, '', url);
    else history.pushState(entry, '', url);
  }
  watching = sessionId;
  watchingStream = -1;
  if (!termOpened) {
    term.open($('term'));
    termOpened = true;
    term.onData((data) => {
      if (FOCUS_REPORTS.has(data)) return;
      sendKeys(data);
    });
    // Drawn again whenever the terminal is, which covers scrolling and a new text size.
    term.onRender(() => drawGuesses());
  }
  $('ended-note').hidden = true;
  // Shown at once, empty until its screen arrives, since a hidden terminal cannot take the focus.
  term.reset();
  predictor.reset();
  show('terminal');
  drawTerminalHeader();
  // Ready to type at once. Done in the tap that opened it, which is when a phone allows the
  // keyboard to come up.
  if (typing) term.focus();
  send({ t: 'watch', sessionId });
}

/** Back on the list: the terminal's output stops coming. */
function toList(): void {
  watching = null;
  watchingStream = -1;
  unanswered = [];
  predictor.reset();
  term.blur();
  send({ t: 'unwatch' });
  show('list');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function wire(paired: Paired): void {
  $('unlock').addEventListener('click', () => void unlock());
  $('back').addEventListener('click', () => {
    // The browser's own Back when the terminal has its entry, so Forward can return to it.
    if (isTerminalEntry(history.state)) history.back();
    else toList();
  });
  window.addEventListener('popstate', (e) => {
    const state: unknown = e.state;
    if (isTerminalEntry(state)) {
      if (isReady()) openPane(state.terminal, true);
      else openWhenReady = state.terminal;
    } else if (watching) toList();
  });
  $('zoom-in').addEventListener('click', () => {
    zoom = Math.min(3, zoom * 1.25);
    fitFont();
  });
  $('zoom-out').addEventListener('click', () => {
    zoom = Math.max(0.5, zoom / 1.25);
    fitFont();
  });
  $('fit').addEventListener('click', () => {
    fitMode = fitMode === 'width' ? 'height' : 'width';
    zoom = 1;
    try {
      localStorage.setItem('tabterm.fitMode', fitMode);
    } catch {
      // Not remembered, which is fine.
    }
    refit();
  });
  $('notify').addEventListener('click', () => void toggleNotify());
  // A notification tapped while this page is open already.
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent<{ open?: unknown }>) => {
    if (typeof e.data.open === 'string' && e.data.open) openPane(e.data.open);
  });
  $('type').addEventListener('click', () => term.focus());
  const keys: Record<string, string> = {
    esc: '\x1b',
    tab: '\t',
    ctrlc: '\x03',
    up: '\x1b[A',
    down: '\x1b[B',
    left: '\x1b[D',
    right: '\x1b[C',
    enter: '\r',
  };
  for (const [name, seq] of Object.entries(keys)) {
    document.querySelector(`[data-key="${name}"]`)?.addEventListener('click', () => {
      sendKeys(seq);
    });
  }
  window.addEventListener('resize', refit);
  /*
   * Pressing a button keeps the typing where it was. A button would take the focus, which on a
   * phone puts the keyboard away. Kept from moving instead, it stays, so Esc, the arrows and A+
   * can be pressed between keys. On a computer, whatever is pressed, typing goes to the terminal.
   */
  for (const b of document.querySelectorAll<HTMLButtonElement>('#screen-terminal button')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    if (!touch && b.id !== 'back') b.addEventListener('click', () => term.focus());
  }
  /*
   * Locked again after a long while out of sight. A phone in a pocket keeps a page alive, and the
   * connection it holds is as good as an unlocked one, so past AWAY_MS it is closed and the next
   * look unlocks.
   */
  let hiddenAt = 0;
  /*
   * Back in sight, or back online: a connection is made at once if there is none, and one that
   * is open is asked whether it still works. A phone that put the page away may have had its
   * connection cut without a word, and that is found in seconds rather than by typing into it.
   */
  const look = (): void => {
    if (removed) return;
    if (!conn) connect(paired);
    else ping(paired, conn);
  };
  document.addEventListener('visibilitychange', () => {
    if (isReady()) send({ t: 'visible', visible: document.visibilityState === 'visible' });
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      if (ticket) setTicket(ticket);
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) {
      // Away long enough to count as put away: the ticket goes too, so it unlocks with the passkey.
      setTicket(null);
      unanswered = [];
      if (conn) retire(conn);
      conn = null;
      $('reconnecting').hidden = true;
      show('lock');
    }
    look();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) look();
  });
  window.addEventListener('pagehide', () => {
    if (ticket) setTicket(ticket);
  });
  window.addEventListener('online', look);
  connect(paired);
}

/**
 * Scan, beside the paste box: the camera in the page itself, so the code pairs this page and not
 * Safari. Codes that are not a pairing link are passed over while the camera keeps looking.
 */
function wireScan(accept: (text: string) => boolean, pair: (text: string) => void): void {
  const button = $<HTMLButtonElement>('scan');
  const view = $('scanner');
  const video = $<HTMLVideoElement>('scan-video');
  let scan: Scan | null = null;
  const close = (): void => {
    scan?.stop();
    scan = null;
    view.hidden = true;
  };
  button.hidden = !navigator.mediaDevices?.getUserMedia;
  button.addEventListener('click', () => {
    view.hidden = false;
    startScan(video, accept, (text) => {
      scan = null;
      view.hidden = true;
      pair(text);
    }).then(
      (s) => {
        if (view.hidden) s.stop();
        else scan = s;
      },
      () => {
        view.hidden = true;
        say('The camera is not available. Allow it for this page, or paste the link.', 'warn');
      },
    );
  });
  $('scan-cancel').addEventListener('click', close);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
  });
}

/** The paste box and Scan, for a page with no pairing, or one that has just let go of its own. */
let pairingShown = false;
function showPairing(text: string, tone: 'plain' | 'warn' = 'warn'): void {
  say(text, tone);
  $<HTMLButtonElement>('repair').hidden = true;
  if (pairingShown) return;
  pairingShown = true;
  const form = $<HTMLFormElement>('pair-form');
  form.hidden = false;
  const hashOf = (value: string): string =>
    value.includes('#') ? value.slice(value.indexOf('#')) : value;
  const pairWith = (value: string): void => {
    location.hash = hashOf(value);
    location.reload();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $<HTMLInputElement>('pair-input').value.trim();
    if (!readPairing(hashOf(value))) {
      say('That is not a pairing link. Copy it again from Settings on your Mac.', 'warn');
      return;
    }
    pairWith(value);
  });
  wireScan(
    (text) => readPairing(hashOf(text.trim())) !== null,
    (text) => pairWith(text.trim()),
  );
}

/**
 * Pair this device again, for when its pairing no longer gets in. Asked first, since a phone away
 * from the Mac cannot pair again until it is back.
 */
function wireRepair(): void {
  $('repair').addEventListener('click', () => {
    if (
      !confirm('Forget this pairing? You will need a new code from TabTerm Settings on your Mac.')
    )
      return;
    removed = true;
    if (conn) retire(conn);
    conn = null;
    void forgetPairing().then(() => location.reload());
  });
}

async function start(): Promise<void> {
  show('lock');
  wireRepair();
  // Opened from a notification: that terminal, once unlocked.
  const opening = /^#open=([\w-]{1,64})$/.exec(location.hash);
  if (opening) {
    openWhenReady = opening[1] ?? null;
    history.replaceState(null, '', location.pathname);
  }
  // Reloaded in a terminal: that terminal again, keeping its history entry.
  const inTerminal = /^#t=([\w-]{1,64})$/.exec(location.hash);
  if (inTerminal?.[1]) {
    openWhenReady = inTerminal[1];
    history.replaceState(null, '', location.pathname);
  }
  const fragment = readPairing(location.hash);
  if (fragment) {
    // Kept as a key nothing can read back, and taken out of the address bar and history at once.
    await savePairing({
      room: fragment.room,
      device: fragment.device,
      key: await importDeviceKey(fromBase64Url(fragment.key)),
    });
    history.replaceState(null, '', location.pathname);
  }
  const paired = await loadPairing();
  if (!paired) {
    /*
     * Scanning with the camera app, or pasting, is how a page here gets paired. On an iPhone the
     * camera app opens the link in Safari, and an app added to the Home Screen keeps its own storage
     * apart from Safari's, so that app pairs with Scan below, or with Copy link on the Mac pasted
     * here, which Universal Clipboard carries across.
     */
    showPairing(
      'Not paired yet. Scan the code in TabTerm Settings on your Mac, or paste its link.',
      'plain',
    );
    return;
  }
  // Unlocked recently: comes back with the ticket instead of asking for Face ID again.
  const resume = await loadResume().catch(() => null);
  if (resume && Date.now() - resume.seen < AWAY_MS) {
    ticket = resume.ticket;
    ticketSavedAt = resume.seen;
  } else if (resume) saveResume(null);
  wire(paired);
}

void start();
(window as unknown as { __remote: object }).__remote = {
  term,
  state: () => ({
    watching,
    tabs,
    typing,
    ready: isReady(),
    screen: document.body.dataset['screen'],
  }),
  /** The connection lost, as a network would lose it, for the tests. */
  drop: () => conn?.socket.close(),
  /** The connection silently dead, as a phone's can be after being put away, for the tests. */
  silence: () => {
    if (conn) conn.socket.onmessage = null;
  },
};
