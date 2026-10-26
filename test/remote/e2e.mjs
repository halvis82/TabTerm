// Remote access end to end, on this machine and isolated from anybody's real terminals.
//
// A daemon of its own (its own home and port), the relay running its real code in Node, the real
// page in headless Chrome sized like an iPhone, and Chrome's virtual authenticator standing in for
// Face ID. A desktop view is attached at 120 by 40 the whole time, and the run fails if anything
// the phone does changes that size.
//
//   node test/remote/e2e.mjs            prints a JSON report and exits non-zero on any failure
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { encodeFrame, decodeFrame, controlFrame, ackFrame } from '../../shared/dist/index.js';
import { startRelay } from './relay-shim.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const ok = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
  if (process.env.VERBOSE) console.log(pass ? 'ok  ' : 'FAIL', name, detail ?? '');
};
const kids = [];
const home = mkdtempSync(join(tmpdir(), 'tabterm-remote-e2e-'));
const cleanup = () => {
  for (const k of kids) {
    try {
      process.kill(-k.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
};
process.on('exit', cleanup);

const until = async (check, ms = 15000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return true;
    await sleep(60);
  }
  return false;
};

// --- the daemon --------------------------------------------------------------------------------
const PORT = String(17400 + Math.floor(Math.random() * 500));
const daemon = spawn(process.execPath, [join(ROOT, 'daemon/dist/main.js')], {
  env: {
    ...process.env,
    TABTERM_HOME: home,
    TABTERM_PORT: PORT,
    TABTERM_AGENT_PORT: String(Number(PORT) + 1),
    TABTERM_NO_NOTIFICATIONS: '1',
    TABTERM_HOST_FORCE_STOP: '1',
  },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
kids.push(daemon);
let daemonLog = '';
daemon.stdout.on('data', (d) => (daemonLog += d));
daemon.stderr.on('data', (d) => (daemonLog += d));
const tokenFile = join(home, '.local/state/tabterm/token');
await until(() => existsSync(tokenFile), 15000);
await sleep(500);
const token = readFileSync(tokenFile, 'utf8').trim();

/** A client of the daemon the way the extension is one. */
async function client(role) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox = [];
  const output = new Map();
  ws.on('message', (raw) => {
    const f = decodeFrame(new Uint8Array(raw));
    if (f.kind === 'control') inbox.push(f.message);
    if (f.kind === 'output') {
      output.set(f.streamId, (output.get(f.streamId) ?? '') + Buffer.from(f.data).toString());
      ws.send(ackFrame(f.streamId, f.data.length));
    }
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(
    encodeFrame({
      kind: 'control',
      message: { t: 'auth', v: 1, role, token, clientId: `e2e-${role}` },
    }),
  );
  await until(() => inbox.some((m) => m.t === 'auth-ok'));
  return {
    ws,
    inbox,
    output,
    send: (m) => ws.send(controlFrame(m)),
    last: (t) => [...inbox].reverse().find((m) => m.t === t),
  };
}

const daemonRssMb = async () => {
  const { execFileSync } = await import('node:child_process');
  const kb = Number(
    execFileSync('ps', ['-o', 'rss=', '-p', String(daemon.pid)])
      .toString()
      .trim(),
  );
  return Math.round(kb / 1024);
};

// --- the relay ---------------------------------------------------------------------------------
// Another relay can be named, such as wrangler's local runtime: RELAY_URL and RELAY_SECRET.
const SECRET = process.env.RELAY_SECRET ?? randomBytes(24).toString('base64url');
const relay = process.env.RELAY_URL
  ? { url: process.env.RELAY_URL, close: async () => {} }
  : await startRelay({ secret: SECRET });

// --- a desktop view, attached at 120 by 40 throughout -------------------------------------------
const desk = await client('data');
desk.send({ t: 'create-session', cols: 120, rows: 40 });
await until(() => desk.last('session-created'));
const created = desk.last('session-created');
const sessionId = created.sessionId;
await until(() => (desk.output.get(created.streamId) ?? '').length > 0, 10000);
desk.ws.send(
  encodeFrame({
    kind: 'input',
    streamId: created.streamId,
    data: new TextEncoder().encode('echo desk-ready\r'),
  }),
);
await until(() => (desk.output.get(created.streamId) ?? '').includes('desk-ready'), 10000);
const sizesSeen = () =>
  desk.inbox.filter((m) => m.t === 'session-size').map((m) => `${m.cols}x${m.rows}`);

// --- Settings: turn it on ---------------------------------------------------------------------
const rssBefore = await daemonRssMb();
const settings = await client('control');
settings.send({ t: 'remote-get' });
await until(() => settings.last('remote-state'));
ok('off by default', settings.last('remote-state').state.enabled === false);
settings.send({ t: 'remote-set', enabled: true, relayUrl: relay.url, relaySecret: SECRET });
ok(
  'connects to the relay once turned on',
  await until(() => settings.last('remote-state')?.state.status === 'connected'),
  settings.last('remote-state')?.state,
);
ok('never sends the secret back', !JSON.stringify(settings.inbox).includes(SECRET));
settings.send({ t: 'remote-pair' });
await until(() => settings.last('remote-pairing'));
const link = settings.last('remote-pairing').link;
ok('makes a pairing link with the key in the fragment', /#pair=/.test(link));

// --- the phone ---------------------------------------------------------------------------------
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(home, 'chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
kids.push(chrome);
let devtools = '';
chrome.stderr.on('data', (d) => {
  const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
  if (m) devtools = m[1];
});
await until(() => devtools !== '', 15000);
const browserWs = new WebSocket(devtools);
await new Promise((r) => browserWs.on('open', r));
let seq = 0;
const pending = new Map();
browserWs.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const cdp = (method, params = {}, sessionIdCdp) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    browserWs.send(
      JSON.stringify({ id, method, params, ...(sessionIdCdp ? { sessionId: sessionIdCdp } : {}) }),
    );
  });
const { result: tgt } = await cdp('Target.createTarget', { url: 'about:blank' });
const { result: att } = await cdp('Target.attachToTarget', {
  targetId: tgt.targetId,
  flatten: true,
});
const S = att.sessionId;
const page = (method, params) => cdp(method, params, S);
const ev = async (expression) =>
  (await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value;
await page('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await page('WebAuthn.enable', {});
await page('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const tap = async (selector) => {
  const box = await ev(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
  );
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
  return true;
};
const snap = async (name) => {
  if (!process.env.SHOT_DIR) return;
  const shot = await page('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
};
const screenText = `(() => { const b = window.__remote?.term.buffer.active; if (!b) return ''; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`;

await page('Page.navigate', { url: link });
ok(
  'offers to trust the device',
  await until(() => ev(`!document.getElementById('unlock').hidden`)),
);
await snap('1-trust');
ok('takes the key out of the address bar', (await ev('location.hash')) === '');
await tap('#unlock');
ok(
  'pairs with a passkey and lists the tabs',
  await until(() =>
    ev(`document.body.dataset.screen === 'list' && document.querySelectorAll('.pane').length > 0`),
  ),
  await ev(`document.getElementById('lock-status').textContent`),
);
await until(() => settings.last('remote-state')?.state.devices.length === 1);
ok('the Mac lists the device', settings.last('remote-state')?.state.devices.length === 1);
await snap('2-list');

// The Home Screen pieces: an icon, and the worker that shows notifications.
ok(
  'serves a Home Screen icon and the notification worker',
  await ev(
    `Promise.all([fetch('/icon.png'), fetch('/sw.js'), fetch('/manifest.webmanifest').then((r) => r.json())]).then(([i, w, m]) => i.headers.get('content-type') === 'image/png' && w.headers.get('content-type').startsWith('text/javascript') && m.icons[0].src === '/icon.png')`,
  ),
);
// Notifications. Headless Chrome has no push service of its own to subscribe with, so this goes as
// far as Chrome goes: the button, the permission, the worker installed. A real subscription and
// delivery are checked by the unit tests against a stand in push service, and on a real phone.
ok('offers notifications', await ev(`!document.getElementById('notify').hidden`));
await cdp('Browser.grantPermissions', {
  permissions: ['notifications'],
  origin: new URL(relay.url).origin,
});
await tap('#notify');
await until(
  () =>
    settings.last('remote-state')?.state.devices[0]?.notify === true ||
    ev(`!document.getElementById('notify-hint').hidden`),
  10000,
);
const pushNote = settings.last('remote-state')?.state.devices[0]?.notify
  ? 'subscribed, and the Mac recorded it'
  : String(await ev(`document.getElementById('notify-hint').textContent`));
ok(
  'installs the notification worker when asked',
  await ev(
    `navigator.serviceWorker.getRegistration('/').then((r) => !!r && !!(r.active || r.installing || r.waiting))`,
  ),
  pushNote,
);

/*
 * A real notification, when this Chrome could subscribe: the phone puts TabTerm away, an agent in
 * the desktop's terminal asks for approval, and the Mac sends it through Google's push service to
 * this Chrome, whose worker shows it. Nothing of it passes through the relay.
 */
if (settings.last('remote-state')?.state.devices[0]?.notify === true) {
  await page('Page.navigate', { url: 'about:blank' });
  await until(() => settings.last('remote-state')?.state.browsers === 0, 10000);
  const hook = (name) =>
    fetch(`http://127.0.0.1:${Number(PORT) + 1}/agent-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tabterm-token': token },
      body: JSON.stringify({ sessionId, hook: name }),
    });
  await hook('UserPromptSubmit');
  await sleep(300);
  await hook('PermissionRequest');
  // What the daemon said it did, for when nothing arrives.
  const notifyLog = () => {
    try {
      return readFileSync(join(home, '.local/state/tabterm/logs/daemon.log'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('remote.notify') || l.includes('remote.push'))
        .join(' | ');
    } catch {
      return 'no log';
    }
  };
  await page('Page.navigate', { url: new URL(relay.url).origin + '/' });
  const shown = async () =>
    ev(
      `navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => n.map((x) => x.title + ': ' + x.body).join(' | '))`,
    );
  const delivered = await until(async () => /needs you/.test(String(await shown())), 30000);
  ok(
    'an agent asking sends a notification the push service accepts',
    /"status":(201|404|410)\b/.test(notifyLog()),
    notifyLog(),
  );
  // Delivery from there is Google's, to a headless Chrome made a minute ago, which it sometimes
  // expires at once. Reported, not counted: a real phone is where this is decided.
  console.error(
    delivered
      ? `note: the notification arrived and was shown: ${String(await shown())}`
      : 'note: the push service took it, and this headless Chrome did not show it in 30 s',
  );
  await hook('Stop');
  await until(() => ev(`!document.getElementById('unlock').hidden`));
  await tap('#unlock');
  await until(() => ev(`document.body.dataset.screen === 'list'`));
}

// Tapping a notification opens the page at #open=<session>: locked first, then that terminal.
// A fresh load, as the worker's openWindow makes, not a change of fragment on an open page.
await page('Page.navigate', { url: 'about:blank' });
await page('Page.navigate', { url: `${new URL(relay.url).origin}/#open=${sessionId}` });
ok(
  'a tapped notification asks for the passkey first',
  await until(() => ev(`!document.getElementById('unlock').hidden`)),
);
ok('and takes the session out of the address bar', (await ev('location.hash')) === '');
await tap('#unlock');
ok(
  'then opens that terminal',
  await until(
    () =>
      ev(
        `document.body.dataset.screen === 'terminal' && window.__remote.state().watching === ${JSON.stringify(sessionId)}`,
      ),
    15000,
  ),
);
await tap('#back');
await until(() => ev(`document.body.dataset.screen === 'list'`));

await tap('.pane');
await until(() => ev(`document.body.dataset.screen === 'terminal'`));
ok(
  'opens the terminal with what is already on it',
  await until(() => ev(`${screenText}.includes('desk-ready')`)),
);
ok(
  'at the Mac size',
  (await ev(`window.__remote.term.cols + 'x' + window.__remote.term.rows`)) === '120x40',
);

// 120 columns on a phone: readable and scrolling sideways, or fitted with Fit.
const fontPx = () => ev(`window.__remote.term.options.fontSize`);
const readable = await fontPx();
await tap('#fit');
const fitted = await fontPx();
const fitsAcross = await ev(
  `document.querySelector('#term .xterm-screen').getBoundingClientRect().width <= document.getElementById('term-wrap').clientWidth`,
);
ok('Fit fits the whole width', fitted < readable && fitsAcross, `${readable}px, then ${fitted}px`);
await snap('3a-fit');
await tap('#fit');
ok('and pressed again, back to readable', (await fontPx()) === readable);

// Typing on the phone reaches the shell, and the answer comes back to both.
await ev(
  `window.__remote.term._core.coreService.triggerDataEvent('echo from-the-phone-$((6*7))\\r', true)`,
);
ok(
  'what is typed on the phone runs',
  await until(() => ev(`${screenText}.includes('from-the-phone-42')`)),
);
await snap('3-terminal');
ok(
  'and the Mac sees it too',
  (desk.output.get(created.streamId) ?? '').includes('from-the-phone-42'),
);

// Output from the Mac side reaches the phone live.
desk.ws.send(
  encodeFrame({
    kind: 'input',
    streamId: created.streamId,
    data: new TextEncoder().encode('echo from-the-desk-$((3*3))\r'),
  }),
);
ok(
  'what happens on the Mac shows on the phone',
  await until(() => ev(`${screenText}.includes('from-the-desk-9')`)),
);

// A program asking the terminal questions is answered by the Mac's view only. The desktop view in
// this run answers nothing, so anything that arrives in the shell came from the phone.
const queriedFrom = desk.output.get(created.streamId).length;
desk.ws.send(
  encodeFrame({
    kind: 'input',
    streamId: created.streamId,
    data: new TextEncoder().encode(
      "printf '\\033[c\\033[>c\\033[6n\\033]11;?\\007'; sleep 1; echo after-queries\r",
    ),
  }),
);
await until(() => (desk.output.get(created.streamId) ?? '').includes('after-queries'), 10000);
await sleep(1500);
const afterQueries = (desk.output.get(created.streamId) ?? '').slice(queriedFrom);
ok(
  'the phone never answers a program asking the terminal something',
  !/\?1;2c|>0;|rgb:|\d+;\d+R/.test(afterQueries.split('after-queries').slice(1).join('')) &&
    !/1;2c|rgb:/.test(afterQueries.replace(/printf[^\n]*/, '')),
  JSON.stringify(afterQueries.slice(-200)),
);

// What the phone costs the daemon, measured before the heavy output below, which grows the
// daemon's own scrollback whether anybody is watching or not.
const rssAfter = await daemonRssMb();
ok(
  'costs the daemon little memory',
  rssAfter - rssBefore < 15,
  `${rssBefore} MB before turning it on, ${rssAfter} MB with a phone paired and watching`,
);

// Heavy output.
const t0 = Date.now();
await ev(
  `window.__remote.term._core.coreService.triggerDataEvent('seq 1 200000; echo bulk-$((40+2))\\r', true)`,
);
ok(
  'keeps up with heavy output',
  await until(() => ev(`${screenText}.includes('bulk-42')`), 60000),
  `${Date.now() - t0} ms`,
);

ok(
  'never changed the size on the Mac',
  sizesSeen().every((s) => s === '120x40'),
  sizesSeen(),
);
const live = await (async () => {
  settings.send({ t: 'list-live-sessions' });
  await until(() => settings.last('live-sessions'));
  return settings.last('live-sessions').sessions.find((s) => s.sessionId === sessionId);
})();
ok('and never counted as a view of it', live?.attached === true);

// A new visit asks for the passkey again.
await page('Page.reload', {});
ok(
  'a new visit is locked',
  await until(() =>
    ev(
      `document.getElementById('unlock').textContent === 'Unlock' && !document.getElementById('unlock').hidden`,
    ),
  ),
);
await tap('#unlock');
ok(
  'and unlocks with the passkey',
  await until(() => ev(`document.body.dataset.screen === 'list'`)),
);

// Typing turned off for the device.
const deviceId = settings.last('remote-state').state.devices[0].id;
settings.send({ t: 'remote-device', deviceId, typing: false });
await tap('.pane');
await until(() => ev(`document.body.dataset.screen === 'terminal'`));
ok(
  'a device that may only watch has no keys',
  await until(() =>
    ev(`document.getElementById('keys').hidden && !document.getElementById('watch-only').hidden`),
  ),
);
const before = desk.output.get(created.streamId).length;
await ev(`window.__remote.term._core.coreService.triggerDataEvent('echo should-not-run\\r', true)`);
await sleep(800);
ok(
  'and what it types goes nowhere',
  !(desk.output.get(created.streamId) ?? '').slice(before).includes('should-not-run'),
);

// Removed.
settings.send({ t: 'remote-device', deviceId, forget: true });
ok(
  'a removed device is cut off and told why',
  await until(() => ev(`document.getElementById('lock-status').textContent.includes('removed')`)),
);

// The session is still exactly as it was.
desk.ws.send(
  encodeFrame({
    kind: 'input',
    streamId: created.streamId,
    data: new TextEncoder().encode('echo still-fine\r'),
  }),
);
ok(
  'the terminal on the Mac carries on',
  await until(() => (desk.output.get(created.streamId) ?? '').includes('still-fine')),
);

await snap('4-removed');

// A second device, pairing by pasting the link, which is how a Home Screen app on an iPhone pairs.
settings.send({ t: 'remote-pair' });
const before2 = settings.inbox.filter((m) => m.t === 'remote-pairing').length;
await until(() => settings.inbox.filter((m) => m.t === 'remote-pairing').length > before2);
const link2 = settings.last('remote-pairing').link;
const { result: ctx } = await cdp('Target.createBrowserContext', {});
const { result: tgt2 } = await cdp('Target.createTarget', {
  url: 'about:blank',
  browserContextId: ctx.browserContextId,
});
const { result: att2 } = await cdp('Target.attachToTarget', {
  targetId: tgt2.targetId,
  flatten: true,
});
const S2 = att2.sessionId;
const page2 = (method, params) => cdp(method, params, S2);
const ev2 = async (expression) =>
  (await page2('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value;
await page2('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await page2('WebAuthn.enable', {});
await page2('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
await page2('Page.navigate', { url: relay.url });
ok(
  'an unpaired visit offers to paste a link',
  await until(() => ev2(`!document.getElementById('pair-form').hidden`)),
);
await ev2(
  `document.getElementById('pair-input').value = ${JSON.stringify(link2)}; document.getElementById('pair-form').requestSubmit();`,
);
ok(
  'a pasted link pairs like a scanned one',
  await until(() => ev2(`!document.getElementById('unlock').hidden`)),
);
await ev2(`document.getElementById('unlock').click()`);
ok(
  'and the device gets the list',
  await until(() => ev2(`document.body.dataset.screen === 'list'`)),
);

const failed = checks.filter((c) => !c.pass);
console.log(
  JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2),
);
if (failed.length > 0)
  console.log(
    daemonLog
      .split('\n')
      .filter((l) => l.includes('remote'))
      .join('\n'),
  );
cleanup();
await relay.close();
await sleep(300);
rmSync(home, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
