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
  db.transaction('pairing', 'readwrite').objectStore('pairing').delete('this');
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

/**
 * The Mac's size, with a font that fits it across the screen when that is still readable.
 *
 * A terminal 120 columns wide fitted across a phone is text under 5 pixels, which nobody can read.
 * So the font never goes below a readable size, and a wider terminal scrolls sideways instead.
 * The buttons scale from there.
 */
const READABLE_PX = 8.5;
function fitFont(): void {
  const width = $('term-wrap').clientWidth - 8;
  // A monospace cell is close to 0.6 of the font size wide.
  const fit = Math.max(READABLE_PX, Math.min(15, width / (size.cols * 0.6)));
  term.options.fontSize = Math.max(5, Math.min(24, fit * zoom));
}

function setSize(cols: number, rows: number): void {
  size = { cols, rows };
  term.resize(cols, rows);
  fitFont();
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
        say('Something from the relay did not open. Is this device still trusted?', 'warn');
        socket.close();
      });
  };
}

function closed(paired: Paired, code: number): void {
  if (removed) return;
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
  retry = Math.min(30_000, retry * 2);
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
      $('device-name').textContent = typeof m['name'] === 'string' ? m['name'] : '';
      if (watching) send({ t: 'watch', sessionId: watching });
      else show('list');
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
      setSize(Number(m['cols']) || 80, Number(m['rows']) || 24);
      show('terminal');
      drawTerminalHeader();
      return;
    case 'size':
      if (m['sessionId'] === watching) setSize(Number(m['cols']) || 80, Number(m['rows']) || 24);
      return;
    case 'ended':
      if (m['sessionId'] === watching) {
        watching = null;
        show('list');
      }
      return;
    case 'denied':
      if (m['reason'] === 'removed') {
        removed = true;
        await forgetPairing();
        say('This device was removed on your Mac. Pair it again from TabTerm Settings.', 'warn');
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
  window.addEventListener('resize', fitFont);
  /*
   * Locked again after a while out of sight. A phone in a pocket keeps a page alive, and the
   * connection it holds is as good as an unlocked one, so it is closed and the next look unlocks.
   */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > 2 * 60_000) ws?.close();
    if (!ws) connect(paired);
  });
  connect(paired);
}

async function start(): Promise<void> {
  show('lock');
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
     * Pasting is the other way in, and on an iPhone the necessary one: an app added to the Home
     * Screen keeps its own storage, apart from Safari's, so a code scanned into Safari does not
     * pair it. Copy link on the Mac and paste here, which Universal Clipboard carries across.
     */
    say('Not paired yet. Scan the code in TabTerm on your Mac, or paste its link here.');
    const form = $<HTMLFormElement>('pair-form');
    form.hidden = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = $<HTMLInputElement>('pair-input').value.trim();
      const hash = value.includes('#') ? value.slice(value.indexOf('#')) : value;
      if (!readPairing(hash)) {
        say('That is not a pairing link. Copy it again from Settings on your Mac.', 'warn');
        return;
      }
      location.hash = hash;
      location.reload();
    });
    return;
  }
  wire(paired);
}

void start();
(window as unknown as { __remote: object }).__remote = {
  term,
  state: () => ({ watching, tabs, typing, screen: document.body.dataset['screen'] }),
};
