import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptPush,
  makeVapidKeys,
  pushEndpointAllowed,
  sendPush,
  vapidAuthorization,
} from './webpush.js';

const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');
const hmac = (k: Uint8Array, d: Uint8Array): Buffer => createHmac('sha256', k).update(d).digest();

/** What a browser does with one, written out separately so the two can disagree. */
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    uaPublic,
    asPublic,
    Buffer.from([1]),
  ]);
  const prk = hmac(salt, hmac(hmac(authSecret, shared), info));
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const sealed = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1);
}

describe('push encryption', () => {
  it('matches the worked example in RFC 8291, appendix A', () => {
    const out = encryptPush(
      {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        salt: unb64('DGv6ra1nlYgDCS1FRnbzlw'),
        senderPrivate: unb64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('opens on the device, with a fresh key and salt every time', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const sub = {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    };
    const a = encryptPush(sub, Buffer.from('{"title":"x"}'));
    const b = encryptPush(sub, Buffer.from('{"title":"x"}'));
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, ua.getPrivateKey(), auth).toString()).toBe('{"title":"x"}');
  });

  it('refuses keys of the wrong shape', () => {
    expect(() => encryptPush({ p256dh: 'AAAA', auth: 'AAAA' }, Buffer.from('x'))).toThrow();
  });
});

describe('VAPID', () => {
  it('signs a token the public key verifies, for the push service it is sent to', () => {
    const keys = makeVapidKeys();
    const header = vapidAuthorization(
      'https://web.push.apple.com/QGuQyavXutnMH',
      keys,
      'https://relay.example',
      1_700_000_000_000,
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m as unknown as [string, string, string, string, string];
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(unb64(c).toString()) as Record<string, unknown>;
    expect(claims).toEqual({
      aud: 'https://web.push.apple.com',
      exp: 1_700_000_000 + 12 * 3600,
      sub: 'https://relay.example',
    });
    const point = unb64(k);
    const pub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64(s)),
    ).toBe(true);
  });
});

describe('where a push may go', () => {
  it('only to the push services there are', () => {
    expect(pushEndpointAllowed('https://web.push.apple.com/abc')).toBe(true);
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(pushEndpointAllowed('http://web.push.apple.com/abc')).toBe(false);
    expect(pushEndpointAllowed('https://web.push.apple.com:8443/abc')).toBe(false);
    expect(pushEndpointAllowed('https://evilpush.apple.com.example/abc')).toBe(false);
    expect(pushEndpointAllowed('https://127.0.0.1/abc')).toBe(false);
    expect(pushEndpointAllowed('not a url')).toBe(false);
  });

  it('a subscription the service says is gone is reported gone, and nothing is sent elsewhere', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = {
      endpoint: 'https://web.push.apple.com/abc',
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16).toString('base64url'),
    };
    const keys = makeVapidKeys();
    const calls: string[] = [];
    const answer = (status: number) => (url: string) => {
      calls.push(url);
      return Promise.resolve({ status });
    };
    expect(await sendPush(sub, {}, keys, 'mailto:x@y', answer(201))).toBe('sent');
    expect(await sendPush(sub, {}, keys, 'mailto:x@y', answer(410))).toBe('gone');
    expect(await sendPush(sub, {}, keys, 'mailto:x@y', answer(500))).toBe('failed');
    expect(
      await sendPush(
        { ...sub, endpoint: 'https://127.0.0.1/x' },
        {},
        keys,
        'mailto:x@y',
        answer(201),
      ),
    ).toBe('gone');
    expect(calls).toEqual([sub.endpoint, sub.endpoint, sub.endpoint]);
  });
});
