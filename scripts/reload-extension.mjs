#!/usr/bin/env node
// Ask the extension to reload itself.
//
// An extension's code on disk is not the code that is running: Chrome reads it when the
// extension is loaded and never again. Nothing outside Chrome can change that. There is no API,
// no file to touch, and no signal to send, and a Chrome without a debugging port cannot be
// driven at all. The only two ways are a person clicking reload on `chrome://extensions`, and
// the extension calling `chrome.runtime.reload()` on itself.
//
// So this asks it to. The daemon relays the request over the connection the extension already
// holds. Nothing here has any power over Chrome: if the extension is not running, nothing
// happens, and this says so.
//
// The terminals are untouched. They live in the PTY host, which is a different process that
// knows nothing about Chrome, and the tabs are put back by the worker after it restarts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const STATE = join(homedir(), '.local', 'state', 'tabterm');
const PORT = Number(process.env['TABTERM_PORT'] ?? 7377);
const PROTOCOL_VERSION = 1;

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

let token;
try {
  token = readFileSync(join(STATE, 'token'), 'utf8').trim();
} catch {
  console.log('  no token, so the daemon has never been paired. Nothing to ask.');
  process.exit(0);
}

const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}`);
/**
 * Whether anything was listening, which is the only outcome worth reporting.
 *
 * The daemon cannot tell us whether Chrome acted: the request is relayed to a browser that may
 * not be running. Saying "asked" rather than "reloaded" is the honest version of that.
 */
const done = (message, code = 0) => {
  console.log(message);
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  process.exit(code);
};

const timer = setTimeout(() => done('  daemon did not answer, so nothing was asked', 0), 4000);

ws.on('open', () => {
  ws.send(
    controlFrame({
      t: 'auth',
      v: PROTOCOL_VERSION,
      role: 'control',
      token,
      clientId: 'installer',
    }),
  );
});

ws.on('message', (raw) => {
  const message = decodeControl(new Uint8Array(raw));
  if (!message) return;
  if (message.t === 'auth-ok') {
    ws.send(controlFrame({ t: 'reload-extension' }));
    clearTimeout(timer);
    // A moment for the frame to leave before the socket closes under it.
    setTimeout(() => done('  asked the extension to reload itself'), 400);
  } else if (message.t === 'auth-fail') {
    clearTimeout(timer);
    done('  the daemon refused this token, so nothing was asked', 0);
  }
});

ws.on('error', () => {
  clearTimeout(timer);
  done('  no daemon listening, so nothing was asked', 0);
});
