import { pairingLink, type RemoteAccessState } from '@tabterm/shared';
import { info } from '../log.js';
import { RemoteBridge, type BridgeStatus, type RemoteHost } from './bridge.js';
import { PAIRING_TTL_MS, RemoteStore } from './store.js';
import type { Fetch } from './webpush.js';

/**
 * Remote access, as Settings drives it.
 *
 * Off by default, and off means off: no connection is made and no output is looked at. The bridge
 * exists only while it is on and set up, so a daemon with this turned off runs exactly the code
 * it ran before remote access existed, apart from reading one small file at start.
 */
export class RemoteControl {
  readonly #store: RemoteStore;
  readonly #host: RemoteHost;
  readonly #onChange: (state: RemoteAccessState) => void;
  #bridge: RemoteBridge | undefined;
  #status: BridgeStatus = { state: 'off', browsers: 0 };
  readonly #pushFetch: Fetch | undefined;
  readonly #pingMs: number | undefined;
  readonly #selfCheckMs: number | undefined;

  constructor(
    stateDir: string,
    host: RemoteHost,
    onChange: (state: RemoteAccessState) => void,
    /** Stands in for the push services in tests. */
    pushFetch?: Fetch,
    /** How often the relay is asked if it is still there, shorter in tests. */
    pingMs?: number,
    /** How often the Mac checks a device can reach it through the relay. 0 for never. */
    selfCheckMs?: number,
  ) {
    this.#store = new RemoteStore(stateDir);
    this.#host = host;
    this.#onChange = onChange;
    this.#pushFetch = pushFetch;
    this.#pingMs = pingMs;
    this.#selfCheckMs = selfCheckMs;
    this.#apply();
  }

  get state(): RemoteAccessState {
    const s = this.#store.state;
    return {
      enabled: s.enabled,
      relayUrl: s.relayUrl,
      hasSecret: s.relaySecret.length > 0,
      status: this.#status.state,
      ...(this.#status.detail === undefined ? {} : { detail: this.#status.detail }),
      browsers: this.#status.browsers,
      devices: s.devices.map((d) => ({
        id: d.id,
        name: d.name,
        addedAt: d.addedAt,
        ...(d.lastSeenAt === undefined ? {} : { lastSeenAt: d.lastSeenAt }),
        typing: d.typing,
        notify: d.push !== undefined,
      })),
    };
  }

  #ready(): boolean {
    const s = this.#store.state;
    return s.enabled && validRelay(s.relayUrl) && s.relaySecret.length >= 24;
  }

  /** Start, stop or restart the bridge to match what is stored. */
  #apply(): void {
    this.#bridge?.stop();
    this.#bridge = undefined;
    this.#status = { state: 'off', browsers: 0 };
    if (this.#ready()) {
      this.#bridge = new RemoteBridge(
        this.#host,
        this.#store,
        (status) => {
          this.#status = status;
          this.#onChange(this.state);
        },
        this.#pushFetch,
        this.#pingMs,
        this.#selfCheckMs,
      );
      this.#bridge.start();
      info('remote.on', {});
    } else if (this.#store.state.enabled) {
      this.#status = {
        state: 'error',
        detail: validRelay(this.#store.state.relayUrl)
          ? 'Enter the relay secret'
          : 'Enter the relay address',
        browsers: 0,
      };
    }
    this.#onChange(this.state);
  }

  configure(change: { enabled?: boolean; relayUrl?: string; relaySecret?: string }): void {
    const before = this.#store.state;
    const next = { ...change };
    if (next.relayUrl !== undefined) next.relayUrl = next.relayUrl.trim().replace(/\/+$/, '');
    const restart =
      (next.enabled !== undefined && next.enabled !== before.enabled) ||
      (next.relayUrl !== undefined && next.relayUrl !== before.relayUrl) ||
      (next.relaySecret !== undefined && next.relaySecret !== before.relaySecret);
    this.#store.configure(next);
    if (restart) this.#apply();
    else this.#onChange(this.state);
  }

  /** A link for a new device, valid for ten minutes and once. */
  pair(): { link: string; expiresAt: number } | null {
    const s = this.#store.state;
    if (!validRelay(s.relayUrl)) return null;
    const pairing = this.#store.startPairing();
    return {
      link: pairingLink(s.relayUrl, { room: s.room, device: pairing.id, key: pairing.key }),
      expiresAt: pairing.createdAt + PAIRING_TTL_MS,
    };
  }

  device(change: { deviceId: string; typing?: boolean; name?: string; forget?: boolean }): void {
    if (change.forget === true) this.#store.forget(change.deviceId);
    else {
      if (change.typing !== undefined) this.#store.setTyping(change.deviceId, change.typing);
      if (change.name !== undefined) this.#store.rename(change.deviceId, change.name);
    }
    this.#bridge?.deviceChanged(change.deviceId);
    this.#onChange(this.state);
  }

  stop(): void {
    this.#bridge?.stop();
    this.#bridge = undefined;
  }
}

/**
 * An address a passkey can be bound to: https, or http on this machine for trying it out.
 *
 * WebAuthn refuses plain http anywhere else, and a relay reached over plain http would hand the
 * page itself to anybody on the way, so nothing else is accepted.
 */
export function validRelay(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && u.hostname === 'localhost';
  } catch {
    return false;
  }
}
