/**
 * Remote access: what a paired browser and the daemon say to each other through the relay.
 *
 * The relay passes bytes it cannot read. Each paired device holds a 32 byte key that only it and
 * the daemon know, made on the Mac and handed over inside a link's `#fragment`, which a browser
 * never sends to any server. Every connection derives two fresh keys from it and from a random
 * nonce from each side, one key per direction, so a recorded connection cannot be replayed into a
 * new one. Every frame carries a counter that only goes up, so a frame cannot be replayed within
 * one either. WebCrypto only, so the daemon and the page run this same file.
 *
 * See docs/17-remote-access.md.
 */

// ---------------------------------------------------------------------------
// Relay envelope
// ---------------------------------------------------------------------------

/**
 * Between the relay and the daemon every frame starts with 4 bytes naming the browser connection
 * it is from or for. Id 0 from the daemon means every connection.
 */
export const RELAY_ID_BYTES = 4;
/** A connection opening is announced with an empty body, and its closing with this one byte. */
export const RELAY_GONE = 0xff;
/** The relay refuses anything larger, and so does everything behind it. */
export const REMOTE_MAX_FRAME = 1 << 20;

export function envelope(id: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(RELAY_ID_BYTES + body.length);
  new DataView(out.buffer).setUint32(0, id);
  out.set(body, RELAY_ID_BYTES);
  return out;
}

export function openEnvelope(bytes: Uint8Array): { id: number; body: Uint8Array } | null {
  if (bytes.length < RELAY_ID_BYTES) return null;
  const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return { id, body: bytes.subarray(RELAY_ID_BYTES) };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A copy backed by a plain ArrayBuffer, which is the only kind WebCrypto takes. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ---------------------------------------------------------------------------
// The handshake, in the clear
// ---------------------------------------------------------------------------

const HELLO = 0x01;
const SEALED = 0x02;

/** The browser's first frame: which device it claims to be, and its nonce. */
export interface BrowserHello {
  device: string;
  nonce: string;
}

/** The daemon's answer: its nonce. Everything after this is sealed. */
export interface DaemonHello {
  nonce: string;
}

export function packHello(hello: BrowserHello | DaemonHello): Uint8Array {
  const json = encoder.encode(JSON.stringify(hello));
  const out = new Uint8Array(1 + json.length);
  out[0] = HELLO;
  out.set(json, 1);
  return out;
}

export function readHello(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes[0] !== HELLO || bytes.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes.subarray(1)));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

export const DEVICE_KEY_BYTES = 32;
export const NONCE_BYTES = 16;

/**
 * The device key as WebCrypto holds it: usable for deriving and never readable again.
 *
 * A browser keeps this object rather than the bytes, so a script on the page later could use the
 * key while the page is open and could still never copy it anywhere.
 */
export function importDeviceKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', owned(bytes), 'HKDF', false, ['deriveKey']);
}

/** Two keys, one each way, fresh for every connection. */
export async function connectionKeys(
  deviceKey: Uint8Array | CryptoKey,
  browserNonce: Uint8Array,
  daemonNonce: Uint8Array,
  side: 'daemon' | 'browser',
): Promise<{ send: CryptoKey; receive: CryptoKey }> {
  const base = deviceKey instanceof Uint8Array ? await importDeviceKey(deviceKey) : deviceKey;
  const salt = new Uint8Array([...browserNonce, ...daemonNonce]);
  const derive = (info: string): Promise<CryptoKey> =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const toBrowser = await derive('tabterm remote daemon to browser');
  const toDaemon = await derive('tabterm remote browser to daemon');
  return side === 'daemon'
    ? { send: toBrowser, receive: toDaemon }
    : { send: toDaemon, receive: toBrowser };
}

/**
 * One direction's counter, and the other's high-water mark.
 *
 * Calls must be made in order on each side, since the counter is part of what is sealed and a
 * frame opened out of order is refused as a replay.
 */
export class Sealer {
  #sent = 0n;
  #seen = -1n;
  readonly #keys: { send: CryptoKey; receive: CryptoKey };

  constructor(keys: { send: CryptoKey; receive: CryptoKey }) {
    this.#keys = keys;
  }

  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.#sent++);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.#keys.send, owned(plain)),
    );
    const out = new Uint8Array(1 + 8 + sealed.length);
    out[0] = SEALED;
    out.set(iv.subarray(4), 1);
    out.set(sealed, 9);
    return out;
  }

  /** Throws for anything that is not a sealed frame from the other side, in order. */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame[0] !== SEALED || frame.length < 9 + 16) throw new Error('not-sealed');
    const iv = new Uint8Array(12);
    iv.set(frame.subarray(1, 9), 4);
    const n = new DataView(iv.buffer).getBigUint64(4);
    if (n <= this.#seen) throw new Error('replayed');
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.#keys.receive,
        owned(frame.subarray(9)),
      ),
    );
    this.#seen = n;
    return plain;
  }
}

// ---------------------------------------------------------------------------
// Inside a sealed frame
// ---------------------------------------------------------------------------

const JSON_KIND = 0;
const BYTES_KIND = 1;

/** A message, or a terminal's bytes for the stream numbered `stream`. */
export type RemoteFrame =
  | { kind: 'message'; message: Record<string, unknown> }
  | { kind: 'bytes'; stream: number; data: Uint8Array };

export function packMessage(message: object): Uint8Array {
  const json = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(1 + json.length);
  out[0] = JSON_KIND;
  out.set(json, 1);
  return out;
}

export function packBytes(stream: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = BYTES_KIND;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(data, 5);
  return out;
}

export function unpack(plain: Uint8Array): RemoteFrame | null {
  if (plain[0] === JSON_KIND) {
    try {
      const value: unknown = JSON.parse(decoder.decode(plain.subarray(1)));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      return { kind: 'message', message: value as Record<string, unknown> };
    } catch {
      return null;
    }
  }
  if (plain[0] === BYTES_KIND && plain.length >= 5) {
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    return { kind: 'bytes', stream: view.getUint32(1), data: plain.subarray(5) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the browser is shown
// ---------------------------------------------------------------------------

/** One terminal, as the browser lists it. */
export interface RemotePane {
  sessionId: string;
  /** Small and stable for the life of the connection, used to tag its bytes. */
  stream: number;
  title: string;
  cwd: string;
  busy: boolean;
  /** An agent asking for something, which is what somebody away from the desk most wants to see. */
  needsYou: boolean;
  process?: string;
}

/** A tab, or the sessions running without one. */
export interface RemoteTab {
  id: string;
  title: string;
  panes: RemotePane[];
}

/**
 * The link a device is paired with.
 *
 * Everything after `#` stays on the device: the relay serves the page and never sees the key.
 */
export function pairingLink(
  relayUrl: string,
  pair: { room: string; device: string; key: string },
): string {
  const base = relayUrl.replace(/\/+$/, '');
  return `${base}/#pair=${pair.room}.${pair.device}.${pair.key}`;
}

export function readPairing(
  fragment: string,
): { room: string; device: string; key: string } | null {
  const m =
    /(?:^#?|&)pair=([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{40,64})/.exec(
      fragment,
    );
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { room: m[1], device: m[2], key: m[3] };
}
