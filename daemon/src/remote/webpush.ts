import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey,
} from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { info } from '../log.js';

/**
 * Notifications on a phone, sent from the Mac straight to the phone's push service.
 *
 * The relay is not involved and never sees one. The browser on the device gives its push service's
 * address and two keys, and every notification is encrypted to those keys (RFC 8291), so Apple,
 * Google or Mozilla carry it without being able to read it. The Mac proves it is the sender the
 * device subscribed to with a signed token (VAPID, RFC 8292), whose key the device was given when
 * it subscribed.
 *
 * Built on node:crypto alone. Each send is one HTTPS request, made only when an agent starts
 * needing somebody, so it costs nothing while nothing happens.
 */

export interface PushSubscription {
  endpoint: string;
  /** The device's P-256 public key, uncompressed, base64url. */
  p256dh: string;
  /** The device's 16 byte auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. What the device subscribes with. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

/**
 * Where a push may go. A device names the address, so this is the list of push services that
 * exist, and nothing else: a device cannot make the Mac send requests anywhere it likes.
 */
const PUSH_HOSTS = [
  'push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '') return false;
  return PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url');

export function makeVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), unb64(jwk.x ?? ''), unb64(jwk.y ?? '')]);
  return { publicKey: b64(point), privateJwk: privateKey.export({ format: 'jwk' }) };
}

const hmac = (key: Uint8Array, data: Uint8Array): Buffer =>
  createHmac('sha256', key).update(data).digest();

/**
 * One notification's body, encrypted for one device (RFC 8291, aes128gcm, one record).
 * `salt` and `senderPrivate` are for tests against the RFC's own example, and random otherwise.
 */
export function encryptPush(
  sub: Pick<PushSubscription, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  fixed?: { salt: Uint8Array; senderPrivate: Uint8Array },
): Buffer {
  const uaPublic = unb64(sub.p256dh);
  const authSecret = unb64(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) {
    throw new Error('bad-subscription-keys');
  }
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last record, and the only one.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** The signed token that says this Mac is who the device subscribed to (RFC 8292). */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now(),
): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const key = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

export type PushResult = 'sent' | 'gone' | 'failed';

export type Fetch = (url: string, init: RequestInit) => Promise<{ status: number }>;

/**
 * One POST with node:https. Not the global fetch, whose HTTP client is loaded the first time it is
 * used and stays: measured, it added about 30 MB to the daemon for a request a few times a day.
 */
const post: Fetch = (url, init) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'POST', headers: init.headers as Record<string, string>, timeout: 10_000 },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(init.body as Uint8Array);
  });

/**
 * Sends one. 'gone' means the device unsubscribed or the subscription expired, and it should be
 * forgotten. Nothing here retries: a notification late is worse than none.
 */
export async function sendPush(
  sub: PushSubscription,
  payload: object,
  keys: VapidKeys,
  subject: string,
  fetcher: Fetch = post,
): Promise<PushResult> {
  if (!pushEndpointAllowed(sub.endpoint)) return 'gone';
  try {
    const body = encryptPush(sub, Buffer.from(JSON.stringify(payload)));
    const res = await fetcher(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(sub.endpoint, keys, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        ttl: '3600',
        urgency: 'high',
      },
      body: new Uint8Array(body),
    });
    info('remote.push.answer', { host: new URL(sub.endpoint).hostname, status: res.status });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.status >= 200 && res.status < 300 ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
