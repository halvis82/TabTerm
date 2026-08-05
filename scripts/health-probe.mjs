#!/usr/bin/env node
// Health probe: connect to the daemon the way the extension does, and report what came back.
//
// Doctor can see that something is listening on the port. Only an authenticated connection can
// tell you whether the protocol version matches, whether the token is the right one, and how
// many sessions are alive. Those are exactly the failures that look identical from outside.
//
// Prints one JSON object. Never prints the token.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const STATE = join(homedir(), '.local', 'state', 'tabterm');
const PORT = Number(process.env['TABTERM_PORT'] ?? 7377);
const PROTOCOL_VERSION = 1;

const result = {
  connected: false,
  authenticated: false,
  serverVersion: null,
  sessionCount: null,
  database: null,
  error: null,
};

function readToken() {
  try {
    return readFileSync(join(STATE, 'token'), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Frame encoding, kept minimal on purpose so the probe does not depend on a build. */
function controlFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(body.length + 1);
  frame[0] = 0x00;
  body.copy(frame, 1);
  return frame;
}

function decodeControl(bytes) {
  if (bytes.length < 1 || bytes[0] !== 0x00) return null;
  try {
    return JSON.parse(Buffer.from(bytes.subarray(1)).toString('utf8'));
  } catch {
    return null;
  }
}

async function probeSocket(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}`);
    // A daemon that accepts the connection and then never answers is its own failure mode, and
    // without this the probe would hang instead of reporting it.
    const timer = setTimeout(() => {
      ws.close();
      resolve({ error: 'connected but no reply within 3s' });
    }, 3000);

    ws.on('open', () => {
      result.connected = true;
      ws.send(
        controlFrame({
          t: 'auth',
          v: PROTOCOL_VERSION,
          role: 'control',
          token,
          clientId: 'doctor',
        }),
      );
    });

    ws.on('message', (raw) => {
      const message = decodeControl(new Uint8Array(raw));
      if (!message) return;
      if (message.t === 'auth-ok') {
        clearTimeout(timer);
        result.authenticated = true;
        result.serverVersion = message.serverVersion ?? null;
        result.sessionCount = message.sessionCount ?? null;
        ws.close();
        resolve({});
      } else if (message.t === 'auth-fail') {
        clearTimeout(timer);
        ws.close();
        resolve({ error: `authentication refused: ${String(message.code)}` });
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: String(e.message ?? e) });
    });
  });
}

/** Whether the database is readable and internally consistent. */
function probeDatabase() {
  const file = join(STATE, 'tabterm.sqlite');
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const counts = {
      commands: db.prepare('SELECT COUNT(*) AS n FROM commands').get().n,
      recentDirs: db.prepare('SELECT COUNT(*) AS n FROM recent_dirs').get().n,
      savedItems: db.prepare('SELECT COUNT(*) AS n FROM saved_items').get().n,
      workspaces: db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n,
    };
    const version = db.prepare('SELECT MAX(version) AS v FROM migrations').get().v;
    db.close();
    return { ok: integrity.integrity_check === 'ok', schemaVersion: version, counts };
  } catch (e) {
    return { ok: false, error: String(e.message ?? e) };
  }
}

const token = readToken();
if (!token) {
  result.error = 'no token; run scripts/install.sh';
} else {
  const { error } = await probeSocket(token);
  if (error) result.error = error;
  result.database = probeDatabase();
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.authenticated ? 0 : 1);
