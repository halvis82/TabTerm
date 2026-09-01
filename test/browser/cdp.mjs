// A minimal Chrome DevTools Protocol client.
//
// Small on purpose. Puppeteer would do this and bring a second Chrome download, a version
// coupling, and a dependency that has to be trusted, for a handful of methods: open a tab,
// evaluate an expression, send a key. The whole client is below.
import { WebSocket } from 'ws';

const PORT = process.env.TT_CDP_PORT ?? '9223';
const BASE = `http://127.0.0.1:${PORT}`;

export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];

  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  return {
    ready,
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        // A CDP call that never answers would hang a suite with no indication of which call.
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 15000).unref?.();
      });
    },
  };
}

/**
 * Evaluate an expression in a page and return its value.
 *
 * `awaitPromise` is on, so a suite can await something in the page without polling for it.
 */
export async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

export async function listTargets() {
  const response = await fetch(`${BASE}/json/list`);
  return response.json();
}

/** Open a tab and return its target, once it has a debugger URL to attach to. */
export async function newTab(url) {
  const response = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`could not open a tab: ${response.status}`);
  return response.json();
}

/**
 * Close a tab.
 *
 * Sessions outliving a suite was fixed by ending them; the tabs were left open, and a run of
 * two dozen suites therefore ended with dozens of live pages competing for the same machine.
 * The suites that run last then failed on timing that was fine when they ran alone.
 */
export async function closeTab(id) {
  try {
    await fetch(`${BASE}/json/close/${id}`);
  } catch {
    // Already gone, which is the outcome this wanted anyway.
  }
}

/** Shared assertion reporting, so every suite prints the same shape. */
export function reporter() {
  let failures = 0;
  return {
    ok(label, passed, detail = '') {
      if (!passed) failures++;
      console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
    },
    skip(label, why) {
      console.log(`  SKIP  ${label}${why ? '  ' + why : ''}`);
    },
    done() {
      console.log(failures === 0 ? '\n  all checks passed' : `\n  ${failures} failed`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
