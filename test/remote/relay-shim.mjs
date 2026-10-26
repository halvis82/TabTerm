// The relay, run in Node for tests, with the real relay code inside it.
//
// relay/worker.js is loaded as it is and given the few Cloudflare pieces it uses: a Durable Object
// state that tracks sockets by tag, WebSocketPair, and a Response that can say 101. So a test
// exercises the relay's own routing, secret check, envelopes and room logic, and needs neither a
// Cloudflare account nor wrangler.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const RELAY = fileURLToPath(new URL('../../relay/', import.meta.url));

class ShimResponse extends Response {
  constructor(body, init = {}) {
    if (init.status === 101) {
      super(null, { status: 200 });
      this.upgradeTo = init.webSocket;
    } else {
      super(body, init);
    }
  }
}

/** The server half of a WebSocketPair, standing in front of a real socket once it exists. */
class ShimSocket {
  constructor() {
    this.tags = [];
    this.attachment = undefined;
    this.real = null;
    this.queue = [];
    this.closed = null;
    // As in Cloudflare: open until either side closes, and sending after that throws.
    this.readyState = 1;
  }
  /** Taking a socket without hibernation, which the shim does not distinguish. */
  accept() {}
  send(data) {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    if (this.real) this.real.send(data);
    else this.queue.push(data);
  }
  close(code, reason) {
    if (this.readyState === 3) throw new TypeError('WebSocket already closed');
    this.readyState = 2;
    if (this.real) this.real.close(code, reason);
    else this.closed = [code, reason];
  }
  serializeAttachment(v) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  attach(real) {
    this.real = real;
    for (const d of this.queue.splice(0)) real.send(d);
    if (this.closed) real.close(...this.closed);
  }
}

class ShimState {
  constructor() {
    this.sockets = new Set();
    this.store = new Map();
    this.storage = {
      get: async (k) => this.store.get(k),
      put: async (k, v) => void this.store.set(k, v),
    };
  }
  /** Answered here without reaching the room, as Cloudflare does. */
  setWebSocketAutoResponse(pair) {
    this.autoResponse = pair;
  }
  acceptWebSocket(ws, tags) {
    ws.tags = tags;
    this.sockets.add(ws);
  }
  getWebSockets(tag) {
    return [...this.sockets].filter((s) => s.tags.includes(tag));
  }
  getTags(ws) {
    return ws.tags;
  }
}

/**
 * `linger`: a socket that has closed stays in its room's list, as Cloudflare keeps one whose peer
 * vanished without completing the close. Sending on it throws, as it does there.
 */
export async function startRelay({ secret, port = 0, host = '127.0.0.1', linger = false } = {}) {
  globalThis.Response = ShimResponse;
  globalThis.WebSocketRequestResponsePair = class {
    constructor(request, response) {
      this.request = request;
      this.response = response;
    }
  };
  globalThis.WebSocketPair = class {
    constructor() {
      this[1] = new ShimSocket();
      this[0] = { server: this[1] };
    }
  };
  const page = readFileSync(`${RELAY}page.html`, 'utf8');
  const source = readFileSync(`${RELAY}worker.js`, 'utf8')
    .replace("import PAGE from './page.html';", 'const PAGE = globalThis.__tabtermRelayPage;')
    .replace("import ICON from './icon.png';", 'const ICON = globalThis.__tabtermRelayIcon;');
  globalThis.__tabtermRelayPage = page;
  globalThis.__tabtermRelayIcon = new Uint8Array(readFileSync(`${RELAY}icon.png`)).buffer;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const rooms = new Map();
  const env = {
    RELAY_SECRET: secret,
    ROOM: {
      idFromName: (name) => name,
      get: (name) => {
        if (!rooms.has(name)) {
          const state = new ShimState();
          rooms.set(name, { state, room: new mod.RelayRoom(state) });
        }
        const { room } = rooms.get(name);
        return { fetch: async (req) => Object.assign(await room.fetch(req), { room }) };
      },
    },
  };

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const out = await mod.default.fetch(
      new Request(`http://localhost${req.url}`, { headers: req.headers }),
      env,
    );
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  server.on('upgrade', async (req, socket, head) => {
    const out = await mod.default.fetch(
      new Request(`http://localhost${req.url}`, { headers: req.headers }),
      env,
    );
    if (!out.upgradeTo) {
      socket.end(`HTTP/1.1 ${out.status} ${await out.text()}\r\n\r\n`);
      return;
    }
    const room = out.room;
    const shim = out.upgradeTo.server;
    wss.handleUpgrade(req, socket, head, (real) => {
      shim.attach(real);
      real.on('message', (data, isBinary) => {
        const value = isBinary ? new Uint8Array(data).buffer : data.toString();
        const auto = room.state.autoResponse;
        if (auto && value === auto.request) return real.send(auto.response);
        void room.webSocketMessage(shim, value);
      });
      real.on('close', () => {
        const done = shim.readyState === 2;
        shim.readyState = 3;
        if (!linger) for (const r of rooms.values()) r.state.sockets.delete(shim);
        // A close the room started is already over for it, as on Cloudflare.
        if (!done || !linger) void room.webSocketClose(shim);
      });
    });
  });
  await new Promise((r) => server.listen(port, host, r));
  const url = `http://localhost:${server.address().port}`;
  return {
    url,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// Run on its own: node test/remote/relay-shim.mjs <secret> [port]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const relay = await startRelay({ secret: process.argv[2], port: Number(process.argv[3] ?? 0) });
  console.log(relay.url);
}
