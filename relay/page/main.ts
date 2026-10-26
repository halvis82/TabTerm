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
  return `${what}, ${browser}`;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

type Screen = 'lock' | 'list' | 'terminal';

function show(screen: Screen): void {
  for (const s of ['lock', 'list', 'terminal'] as const) $(`screen-${s}`).hidden = s !== screen;
  document.body.dataset['screen'] = screen;
}

function say(text: string, tone: 'plain' | 'warn' = 'plain'): void {
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
/** Focus in and out, which a program that asked for them would read as the Mac's view moving. */
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O']);

let termOpened = false;
let size = { cols: 80, rows: 24 };
let zoom = 1;
/** Fit the whole terminal on the screen however small that makes the text, rather than scroll. */
let fitAll = false;
try {
  fitAll = localStorage.getItem('tabterm.fitAll') === '1';
} catch {
  // Storage refused: start readable.
}

/** A phone or tablet, as opposed to a computer with a mouse. */
const touch = matchMedia('(pointer: coarse)').matches;

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
 * The Mac's size, as large as fits the screen: the whole width or the whole height, whichever
 * runs out first, so a terminal fills the view in one direction and is never a small block in a
 * corner.
 *
 * The terminal keeps the Mac's columns and rows, since the program in it drew for those, and a
 * phone watching never changes the size on the Mac. A terminal 120 columns wide fitted across a
 * phone is text under 5 pixels, so on a phone the text never goes below a readable size and a wider
 * terminal scrolls sideways instead, unless Fit is on. A- and A+ scale from the fitted size.
 */
const READABLE_PX = 8.5;
const LARGEST_PX = 32;
function fitFont(): void {
  const wrap = $('term-wrap');
  const across = (wrap.clientWidth - 8) / (size.cols * cell.w);
  const down = (wrap.clientHeight - 8) / (size.rows * cell.h);
  const whole = Math.min(across, down);
  const px = fitAll
    ? Math.max(3, Math.min(LARGEST_PX, whole))
    : Math.max(5, Math.min(LARGEST_PX, Math.max(touch ? READABLE_PX : 5, whole) * zoom));
  const rounded = Math.floor(px * 4) / 4;
  if (term.options.fontSize !== rounded) term.options.fontSize = rounded;
  $('fit').setAttribute('aria-pressed', String(fitAll));
  $<HTMLButtonElement>('zoom-in').disabled = fitAll;
  $<HTMLButtonElement>('zoom-out').disabled = fitAll;
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
    if (!fitAll && zoom !== 1) return;
    const screen = $('term').querySelector<HTMLElement>('.xterm-screen');
    const wrap = $('term-wrap');
    const over = (): boolean =>
      !!screen &&
      screen.offsetWidth > wrap.clientWidth - 8 &&
      screen.offsetHeight > wrap.clientHeight - 8;
    const overOne = (): boolean =>
      !!screen &&
      (screen.offsetWidth > wrap.clientWidth - 8 || screen.offsetHeight > wrap.clientHeight - 8);
    // On a phone a wide terminal scrolls sideways on purpose, so only both ways at once is too big.
    const tooBig = touch && !fitAll ? over : overOne;
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

let ws: WebSocket | null = null;
let sealer: Sealer | null = null;
let chain: Promise<void> = Promise.resolve();
let tabs: RemoteTab[] = [];
let watching: string | null = null;
let watchingStream = 0;
let typing = false;
let pendingChallenge: Record<string, unknown> | null = null;
let retry = 1000;
/** Set when the Mac said why it is letting go, which outranks the connection closing. */
let removed = false;
/**
 * Set when what came back sealed did not open with this device's key. The Mac answers an id it
 * does not know as it would any other, so this is how a pairing that expired before it was trusted,
 * or one removed while this page was away, looks from here. Asking again cannot help.
 */
let unknown = false;
/** The Mac's key for notifications, and whether this device has them on. */
let vapid = '';
let notifyOn = false;
/** A terminal to open once unlocked, from a notification that was tapped. */
let openWhenReady: string | null = null;

const send = (message: object): void => {
  const s = sealer;
  const socket = ws;
  if (!s || !socket) return;
  chain = chain.then(async () => {
    if (socket.readyState === WebSocket.OPEN) socket.send(await s.seal(packMessage(message)));
  });
};

function connect(paired: Paired): void {
  sealer = null;
  pendingChallenge = null;
  chain = Promise.resolve();
  say('Connecting to your Mac');
  $<HTMLButtonElement>('unlock').hidden = true;
  $<HTMLButtonElement>('repair').hidden = true;
  const socket = new WebSocket(
    `${location.origin.replace(/^http/, 'ws')}/ws/browser/${paired.room}`,
  );
  ws = socket;
  socket.binaryType = 'arraybuffer';
  const myNonce = randomBytes(NONCE_BYTES);
  socket.onopen = () => {
    socket.send(packHello({ device: paired.device, nonce: toBase64Url(myNonce) }));
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    ws = null;
    sealer = null;
    show('lock');
    $<HTMLButtonElement>('unlock').hidden = true;
    // The reason arrives sealed, so it may still be being opened: wait for it before saying anything.
    void chain.then(() => closed(paired, e.code));
  };
  socket.onmessage = (event) => {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    chain = chain
      .then(() => receive(paired, bytes, myNonce))
      .catch(() => {
        unknown = true;
        socket.close();
      });
  };
}

function closed(paired: Paired, code: number): void {
  if (removed) return;
  // Pairing again is always within reach, except while the Mac is simply offline.
  $<HTMLButtonElement>('repair').hidden = code === 4002 && !unknown;
  if (unknown) {
    say(
      'Your Mac does not know this device. Its code may have run out before it was trusted, or it was removed. Pair it again with a new code from TabTerm Settings on your Mac.',
      'warn',
    );
    return;
  }
  say(
    code === 4002
      ? 'Your Mac is offline, or remote access is turned off on it. Trying again.'
      : code === 4001
        ? 'Your Mac closed this connection.'
        : 'Disconnected. Trying again.',
    'warn',
  );
  if (code === 4001) return;
  setTimeout(() => connect(paired), retry);
  // An offline Mac is asked again every few seconds, so the page is back the moment it is.
  retry = code === 4002 ? 3000 : Math.min(30_000, retry * 2);
}

async function receive(paired: Paired, bytes: Uint8Array, myNonce: Uint8Array): Promise<void> {
  const hello = readHello(bytes);
  if (hello) {
    if (typeof hello['nonce'] !== 'string') throw new Error('hello');
    sealer = new Sealer(
      await connectionKeys(paired.key, myNonce, fromBase64Url(hello['nonce']), 'browser'),
    );
    return;
  }
  if (!sealer) return;
  const frame = unpack(await sealer.open(bytes));
  if (!frame) return;
  if (frame.kind === 'bytes') {
    if (frame.stream === watchingStream) term.write(frame.data);
    return;
  }
  const m = frame.message;
  switch (m['t']) {
    case 'challenge':
      pendingChallenge = m;
      say(m['mode'] === 'register' ? 'Make a passkey for this device' : 'Locked');
      $<HTMLButtonElement>('unlock').textContent =
        m['mode'] === 'register' ? 'Trust this device' : 'Unlock';
      $<HTMLButtonElement>('unlock').hidden = false;
      return;
    case 'ready':
      retry = 1000;
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
        openPane(target);
      } else if (watching) send({ t: 'watch', sessionId: watching });
      else show('list');
      return;
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
      show('terminal');
      setSize(Number(m['cols']) || 80, Number(m['rows']) || 24);
      drawTerminalHeader();
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
        sayEnded(title ? `Terminal ended: ${title}` : 'The terminal ended.');
      }
      return;
    case 'denied':
      if (m['reason'] === 'removed') {
        removed = true;
        await forgetPairing();
        showPairing(
          'This device was removed on your Mac. Pair it again with a new code from TabTerm Settings.',
        );
      } else {
        say('Your Mac said no. Try unlocking again.', 'warn');
      }
      return;
    default:
      return;
  }
}

/** Run from the button, since a passkey may only be asked for in answer to a tap. */
async function unlock(): Promise<void> {
  const c = pendingChallenge;
  if (!c) return;
  pendingChallenge = null;
  $<HTMLButtonElement>('unlock').hidden = true;
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
            name: `TabTerm, ${deviceName()}`,
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
      const r = cred.response as AuthenticatorAttestationResponse;
      send({
        t: 'register',
        name: deviceName(),
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
    say('Not unlocked. Tap to try again.', 'warn');
    // A fresh connection brings a fresh challenge, since this one has been used up.
    ws?.close();
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

function openPane(sessionId: string): void {
  watching = sessionId;
  watchingStream = 0;
  if (!termOpened) {
    term.open($('term'));
    termOpened = true;
    term.onData((data) => {
      if (FOCUS_REPORTS.has(data)) return;
      if (typing && watching) send({ t: 'input', sessionId: watching, data });
    });
  }
  $('ended-note').hidden = true;
  // Shown at once, empty until its screen arrives, since a hidden terminal cannot take the focus.
  term.reset();
  show('terminal');
  drawTerminalHeader();
  // Ready to type at once. Done in the tap that opened it, which is when a phone allows the
  // keyboard to come up.
  if (typing) term.focus();
  send({ t: 'watch', sessionId });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function wire(paired: Paired): void {
  $('unlock').addEventListener('click', () => void unlock());
  $('back').addEventListener('click', () => {
    watching = null;
    show('list');
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
    fitAll = !fitAll;
    try {
      localStorage.setItem('tabterm.fitAll', fitAll ? '1' : '0');
    } catch {
      // Not remembered, which is fine.
    }
    fitFont();
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
      if (typing && watching) send({ t: 'input', sessionId: watching, data: seq });
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
   * Locked again after a while out of sight. A phone in a pocket keeps a page alive, and the
   * connection it holds is as good as an unlocked one, so it is closed and the next look unlocks.
   */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    send({ t: 'visible', visible: document.visibilityState === 'visible' });
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > 2 * 60_000) ws?.close();
    if (!ws) connect(paired);
  });
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
    ws?.close();
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
  wire(paired);
}

void start();
(window as unknown as { __remote: object }).__remote = {
  term,
  state: () => ({ watching, tabs, typing, screen: document.body.dataset['screen'] }),
};
