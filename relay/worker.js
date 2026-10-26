/**
 * The TabTerm relay.
 *
 * It connects one Mac with the browsers paired to it, and it cannot read anything that passes
 * through. Every frame is sealed with a key made on the Mac, which reaches a browser inside a
 * link's #fragment, and a browser never sends a fragment to any server. So this sees how many
 * bytes go by and when, and nothing else. See docs/17-remote-access.md.
 *
 * Between the relay and the Mac, every frame starts with 4 bytes naming the browser connection it
 * is from or for. A browser connecting is announced with an empty body, and leaving with the one
 * byte 0xff. The Mac sends that same byte to close a browser.
 *
 * Only the Mac knows RELAY_SECRET, so nobody else can take the Mac's place. Anybody can open a
 * browser connection, which is harmless: without a device key nothing they send opens, and nothing
 * sent to them can be read.
 */
import PAGE from './page.html';
import ICON from './icon.png';

const MAX_FRAME = 1 << 20;
const MAX_BROWSERS = 8;
const GONE = 0xff;

/**
 * The page may run exactly the script it was built with, by its hash, and load
 * nothing from anywhere. Worked out from the page itself once per start, so a rebuilt page can
 * never be served with a policy that does not match it.
 */
let headers;
async function pageHeaders() {
  if (headers) return headers;
  const hash = async (text) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
  };
  const inner = (tag) =>
    [...PAGE.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
  const scripts = await Promise.all(inner('script').map(hash));
  headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'none'",
      `script-src ${scripts.join(' ')}`,
      // The terminal writes its own style sheet as it draws, so styles cannot be pinned by hash.
      // A style cannot run anything, and scripts stay pinned.
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "manifest-src 'self'",
      "worker-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // The camera, for Scan when pairing, and only for the page itself.
    'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  };
  return headers;
}

const MANIFEST = JSON.stringify({
  name: 'TabTerm',
  short_name: 'TabTerm',
  start_url: '/',
  display: 'standalone',
  background_color: '#0d1117',
  theme_color: '#0d1117',
  icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }],
});

/**
 * Shows the notifications the Mac sends when an agent needs somebody. The Mac encrypts each one to
 * this device, and the push service hands it here, so the relay never carries one. It does nothing
 * else: no caching and no requests, so the page is always the one the relay serves.
 */
const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  const session = typeof d.session === 'string' ? d.session : '';
  e.waitUntil(self.registration.showNotification(String(d.title || 'TabTerm'), {
    body: String(d.body || 'An agent needs you'),
    tag: session || 'tabterm',
    icon: '/icon.png',
    data: { session },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const session = (e.notification.data && e.notification.data.session) || '';
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open.length > 0) {
      open[0].postMessage({ open: session });
      return open[0].focus();
    }
    return self.clients.openWindow(session ? '/#open=' + encodeURIComponent(session) : '/');
  })());
});
`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(PAGE, { headers: await pageHeaders() });
    }
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } });
    }
    if (url.pathname === '/sw.js') {
      return new Response(SERVICE_WORKER, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          'content-security-policy': "default-src 'none'; img-src 'self'",
        },
      });
    }
    if (url.pathname === '/icon.png') {
      return new Response(ICON, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
      });
    }
    /*
     * Whether the Mac is connected, for a page that could not get through to say why. Only
     * somebody with a pairing link knows a room's name, and this says nothing else about it.
     */
    const status = url.pathname.match(/^\/status\/([A-Za-z0-9_-]{16,64})$/);
    if (status) {
      const stub = env.ROOM.get(env.ROOM.idFromName(status[1]));
      return stub.fetch(new Request('https://room/status'));
    }
    const m = url.pathname.match(/^\/ws\/(daemon|browser)\/([A-Za-z0-9_-]{16,64})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected a websocket', { status: 426 });
    }
    const [, side, room] = m;
    if (side === 'daemon') {
      if (!env.RELAY_SECRET || env.RELAY_SECRET.length < 24) {
        return new Response('RELAY_SECRET is not set on this relay', { status: 500 });
      }
      if (!same(req.headers.get('authorization') ?? '', `Bearer ${env.RELAY_SECRET}`)) {
        return new Response('Unauthorized', { status: 401 });
      }
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    return stub.fetch(new Request(`https://room/${side}`, req));
  },
};

/** Compares in time that does not depend on where the first difference is. */
function same(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function withId(id, body) {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, id);
  out.set(body, 4);
  return out;
}

/**
 * A socket the room can still use. One closed by either side stays in the room's list until the
 * close completes, which for a peer that vanished may be never, and sending on it throws.
 */
function isOpen(ws) {
  try {
    return ws.readyState === undefined || ws.readyState === 1;
  } catch {
    return false;
  }
}

function send(ws, data) {
  try {
    ws.send(data);
  } catch {
    // Closed meanwhile: whoever it was for is gone, and nothing else is held up by that.
  }
}

function close(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

function attachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return undefined;
  }
}

/**
 * One Mac and its browsers. Uses hibernation, so an idle room costs nothing.
 *
 * Named RelayRoom since migration v2, which renamed it from Room. A room that never goes idle can
 * keep running the code it started with through a deploy, and the rename is what makes Cloudflare
 * replace every running room with the current code. See wrangler.toml.
 */
export class RelayRoom {
  constructor(state) {
    this.state = state;
    /*
     * The Mac asks "ping" now and then to know its connection still reaches this room, and not a
     * connection Cloudflare has quietly let go of, after a deploy for one. Answered by Cloudflare
     * without waking the room, so it costs nothing.
     */
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const side = new URL(req.url).pathname.slice(1);
    if (side === 'status') {
      return new Response(JSON.stringify({ mac: this.#mac() !== null }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (side === 'browser') {
      /*
       * A full room lets its oldest connections go to make space, rather than turning the new one
       * away. A phone put in a pocket can lose its connection without a word, and the relay keeps
       * that socket open, so refusing would let a few forgotten connections lock every device out.
       * The one connecting now is the one somebody is looking at.
       */
      const browsers = this.state
        .getWebSockets('browser')
        .filter(isOpen)
        .map((ws) => ({ ws, id: attachment(ws)?.id ?? 0 }))
        .sort((a, b) => a.id - b.id);
      for (const { ws, id } of browsers.slice(0, Math.max(0, browsers.length - MAX_BROWSERS + 1))) {
        close(ws, 4003, 'Replaced by a newer connection');
        // A connection that is gone never answers the close, so the Mac is told here.
        this.#toDaemon(id, new Uint8Array([GONE]));
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (side === 'daemon') {
      // One Mac per room. A new connection from it replaces the old, which is a reconnect.
      for (const ws of this.state.getWebSockets('daemon')) close(ws, 4000, 'replaced');
      /*
       * And its browsers go with it. The new connection knows none of them, so anything they sent
       * would go nowhere, and the old one may never be seen closing: one the Mac gave up on stays
       * open here. Closed, each page comes back on its own and introduces itself again.
       */
      for (const ws of this.state.getWebSockets('browser')) close(ws, 4002, 'The Mac reconnected');
      this.state.acceptWebSocket(server, ['daemon']);
      // Numbered, so the newest is the Mac's connection however long an old one takes to go.
      server.serializeAttachment({ mac: await this.#next() });
    } else if (!this.#mac()) {
      /*
       * Said with a close code rather than an HTTP error, whose reason a browser cannot read. Not
       * hibernated, and closed once the connection is open, since a socket closed before the
       * answer that opens it has gone out is never seen by the browser at all.
       */
      server.accept();
      setTimeout(() => close(server, 4002, 'The Mac is offline'), 0);
    } else {
      const id = await this.#next();
      this.state.acceptWebSocket(server, ['browser', `id:${id}`]);
      server.serializeAttachment({ id });
      this.#toDaemon(id, new Uint8Array(0));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async #next() {
    const id = ((await this.state.storage.get('next')) ?? 0) + 1;
    await this.state.storage.put('next', id >= 0xfffffff0 ? 0 : id);
    return id;
  }

  /**
   * The Mac's connection: the newest one still open. A connection the Mac replaced, or one that
   * died without closing, can stay in the room's list for a long while, and sending on one that
   * was closed throws. That once took down every device's connection after the Mac reconnected.
   */
  #mac() {
    let newest = null;
    for (const ws of this.state.getWebSockets('daemon')) {
      if (!isOpen(ws)) continue;
      if (!newest || (attachment(ws)?.mac ?? 0) > (attachment(newest)?.mac ?? 0)) newest = ws;
    }
    return newest;
  }

  #toDaemon(id, body) {
    const mac = this.#mac();
    if (mac) send(mac, withId(id, body));
  }

  async webSocketMessage(ws, message) {
    if (typeof message === 'string') return close(ws, 1003, 'Binary only');
    const bytes = new Uint8Array(message);
    if (bytes.length > MAX_FRAME + 4) return close(ws, 1009, 'Too large');
    if (this.state.getTags(ws).includes('daemon')) {
      // Only the Mac's current connection speaks for it.
      if (ws !== this.#mac() || bytes.length < 4) return;
      const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
      const body = bytes.subarray(4);
      const targets =
        id === 0 ? this.state.getWebSockets('browser') : this.state.getWebSockets(`id:${id}`);
      for (const t of targets) {
        if (body.length === 1 && body[0] === GONE) close(t, 4001, 'Closed by the Mac');
        else send(t, body);
      }
      return;
    }
    // A connection told the Mac is offline has no id, and anything it sends goes nowhere.
    const id = attachment(ws)?.id;
    if (id === undefined) return;
    this.#toDaemon(id, bytes);
  }

  async webSocketClose(ws, code) {
    // The close is answered, which completes it on this side.
    close(ws, code === 1005 || code === 1006 ? 1000 : code, 'Closed');
    if (!this.state.getTags(ws).includes('browser')) {
      // A Mac connection already replaced going away changes nothing.
      if (this.#mac()) return;
      // The Mac went away: every browser is told by its connection closing.
      for (const b of this.state.getWebSockets('browser')) close(b, 4002, 'The Mac is offline');
      return;
    }
    const id = attachment(ws)?.id;
    if (id !== undefined) this.#toDaemon(id, new Uint8Array([GONE]));
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
