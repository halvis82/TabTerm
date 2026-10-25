import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Checking a passkey, so a trusted device has to be unlocked by its owner every time it connects.
 *
 * A paired device holds a key, and a key on a phone somebody else picks up is still a key. So
 * pairing also makes a passkey on the device, which the device will only use after Face ID, Touch
 * ID or its passcode, and every connection asks it to sign a fresh challenge. The daemon keeps the
 * public half and checks the signature here. There is no account and no server holding anything:
 * the list of trusted devices is a file on this Mac.
 *
 * Only what this needs of WebAuthn: no attestation chains (the device was already vouched for by
 * the person scanning the code on their own Mac), ES256 and RS256 keys, and user verification
 * required, since the point is that a person unlocked it.
 */

// ---------------------------------------------------------------------------
// CBOR, the small part of it WebAuthn uses
// ---------------------------------------------------------------------------

type Cbor = number | bigint | string | Uint8Array | boolean | null | undefined | Cbor[] | CborMap;
type CborMap = Map<Cbor, Cbor>;

/** Decodes one item and says where it ended. Throws on anything malformed or exotic. */
export function decodeCbor(bytes: Uint8Array, start = 0): { value: Cbor; end: number } {
  let at = start;
  const need = (n: number): void => {
    if (at + n > bytes.length) throw new Error('cbor-truncated');
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return (need(1), bytes[at++] ?? 0);
    if (info === 25) {
      need(2);
      const v = view.getUint16(at);
      at += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(at);
      at += 4;
      return v;
    }
    throw new Error('cbor-length-unsupported');
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new Error('cbor-too-deep');
    need(1);
    const head = bytes[at++] ?? 0;
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        need(n);
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        const n = length(info);
        need(n);
        const out = new TextDecoder().decode(bytes.subarray(at, at + n));
        at += n;
        return out;
      }
      case 4: {
        const n = length(info);
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = length(info);
        const out: CborMap = new Map();
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1);
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('cbor-simple-unsupported');
      default:
        throw new Error('cbor-major-unsupported');
    }
  };
  const value = item(0);
  return { value, end: at };
}

// ---------------------------------------------------------------------------
// Authenticator data
// ---------------------------------------------------------------------------

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: CborMap;
}

function readAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new Error('authdata-short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: AuthData = {
    rpIdHash: bytes.slice(0, 32),
    flags: bytes[32] ?? 0,
    signCount: view.getUint32(33),
  };
  if ((out.flags & FLAG_ATTESTED) !== 0) {
    if (bytes.length < 55) throw new Error('authdata-short');
    const idLength = view.getUint16(53);
    if (bytes.length < 55 + idLength) throw new Error('authdata-short');
    out.credentialId = bytes.slice(55, 55 + idLength);
    const key = decodeCbor(bytes, 55 + idLength).value;
    if (!(key instanceof Map)) throw new Error('authdata-key');
    out.publicKey = key;
  }
  return out;
}

const sha256 = (data: Uint8Array | string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** A COSE key as a JWK node can import. ES256 (-7) and RS256 (-257) only. */
export function coseToJwk(cose: CborMap): { jwk: JsonWebKey; alg: -7 | -257 } {
  const alg = cose.get(3);
  if (cose.get(1) === 2 && alg === -7 && cose.get(-1) === 1) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error('cose-ec');
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, alg: -7 };
  }
  if (cose.get(1) === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error('cose-rsa');
    return { jwk: { kty: 'RSA', n: b64url(n), e: b64url(e) }, alg: -257 };
  }
  throw new Error('cose-unsupported');
}

// ---------------------------------------------------------------------------
// Client data
// ---------------------------------------------------------------------------

function checkClientData(
  clientDataJSON: Uint8Array,
  type: 'webauthn.create' | 'webauthn.get',
  challenge: Uint8Array,
  origin: string,
): void {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(clientDataJSON)) as typeof data;
  } catch {
    throw new Error('clientdata-json');
  }
  if (data.type !== type) throw new Error('clientdata-type');
  if (data.challenge !== b64url(challenge)) throw new Error('clientdata-challenge');
  if (data.origin !== origin) throw new Error('clientdata-origin');
}

// ---------------------------------------------------------------------------
// The two ceremonies
// ---------------------------------------------------------------------------

export interface Expected {
  challenge: Uint8Array;
  /** The relay's address, which is the page's origin. */
  origin: string;
  /** Its host name, which a passkey is bound to. */
  rpId: string;
}

export interface Passkey {
  credentialId: string;
  jwk: JsonWebKey;
  alg: -7 | -257;
  signCount: number;
}

/** A new passkey, made during pairing. Returns what to keep for checking it later. */
export function verifyRegistration(
  expected: Expected,
  response: { clientDataJSON: Uint8Array; attestationObject: Uint8Array },
): Passkey {
  checkClientData(response.clientDataJSON, 'webauthn.create', expected.challenge, expected.origin);
  const attestation = decodeCbor(response.attestationObject).value;
  if (!(attestation instanceof Map)) throw new Error('attestation-shape');
  const authBytes = attestation.get('authData');
  if (!(authBytes instanceof Uint8Array)) throw new Error('attestation-authdata');
  const auth = readAuthData(authBytes);
  if (!same(auth.rpIdHash, sha256(expected.rpId))) throw new Error('rpid');
  if ((auth.flags & FLAG_USER_PRESENT) === 0) throw new Error('not-present');
  if ((auth.flags & FLAG_USER_VERIFIED) === 0) throw new Error('not-verified');
  if (!auth.credentialId || !auth.publicKey) throw new Error('no-credential');
  const { jwk, alg } = coseToJwk(auth.publicKey);
  // Imported once here, so a key node cannot use is refused at pairing rather than at every unlock.
  createPublicKey({ key: jwk as Record<string, string>, format: 'jwk' });
  return { credentialId: b64url(auth.credentialId), jwk, alg, signCount: auth.signCount };
}

/** An unlock. Returns the new signature counter to store. Throws for anything not right. */
export function verifyAssertion(
  expected: Expected,
  passkey: Passkey,
  response: {
    credentialId: string;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
    signature: Uint8Array;
  },
): number {
  if (response.credentialId !== passkey.credentialId) throw new Error('credential');
  checkClientData(response.clientDataJSON, 'webauthn.get', expected.challenge, expected.origin);
  const auth = readAuthData(response.authenticatorData);
  if (!same(auth.rpIdHash, sha256(expected.rpId))) throw new Error('rpid');
  if ((auth.flags & FLAG_USER_PRESENT) === 0) throw new Error('not-present');
  if ((auth.flags & FLAG_USER_VERIFIED) === 0) throw new Error('not-verified');
  const key: KeyObject = createPublicKey({
    key: passkey.jwk as Record<string, string>,
    format: 'jwk',
  });
  const signed = Buffer.concat([response.authenticatorData, sha256(response.clientDataJSON)]);
  if (!verify('sha256', signed, key, response.signature)) throw new Error('signature');
  /*
   * A counter that went backwards means the key was copied. Passkeys synced through iCloud report
   * zero every time, which says nothing either way, so zero is accepted.
   */
  if (auth.signCount !== 0 && auth.signCount <= passkey.signCount) throw new Error('counter');
  return auth.signCount;
}
