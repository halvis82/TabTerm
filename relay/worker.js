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

/** One Mac and its browsers. Uses hibernation, so an idle room costs nothing. */
export class Room {
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
    if (side === 'browser' && this.state.getWebSockets('browser').length >= MAX_BROWSERS) {
      return new Response('Too many connections', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (side === 'daemon') {
      // One Mac per room. A new connection from it replaces the old, which is a reconnect.
      for (const ws of this.state.getWebSockets('daemon')) ws.close(4000, 'replaced');
      this.state.acceptWebSocket(server, ['daemon']);
    } else if (this.state.getWebSockets('daemon').length === 0) {
      /*
       * Said with a close code rather than an HTTP error, whose reason a browser cannot read. Not
       * hibernated, and closed once the connection is open, since a socket closed before the
       * answer that opens it has gone out is never seen by the browser at all.
       */
      server.accept();
      setTimeout(() => server.close(4002, 'The Mac is offline'), 0);
    } else {
      const id = ((await this.state.storage.get('next')) ?? 0) + 1;
      await this.state.storage.put('next', id >= 0xfffffff0 ? 0 : id);
      this.state.acceptWebSocket(server, ['browser', `id:${id}`]);
      server.serializeAttachment({ id });
      this.#toDaemon(id, new Uint8Array(0));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  #toDaemon(id, body) {
    for (const ws of this.state.getWebSockets('daemon')) ws.send(withId(id, body));
  }

  async webSocketMessage(ws, message) {
    if (typeof message === 'string') return ws.close(1003, 'Binary only');
    const bytes = new Uint8Array(message);
    if (bytes.length > MAX_FRAME + 4) return ws.close(1009, 'Too large');
    if (this.state.getTags(ws).includes('daemon')) {
      if (bytes.length < 4) return;
      const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
      const body = bytes.subarray(4);
      const targets =
        id === 0 ? this.state.getWebSockets('browser') : this.state.getWebSockets(`id:${id}`);
      for (const t of targets) {
        if (body.length === 1 && body[0] === GONE) t.close(4001, 'Closed by the Mac');
        else t.send(body);
      }
      return;
    }
    // A connection told the Mac is offline has no id, and anything it sends goes nowhere.
    const id = ws.deserializeAttachment()?.id;
    if (id === undefined) return;
    this.#toDaemon(id, bytes);
  }

  async webSocketClose(ws, code) {
    // The close is answered, which completes it on this side.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Closed');
    } catch {
      // Already closed.
    }
    if (!this.state.getTags(ws).includes('browser')) {
      // The Mac went away: every browser is told by its connection closing.
      for (const b of this.state.getWebSockets('browser')) {
        try {
          b.close(4002, 'The Mac is offline');
        } catch {
          // Already closed.
        }
      }
      return;
    }
    const id = ws.deserializeAttachment()?.id;
    if (id !== undefined) this.#toDaemon(id, new Uint8Array([GONE]));
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
