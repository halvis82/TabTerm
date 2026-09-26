// Shared driving helpers, so each suite is about what it checks rather than about CDP.
import { closeTab, connect, evaluate, newTab, sleep } from './cdp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const root = new URL('../../', import.meta.url);
export const EXT_ID = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).tabterm
  .extensionId;

/** Open a terminal page and wait for it to attach to a session. */
/**
 * Every terminal a suite opened, so it can end them.
 *
 * Sessions outlive the daemon now, so a suite that walks away leaves shells running on the
 * machine forever. They accumulated into the hundreds before anybody noticed, because nothing
 * in a passing test run says "and twenty processes are still here".
 */
const opened = [];

/** End every session these tests started, and close their tabs. */
export async function finish() {
  for (const { client } of opened) {
    /**
     * Bounded as well as caught.
     *
     * A page that has gone does not answer and does not fail either: the request simply never
     * settles, `catch` never runs, and the suite ends on an unsettled promise with an exit code
     * that says nothing about the checks it passed. Suites that close their own tab are now an
     * ordinary thing rather than a special case.
     */
    await Promise.race([
      evaluate(client, `window.__tabterm?.endSessions?.()`).catch(() => undefined),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }
  await sleep(300);
  // And close the pages. Ending the sessions was not enough: a run of two dozen suites left
  // dozens of live pages open, and the suites that ran last failed on timing that was fine when
  // they ran alone.
  for (const { tab } of opened) {
    /**
     * Bounded, and forgiving.
     *
     * A tab that closed itself neither needs closing nor answers a request to close: the call
     * hangs rather than failing, and a suite whose subject is the tab going away then ends with
     * an unsettled promise and an exit code that looks nothing like the checks it passed.
     */
    await Promise.race([
      closeTab(tab.id).catch(() => undefined),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
  opened.length = 0;
  await sleep(300);
}

export async function openTerminal(query = '') {
  const tab = await newTab(`chrome-extension://${EXT_ID}/terminal.html${query}`);
  const client = connect(tab.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  // Input events go to the active target. With several tabs open in one headless browser, a
  // newly opened one is not automatically it, and every keystroke is silently discarded --
  // the page looks perfectly healthy and simply never receives anything.
  await client.send('Page.bringToFront');
  opened.push({ client, tab });
  /**
   * The page being alive is what every suite needs. A prompt is what most of them need.
   *
   * A tab used to be handed over after twenty seconds whether or not anything had loaded, so a
   * suite failed on `Cannot read properties of undefined`, naming whichever hook it reached for
   * first, which had nothing to do with what it was checking. That is worth refusing outright.
   *
   * A prompt is not, because a tab is not always opened onto a terminal: a workspace whose
   * session has ended opens onto a page that says so, and demanding a prompt there refused a tab
   * that was working exactly as intended. So the page is required and the prompt is waited for.
   */
  const alive = await waitFor(client, 'Boolean(window.__tabterm)', 45000);
  if (!alive) throw new Error('the tab never booted: no page hook after 45s');
  await ready(client, 45000);
  return { client, tab };
}

/**
 * Wait until the tab actually has a terminal with a prompt in it.
 *
 * This replaced a flat four second sleep, which was the single largest fixed wait in the run and
 * was wrong in both directions: usually far longer than needed, and occasionally not long enough
 * on a busy machine, which produced failures that looked like product bugs.
 *
 * The condition is the real one: a pane exists, and something has been printed into it. A prompt
 * is the first thing a shell prints, so its arrival is the moment the tab is usable.
 */
export async function ready(client, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await evaluate(
      client,
      `(() => {
         const hook = window.__tabterm;
         if (!hook || hook.paneIds().length === 0) return '';
         return hook.readScreen() ?? '';
       })()`,
    );
    if (String(answer).trim() !== '') return true;
    if (Date.now() > deadline) return false;
    await sleep(120);
  }
}

/**
 * Wait for something outside the browser: a process appearing, a port answering, a file landing.
 *
 * The counterpart to `waitFor`, for the suites that kill the daemon or the PTY host and then
 * need to know it came back. Those were the slowest suites in the run and every second of it was
 * a fixed sleep long enough to cover the worst case on a busy machine.
 */
/**
 * The daemon and PTY host belonging to **this run**, never whatever is on the machine.
 *
 * A suite that kills a process has to be certain which one, and `ps` does not show a process's
 * environment, so the temporary home cannot be matched on a command line. Both are found by
 * something only this installation has: the daemon by the pid the runner spawned, the host by
 * whoever is holding this installation's socket.
 *
 * Without a test installation these return null and the suites say so rather than reaching for
 * a person's daemon. This is not tidiness: a sweep that was not this careful ended a real
 * terminal.
 */
export function ownDaemonPid() {
  /**
   * Found by the port it is listening on, not by a pid recorded earlier.
   *
   * The runner restarts its daemon when it dies, the way launchd does for the real one, so a
   * pid noted at startup is stale the moment anything has killed it once. The port belongs to
   * this installation and nothing else, so whoever holds it is ours.
   */
  const port = Number(process.env.TT_DAEMON_PORT);
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const out = execFileSync('lsof', ['-t', `-i`, `:${String(port)}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number(out.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function ownHostPid() {
  /**
   * From this installation's own lock file, which the host writes its pid into.
   *
   * Exact, and it cannot name anybody else's host: the lock lives under the temporary home the
   * runner made. `pkill -f pty-host.mjs` matched every host on the machine, which is every
   * terminal a person has open, and was the single most destructive line here.
   */
  const home = process.env.TT_DAEMON_HOME;
  if (!home) return null;
  try {
    /**
     * Read from the pointer the daemon writes, not from a path assembled here.
     *
     * The lock is not always in the state directory. A unix socket path is capped at about a
     * hundred bytes, and the temporary home this runner invents is long enough to push it over,
     * so the host moves to the temporary directory and the daemon writes down where it went.
     * Assembling the path here instead is how this helper found nothing for weeks while the
     * checks that needed it sat disabled.
     */
    const pointer = `${home}/.local/state/tabterm/ptyhost.where`;
    const lockPath = readFileSync(pointer, 'utf8').trim().split('\n')[1];
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // A lock left by a host that has died names a pid that is not there any more.
    return pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Is a pid still there? */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(check, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      // Not yet. A check that throws is a check that is not satisfied.
    }
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/**
 * Wait for a condition in the page, rather than for a length of time.
 *
 * Every fixed sleep is a guess that is too long when things go well and too short when they do
 * not. Anything that can be expressed as a question about the page should be asked repeatedly
 * instead. Returns false on timeout so a check can report what it was waiting for.
 */
export async function waitFor(client, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await evaluate(
      client,
      `(() => { try { return !!(${expression}); } catch { return false; } })()`,
    );
    if (answer === true || answer === 'true') return true;
    if (Date.now() > deadline) return false;
    await sleep(90);
  }
}

/**
 * Click the way a hand does: press, then release.
 *
 * `element.click()` dispatches a click directly and never produces the mousedown before it. The
 * pane menu dismissed itself on mousedown, so pressing an entry removed the button before the
 * release, and a click is only dispatched when press and release land on the same element. Every
 * entry was therefore dead to a real mouse, and every test passed, because they all used
 * `.click()`.
 *
 * Anything driven by a pointer is clicked through here now.
 */
export async function realClick(client, selector, text) {
  // An empty answer rather than the string "null": `JSON.parse('null')` is a valid parse that
  // yields null, so a not-found check against a string never fired.
  const answer = String(
    await evaluate(
      client,
      `(() => {
         const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
         // Matched on the element's own first text node as well as its whole text, because a
         // control that carries a badge or a shortcut has more text in it than its label.
         //
         // Exact first, then a substring. Exact has to come first or a label that is a prefix
         // of a longer one would be reachable only by luck. The substring fallback exists for
         // rows whose text is mostly content: a resume row is a whole pasted paragraph with a
         // few identifying words in it, and there is no exact string to ask for.
         const el = ${
           text === undefined
             ? 'all[0]'
             : `all.find((x) => x.textContent === ${JSON.stringify(text)} || x.firstChild?.textContent === ${JSON.stringify(text)}) ?? all.find((x) => (x.textContent ?? '').includes(${JSON.stringify(text)}))`
         };
         if (!el) return '';
         /**
          * Scrolled into view first, and the answer checked against what is actually at the
          * point.
          *
          * A control below the fold has a bounding box off screen, so the click landed on
          * whatever happened to be at those coordinates and the test reported a press that
          * never reached the control. That has now produced a wrong diagnosis three times: the
          * launcher chips, the pane chooser rows, and the resume rows.
          */
         el.scrollIntoView({ block: 'center' });
         const r = el.getBoundingClientRect();
         const x = (r.left + r.right) / 2;
         const y = (r.top + r.bottom) / 2;
         if (!el.contains(document.elementFromPoint(x, y))) return '';
         return JSON.stringify({ x, y });
       })()`,
    ),
  );
  if (answer === '') return false;
  const where = JSON.parse(answer);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(where.x),
      y: Math.round(where.y),
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(250);
  return true;
}

/** Open a pane's context menu with a real right click. */
export async function openPaneMenu(client, x = 80, y = 90) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'right', clickCount: 1 });
  }
  await sleep(350);
}

export const focusPane = (client) =>
  evaluate(client, `document.querySelector('.pane.focused .xterm-helper-textarea')?.focus()`);

/** Type text and submit it, the way a person does. */
export async function type(client, text, { submit = true } = {}) {
  await focusPane(client);
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
    await sleep(4);
  }
  if (submit) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
  }
}

/**
 * Press a key with modifiers.
 *
 * `rawKeyDown`, not `char`. A `char` event is not a keydown, so xterm never turns it into a
 * control sequence: Ctrl+C sent as a char does nothing at all. That mistake cost time three
 * separate times before it was written down here.
 *
 * modifiers: 1 alt, 2 ctrl, 4 meta, 8 shift.
 */
export async function press(
  client,
  key,
  code,
  modifiers = 0,
  keyCode = 0,
  { focus = 'pane' } = {},
) {
  // Focus decides where the key lands. Terminal keys need the pane; palette keys must not steal
  // focus away from the palette input, or they are delivered to the shell instead and the
  // palette looks unresponsive.
  if (focus === 'pane') await focusPane(client);
  for (const type_ of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type: type_,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }
}

/** Ctrl+C, which needs a real keydown to become an interrupt. */
export const interrupt = (client) => press(client, 'c', 'KeyC', 2, 67);

/** Open the command palette. */
// Option+Command+P: Command Shift P is Chrome's print dialog, which the page never sees.
// Command+K belongs to the command panel.
export const openPalette = (client) => press(client, 'p', 'KeyP', 5, 80);

/** A key aimed at the palette, which owns focus while it is open. */
export const pressInPalette = (client, key, code, modifiers = 0, keyCode = 0) =>
  press(client, key, code, modifiers, keyCode, { focus: 'none' });

/** Read the terminal buffer, which WebGL rendering puts out of the DOM's reach. */
export const readScreen = (client, paneId) =>
  evaluate(client, `window.__tabterm?.readScreen(${paneId ? JSON.stringify(paneId) : ''}) ?? ''`);

export const paneCount = (client) => evaluate(client, `document.querySelectorAll('.pane').length`);

/** Query the launcher, which is where most contributed UI shows up. */
export const launcherSections = (client) =>
  evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.launcher-heading')].map(h => h.textContent))`,
  ).then((s) => JSON.parse(s ?? '[]'));

export async function launcherSection(client, heading) {
  const raw = await evaluate(
    client,
    `(() => {
      const wrap = [...document.querySelectorAll('.launcher-section')].find(
        s => (s.querySelector('.launcher-heading')?.textContent ?? '').includes(${JSON.stringify(heading)}));
      return JSON.stringify(wrap ? { found: true, text: wrap.textContent } : { found: false });
    })()`,
  );
  return JSON.parse(raw ?? '{"found":false}');
}

/**
 * How many pixels in a region are not the background.
 *
 * Pixels, because a buffer is not a screen. "The prompt is gone from the box at the bottom" was
 * reported three times and called fixed twice, and both fixes were checked by reading the
 * terminal buffer. The text was in the buffer every time. It was drawn at the top of a
 * full-height terminal, behind the opaque start screen, and the box at the bottom was showing
 * row 24 of a screen whose only line was row 1. Nothing that reads text could have caught it.
 *
 * The PNG is decoded here rather than by a dependency: a screenshot from Chrome is 8-bit,
 * non-interlaced, and either RGB or RGBA, which is a short and completely defined problem.
 */
export async function inkIn(client, rect, { threshold = 26 } = {}) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  const image = decodePng(Buffer.from(data, 'base64'));
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(image.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.round(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return { ink: 0, sampled: 0 };

  /**
   * The background is taken from the region itself, as its most common color.
   *
   * Naming a hex value here would be a second copy of the theme, and would start lying the first
   * time anybody changed it.
   */
  const counts = new Map();
  const at = (x, y) => {
    const i = (y * image.width + x) * image.channels;
    return (image.pixels[i] << 16) | (image.pixels[i + 1] << 8) | image.pixels[i + 2];
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const rgb = at(x, y);
      counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
    }
  }
  let background = 0;
  let best = -1;
  for (const [rgb, n] of counts) {
    if (n > best) {
      best = n;
      background = rgb;
    }
  }
  const br = (background >> 16) & 255;
  const bg = (background >> 8) & 255;
  const bb = background & 255;

  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * image.channels;
      const d =
        Math.abs(image.pixels[i] - br) +
        Math.abs(image.pixels[i + 1] - bg) +
        Math.abs(image.pixels[i + 2] - bb);
      if (d > threshold) ink++;
    }
  }
  return { ink, sampled: (x1 - x0) * (y1 - y0) };
}

/** The rectangle of an element, in the page's own coordinates, which is what a clip needs. */
export async function boxOf(client, selector) {
  const raw = await evaluate(
    client,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return 'null';
       const b = el.getBoundingClientRect();
       return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }); })()`,
  );
  return raw === 'null' ? null : JSON.parse(raw);
}

/**
 * Drag one element onto another, the way a hand does it.
 *
 * A real drag rather than three `DragEvent`s constructed in the page. A constructed drag proves
 * that the handlers work if they are called, which is the half that was never in doubt: whether
 * the browser starts a drag at all depends on `draggable`, on what the press landed on, and on the
 * page not swallowing the press first, and none of that is exercised by dispatching events by
 * hand. Chrome hands the drag to the debugger instead of to its own compositor once drags are
 * intercepted, so the payload the page put in `dataTransfer` comes back here and goes into the
 * drop unchanged.
 *
 * Returns the empty string when the drag happened, and otherwise why it did not, which is a real
 * answer and not a broken test: an element that refuses to be dragged is exactly what this looks
 * like, and a suite reporting that has to be able to say which of the reasons it was.
 */
export async function dragOnto(client, fromSelector, toSelector, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    /*
     * Tried again when no drag begins, because that is usually the list having moved.
     *
     * `Running now` redraws whenever anything on the machine starts or finishes, and under a full
     * run that is constantly. A redraw between working out where to press and pressing there
     * replaces the element under the pointer, and a press on an element that no longer exists
     * starts nothing. The page refuses to redraw **during** a drag for the same reason, which
     * leaves only this window. An element that genuinely cannot be dragged still answers false,
     * after trying.
     */
    const why = await oneDrag(client, fromSelector, toSelector);
    if (why === '' || attempt >= attempts) return why;
    await sleep(500);
  }
}

async function oneDrag(client, fromSelector, toSelector) {
  /*
   * Scrolled into view and checked against what is actually at the point, the same care a real
   * click takes here. The list this drags in scrolls once there are a few sessions on it, and a
   * card below the fold has a box that is off screen: the press then lands on whatever happens to
   * be at those coordinates and the drag never starts, which reads as the feature being broken.
   */
  const answer = String(
    await evaluate(
      client,
      `(() => {
         const from = document.querySelector(${JSON.stringify(fromSelector)});
         const to = document.querySelector(${JSON.stringify(toSelector)});
         if (!from) return 'no:no source element';
         if (!to) return 'no:no target element';

         /* The middle of the source, when the source is really there. */
         const grabPoint = () => {
           const r = from.getBoundingClientRect();
           const p = {
             x: Math.round((r.left + r.right) / 2),
             y: Math.round((r.top + r.bottom) / 2),
           };
           return from.contains(document.elementFromPoint(p.x, p.y)) ? p : null;
         };
         /*
          * A point on the target that is actually on screen, sampled across its box rather than
          * taken from its middle: a target that is half out of the window still has somewhere to
          * drop on, and its middle may be the half that is gone.
          */
         const dropPoint = () => {
           const r = to.getBoundingClientRect();
           for (const fy of [0.5, 0.3, 0.7, 0.1, 0.9]) {
             for (const fx of [0.5, 0.2, 0.8]) {
               const x = Math.round(Math.min(innerWidth - 2, Math.max(2, r.left + r.width * fx)));
               const y = Math.round(Math.min(innerHeight - 2, Math.max(2, r.top + r.height * fy)));
               if (to.contains(document.elementFromPoint(x, y))) return { x, y };
             }
           }
           return null;
         };

         /*
          * Both ends have to be on screen at once, and scrolling one into view moves the other.
          * So: as they are, then with the source centred, then with the target centred. The list
          * scrolls as soon as there are a few sessions on it, which is the ordinary case rather
          * than the awkward one.
          */
         for (const scroll of [
           () => {},
           () => from.scrollIntoView({ block: 'center' }),
           () => to.scrollIntoView({ block: 'center' }),
           () => to.scrollIntoView({ block: 'nearest' }),
         ]) {
           scroll();
           const start = grabPoint();
           const end = start === null ? null : dropPoint();
           if (start && end) return JSON.stringify({ start, end });
         }
         const r1 = from.getBoundingClientRect();
         const r2 = to.getBoundingClientRect();
         return 'no:the two ends are never on screen together ' + JSON.stringify({
           from: [Math.round(r1.top), Math.round(r1.bottom)],
           to: [Math.round(r2.top), Math.round(r2.bottom)],
           window: innerHeight,
         });
       })()`,
    ),
  );
  if (answer.startsWith('no:') || answer === '') return answer || 'no:no answer at all';
  const { start, end } = JSON.parse(answer);

  let payload;
  const caught = new Promise((resolve) => {
    client.on((message) => {
      if (message.method !== 'Input.dragIntercepted' || payload) return;
      payload = message.params?.data;
      resolve();
    });
    setTimeout(resolve, 4000);
  });

  await client.send('Input.setInterceptDrags', { enabled: true });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  // Several small moves rather than one jump: a drag is started by the movement, and Chrome needs
  // to see the press travel past its own threshold before it will begin one.
  for (const step of [4, 12, 30, 60]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + step,
      y: start.y + Math.round((step * (end.y - start.y)) / Math.max(1, end.x - start.x || 1)),
      button: 'left',
      buttons: 1,
    });
    await sleep(40);
  }
  await caught;

  if (!payload) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await client.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
    return 'no:the browser never began a drag';
  }

  /*
   * Where the target is **now**, not where it was before the press.
   *
   * The point was worked out before the drag began, and the list is rebuilt whenever anything on
   * the machine starts or finishes. Under a full run a card had moved by the time the drop was
   * dispatched, so the drop landed on whatever had taken that place: once on a group, where the
   * product correctly does nothing, and the check reported that the session could not be dragged
   * out of its tab. Asked again here, from the same selector, which costs one evaluation.
   */
  const fresh = String(
    await evaluate(
      client,
      `(() => {
         const to = document.querySelector(${JSON.stringify(toSelector)});
         if (!to) return '';
         const r = to.getBoundingClientRect();
         for (const fy of [0.5, 0.3, 0.7]) {
           for (const fx of [0.5, 0.2, 0.8]) {
             const x = Math.round(Math.min(innerWidth - 2, Math.max(2, r.left + r.width * fx)));
             const y = Math.round(Math.min(innerHeight - 2, Math.max(2, r.top + r.height * fy)));
             if (to.contains(document.elementFromPoint(x, y))) return JSON.stringify({ x, y });
           }
         }
         return '';
       })()`,
    ),
  );
  const at = fresh === '' ? end : JSON.parse(fresh);

  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await client.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: payload });
    await sleep(60);
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: at.x,
    y: at.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await client.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
  await sleep(300);
  return '';
}

/** Enough of PNG to read a screenshot: 8-bit, non-interlaced, RGB or RGBA. */
function decodePng(buffer) {
  let at = 8; // past the signature
  let width = 0;
  let height = 0;
  let channels = 4;
  const parts = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      if (depth !== 8 || body[12] !== 0) throw new Error(`unexpected PNG: depth ${depth}`);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (channels === 0) throw new Error(`unexpected PNG color type ${colorType}`);
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  // Standard PNG filtering, undone one scanline at a time against the line above.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

export { sleep, evaluate, newTab, connect };
