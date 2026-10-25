import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { Expected } from './webauthn.js';

/**
 * A software authenticator, built the way a phone builds what it sends, so the checks run against
 * real signatures rather than against fixtures that only ever agree with themselves.
 */

type Enc = number | string | Uint8Array | Enc[] | Map<Enc, Enc>;

function cbor(value: Enc): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 0xff];
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  if (typeof value === 'number') {
    return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
  }
  if (typeof value === 'string') {
    const b = new TextEncoder().encode(value);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (value instanceof Uint8Array) return new Uint8Array([...head(2, value.length), ...value]);
  if (Array.isArray(value)) {
    return new Uint8Array([...head(4, value.length), ...value.flatMap((v) => [...cbor(v)])]);
  }
  const parts: number[] = [...head(5, value.size)];
  for (const [k, v] of value) parts.push(...cbor(k), ...cbor(v));
  return new Uint8Array(parts);
}

const sha256 = (d: Uint8Array | string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(d).digest());
export const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

export const expected = (challenge = new Uint8Array(32).fill(7)): Expected => ({
  challenge,
  origin: 'https://tabterm-relay.example.workers.dev',
  rpId: 'tabterm-relay.example.workers.dev',
});

export function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = new Uint8Array(16).fill(3);
  const cose = new Map<Enc, Enc>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y ?? '', 'base64url'))],
  ]);
  let counter = 0;
  const authData = (rpId: string, flags: number, attested: boolean): Uint8Array => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    const parts = [...sha256(rpId), flags, ...count];
    if (attested) {
      parts.push(...new Uint8Array(16), 0, credentialId.length, ...credentialId, ...cbor(cose));
    }
    return new Uint8Array(parts);
  };
  const clientData = (type: string, e: Expected, overrides: object = {}): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({ type, challenge: b64url(e.challenge), origin: e.origin, ...overrides }),
    );
  return {
    register(e: Expected, flags = 0x45, rpId = e.rpId) {
      return {
        clientDataJSON: clientData('webauthn.create', e),
        attestationObject: cbor(
          new Map<Enc, Enc>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData(rpId, flags, true)],
          ]),
        ),
      };
    },
    assert(e: Expected, opts: { flags?: number; counter?: number; clientData?: object } = {}) {
      counter = opts.counter ?? counter;
      const authenticatorData = authData(e.rpId, opts.flags ?? 0x05, false);
      const clientDataJSON = clientData('webauthn.get', e, opts.clientData);
      const signature = new Uint8Array(
        sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey),
      );
      return { credentialId: b64url(credentialId), clientDataJSON, authenticatorData, signature };
    },
  };
}
