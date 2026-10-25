import { describe, expect, it } from 'vitest';
import { decodeCbor, verifyAssertion, verifyRegistration } from './webauthn.js';
import { authenticator, b64url, expected } from './test-authenticator.js';

describe('pairing a passkey', () => {
  it('keeps the public key of a passkey made with Face ID or a passcode', () => {
    const device = authenticator();
    const key = verifyRegistration(expected(), device.register(expected()));
    expect(key.alg).toBe(-7);
    expect(key.credentialId).toBe(b64url(new Uint8Array(16).fill(3)));
  });

  it('refuses one made without the person unlocking the device', () => {
    const device = authenticator();
    expect(() => verifyRegistration(expected(), device.register(expected(), 0x41))).toThrow(
      'not-verified',
    );
  });

  it('refuses one made for another site, or for another challenge', () => {
    const device = authenticator();
    expect(() =>
      verifyRegistration(expected(), device.register(expected(), 0x45, 'evil.example')),
    ).toThrow('rpid');
    expect(() =>
      verifyRegistration(expected(new Uint8Array(32)), device.register(expected())),
    ).toThrow('clientdata-challenge');
  });
});

describe('unlocking with it', () => {
  it('accepts a fresh signature from the paired passkey', () => {
    const device = authenticator();
    const key = verifyRegistration(expected(), device.register(expected()));
    expect(verifyAssertion(expected(), key, device.assert(expected()))).toBe(0);
  });

  it('refuses a signature for an old challenge, which is a replay', () => {
    const device = authenticator();
    const key = verifyRegistration(expected(), device.register(expected()));
    const old = device.assert(expected());
    expect(() => verifyAssertion(expected(new Uint8Array(32).fill(9)), key, old)).toThrow(
      'clientdata-challenge',
    );
  });

  it('refuses another page pretending to be the relay', () => {
    const device = authenticator();
    const key = verifyRegistration(expected(), device.register(expected()));
    const forged = device.assert(expected(), { clientData: { origin: 'https://evil.example' } });
    expect(() => verifyAssertion(expected(), key, forged)).toThrow('clientdata-origin');
  });

  it('refuses an unlock without Face ID, a fingerprint or the passcode', () => {
    const device = authenticator();
    const key = verifyRegistration(expected(), device.register(expected()));
    expect(() =>
      verifyAssertion(expected(), key, device.assert(expected(), { flags: 0x01 })),
    ).toThrow('not-verified');
  });

  it('refuses a signature from any other key', () => {
    const device = authenticator();
    const other = authenticator();
    const key = verifyRegistration(expected(), device.register(expected()));
    expect(() => verifyAssertion(expected(), key, other.assert(expected()))).toThrow('signature');
  });

  it('refuses a counter that went backwards, which is a copied key', () => {
    const device = authenticator();
    const key = { ...verifyRegistration(expected(), device.register(expected())), signCount: 5 };
    expect(() =>
      verifyAssertion(expected(), key, device.assert(expected(), { counter: 3 })),
    ).toThrow('counter');
    expect(verifyAssertion(expected(), key, device.assert(expected(), { counter: 6 }))).toBe(6);
  });
});

describe('the decoder', () => {
  it('refuses truncated and absurd input rather than reading past it', () => {
    expect(() => decodeCbor(new Uint8Array([0x5a, 0xff, 0xff, 0xff, 0xff]))).toThrow(
      'cbor-truncated',
    );
    expect(() => decodeCbor(new Uint8Array(40).fill(0x81))).toThrow();
  });
});
