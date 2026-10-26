import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_KEY_BYTES, randomBytes, toBase64Url } from '@tabterm/shared';
import { writeFileAtomic } from '../atomic-write.js';
import type { Passkey } from './webauthn.js';
import {
  makeVapidKeys,
  pushEndpointAllowed,
  type PushSubscription,
  type VapidKeys,
} from './webpush.js';

/**
 * What remote access remembers: whether it is on, which relay, and the trusted devices.
 *
 * A file of its own beside the database, readable by this user only, because it holds the relay's
 * secret and every device's key. Not in the settings file, which is about taste and is reset by
 * "Reset settings": that must never quietly sign every phone out, or quietly keep them in.
 */

export interface TrustedDevice {
  id: string;
  name: string;
  /** The key sealing this device's connections, base64url. */
  key: string;
  passkey: Passkey;
  addedAt: number;
  lastSeenAt?: number;
  /** Whether what is typed on it reaches the terminal. Off means it can only watch. */
  typing: boolean;
  /** Where its notifications go, when it asked for them. */
  push?: PushSubscription;
}

/** A link shown as a code, waiting for a device to open it and make its passkey. */
export interface PendingPairing {
  id: string;
  key: string;
  createdAt: number;
}

export interface RemoteState {
  enabled: boolean;
  relayUrl: string;
  relaySecret: string;
  /** Which room on the relay is this Mac's. Random, so a relay could hold several Macs. */
  room: string;
  devices: TrustedDevice[];
  pending: PendingPairing[];
  /** This Mac's key for signing notifications, made the first time a device asks for them. */
  vapid?: VapidKeys;
}

/** A pairing link works for this long, once. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Enough for every device somebody owns, few enough that a list of them stays readable. */
export const MAX_DEVICES = 12;

const id = (bytes: number): string => toBase64Url(randomBytes(bytes));

function fresh(): RemoteState {
  return { enabled: false, relayUrl: '', relaySecret: '', room: id(18), devices: [], pending: [] };
}

/** Only what has the right shape survives a read, so a damaged file cannot reach the bridge. */
function sane(raw: unknown): RemoteState {
  const base = fresh();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const devices = Array.isArray(r['devices'])
    ? r['devices'].filter(
        (d): d is TrustedDevice =>
          typeof d === 'object' &&
          d !== null &&
          typeof (d as TrustedDevice).id === 'string' &&
          typeof (d as TrustedDevice).key === 'string' &&
          typeof (d as TrustedDevice).passkey?.credentialId === 'string' &&
          typeof (d as TrustedDevice).passkey.jwk === 'object',
      )
    : [];
  const pending = Array.isArray(r['pending'])
    ? r['pending'].filter(
        (p): p is PendingPairing =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as PendingPairing).id === 'string' &&
          typeof (p as PendingPairing).key === 'string' &&
          typeof (p as PendingPairing).createdAt === 'number',
      )
    : [];
  return {
    enabled: r['enabled'] === true,
    relayUrl: str(r['relayUrl'], ''),
    relaySecret: str(r['relaySecret'], ''),
    room: /^[A-Za-z0-9_-]{16,64}$/.test(str(r['room'], '')) ? str(r['room'], '') : base.room,
    devices: devices.map((d) => {
      const { push, ...rest } = d;
      return {
        ...rest,
        name: str(d.name, 'Device'),
        typing: d.typing === true,
        ...(saneSubscription(push) ? { push } : {}),
      };
    }),
    pending,
    ...(typeof (r['vapid'] as VapidKeys | undefined)?.publicKey === 'string' &&
    typeof (r['vapid'] as VapidKeys | undefined)?.privateJwk === 'object'
      ? { vapid: r['vapid'] as VapidKeys }
      : {}),
  };
}

/** A subscription as a device sends it, checked before it is kept or used. */
export function saneSubscription(raw: unknown): raw is PushSubscription {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['endpoint'] === 'string' &&
    r['endpoint'].length < 2048 &&
    pushEndpointAllowed(r['endpoint']) &&
    typeof r['p256dh'] === 'string' &&
    /^[A-Za-z0-9_-]{80,100}$/.test(r['p256dh']) &&
    typeof r['auth'] === 'string' &&
    /^[A-Za-z0-9_-]{16,32}$/.test(r['auth'])
  );
}

export class RemoteStore {
  readonly #file: string;
  #state: RemoteState;

  constructor(stateDir: string) {
    this.#file = join(stateDir, 'remote.json');
    this.#state = fresh();
    if (existsSync(this.#file)) {
      try {
        this.#state = sane(JSON.parse(readFileSync(this.#file, 'utf8')));
      } catch {
        // A file that cannot be read is the same as no file: off, no devices.
        this.#state = fresh();
      }
    }
  }

  get state(): Readonly<RemoteState> {
    return this.#state;
  }

  #save(): void {
    writeFileAtomic(this.#file, JSON.stringify(this.#state, null, 2), 0o600);
  }

  configure(change: { enabled?: boolean; relayUrl?: string; relaySecret?: string }): void {
    if (change.enabled !== undefined) this.#state.enabled = change.enabled;
    if (change.relayUrl !== undefined) this.#state.relayUrl = change.relayUrl.trim();
    if (change.relaySecret !== undefined) this.#state.relaySecret = change.relaySecret.trim();
    this.#save();
  }

  /** A new link. Older unused ones past their time are dropped while here. */
  startPairing(now = Date.now()): PendingPairing {
    this.#state.pending = this.#state.pending.filter((p) => now - p.createdAt < PAIRING_TTL_MS);
    const pairing = { id: id(12), key: toBase64Url(randomBytes(DEVICE_KEY_BYTES)), createdAt: now };
    this.#state.pending.push(pairing);
    this.#save();
    return pairing;
  }

  pendingFor(deviceId: string, now = Date.now()): PendingPairing | undefined {
    return this.#state.pending.find((p) => p.id === deviceId && now - p.createdAt < PAIRING_TTL_MS);
  }

  device(deviceId: string): TrustedDevice | undefined {
    return this.#state.devices.find((d) => d.id === deviceId);
  }

  /** The link was used and a passkey made: the device is trusted, and the link is spent. */
  trust(pairing: PendingPairing, name: string, passkey: Passkey, now = Date.now()): TrustedDevice {
    this.#state.pending = this.#state.pending.filter((p) => p.id !== pairing.id);
    if (this.#state.devices.length >= MAX_DEVICES) throw new Error('too-many-devices');
    const device: TrustedDevice = {
      id: pairing.id,
      name: name.slice(0, 60) || 'Device',
      key: pairing.key,
      passkey,
      addedAt: now,
      lastSeenAt: now,
      typing: true,
    };
    this.#state.devices.push(device);
    this.#save();
    return device;
  }

  seen(deviceId: string, signCount: number, now = Date.now()): void {
    const device = this.device(deviceId);
    if (!device) return;
    device.lastSeenAt = now;
    device.passkey = { ...device.passkey, signCount };
    this.#save();
  }

  setTyping(deviceId: string, typing: boolean): void {
    const device = this.device(deviceId);
    if (!device) return;
    device.typing = typing;
    this.#save();
  }

  /** The key devices subscribe with, made once and kept. */
  vapid(): VapidKeys {
    if (!this.#state.vapid) {
      this.#state.vapid = makeVapidKeys();
      this.#save();
    }
    return this.#state.vapid;
  }

  /** Notifications on, to this address, or off with undefined. */
  setPush(deviceId: string, push: PushSubscription | undefined): void {
    const device = this.device(deviceId);
    if (!device) return;
    if (push) device.push = { endpoint: push.endpoint, p256dh: push.p256dh, auth: push.auth };
    else delete device.push;
    this.#save();
  }

  rename(deviceId: string, name: string): void {
    const device = this.device(deviceId);
    if (!device) return;
    device.name = name.trim().slice(0, 60) || device.name;
    this.#save();
  }

  forget(deviceId: string): void {
    this.#state.devices = this.#state.devices.filter((d) => d.id !== deviceId);
    this.#state.pending = this.#state.pending.filter((p) => p.id !== deviceId);
    this.#save();
  }
}
