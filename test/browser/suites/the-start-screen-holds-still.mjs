// The start screen is not rebuilt over and over when the daemon comes back.
//
// A daemon restart is the one moment this screen is asked to rebuild itself from nothing: the
// socket drops, every answer it is holding is stale, and a new set arrives over a second or two.
// Each answer that arrives to a screen which is no longer expecting anything redraws the whole of
// it, and a redraw throws away and rebuilds every row and every folder suggestion on it. That is
// work nobody sees the benefit of, and it is done in front of somebody who is reading the list.
//
// Counted in drawings, which the screen already records, rather than in layout shifts.
//
// Layout shift was tried first and is the wrong instrument here, in a way worth writing down: a
// redraw removes the suggestion list and appends the new one in the same function, so nothing is
// ever painted in between. But a probe that measures anything during the change -- a
// `MutationObserver` that calls `getBoundingClientRect`, say -- forces the browser to lay the page
// out at that midpoint, and the observer then faithfully reports a 0.053 shift that no eye could
// have seen and that does not happen when nobody is measuring. The instrument was creating the
// reading. Counting drawings cannot do that: it asks afterwards, and the count is the thing that
// matters anyway.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  waitUntil,
  ownDaemonPid,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
// Settled, so what is measured is the restart and not the first drawing.
await sleep(2500);

const rows = async () =>
  Number(await evaluate(client, `document.querySelectorAll('.launcher-row').length`));
const drawings = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.renderLog())')));

const before = await rows();
r.ok('the start screen has rows on it to begin with', before > 0, `${String(before)} rows`);
/*
 * Marked by when the last drawing happened, not by how many there have been.
 *
 * The screen keeps its last twenty drawings and drops the rest, so counting them and taking
 * everything after that count works only while the page has drawn fewer than twenty times. Under a
 * full run it has drawn many more, the count stops rising, and everything after it is nothing at
 * all: this read `0 drawings` and failed a reconnect that had worked perfectly.
 */
const drawnBefore = (await drawings()).at(-1)?.at ?? 0;

/*
 * Counted on every change to the page rather than on a clock.
 *
 * A timer is the obvious instrument and the wrong one: both `setInterval` and
 * `requestAnimationFrame` are throttled hard in a tab that is not in front, which is what a tab
 * under a suite runner usually is, so a blank shorter than a second could pass between two samples
 * and be recorded as never having happened. Changes drive this one, so a list that empties is seen
 * at the moment it empties. Counted only, never measured: asking for a rectangle here would force
 * the browser to lay out the page mid-change, which is the mistake described at the top.
 */
await evaluate(
  client,
  `(() => {
     window.__low = document.querySelectorAll('.launcher-row').length;
     window.__seen = 0;
     window.__watching = new MutationObserver(() => {
       const n = document.querySelectorAll('.launcher-row').length;
       window.__seen++;
       if (n < window.__low) window.__low = n;
     });
     window.__watching.observe(document.body, { childList: true, subtree: true });
   })()`,
);

// Observe the page's new authenticated socket, not a particular redraw reason. Unchanged
// answers can be deduplicated, so a successful reconnect need not draw a `state` update.
let reauthenticated = false;
let authenticatedSocket = null;
const listAnswers = new Set();
const listMessages = new Set(['live-sessions', 'restorable-workspaces', 'resumable-sessions']);
client.on((event) => {
  if (event.method !== 'Network.webSocketFrameReceived') return;
  const frame = event.params?.response;
  if (frame?.opcode !== 2) return;
  const bytes = Buffer.from(frame.payloadData, 'base64');
  if (bytes[0] !== 0) return;
  const message = JSON.parse(bytes.subarray(1).toString());
  if (message.t === 'auth-ok') {
    reauthenticated = true;
    authenticatedSocket = event.params.requestId;
    listAnswers.clear();
  } else if (
    reauthenticated &&
    event.params.requestId === authenticatedSocket &&
    listMessages.has(message.t)
  ) {
    listAnswers.add(message.t);
  }
});
await client.send('Network.enable');

const daemonPid = ownDaemonPid();
if (daemonPid === null) throw new Error('no daemon of our own');
process.kill(daemonPid, 'SIGKILL');

// Retained rows remain visible during the outage. They cannot prove that a reconnect happened.
// Wait for a newly authenticated socket and fresh drawing as well as the restored row count.
const back = await waitUntil(
  async () =>
    reauthenticated &&
    listAnswers.size === listMessages.size &&
    (await rows()) >= before &&
    (await drawings()).some((d) => d.at > drawnBefore),
  40000,
);
// And then a while longer, so a late answer that would draw again is included in the count.
await sleep(5000);

r.ok(
  'the list is as full as it was once the daemon is back',
  back,
  `${String(before)} rows before, ${String(await rows())} after, reauthenticated=${String(reauthenticated)}, list answers=${JSON.stringify([...listAnswers])}`,
);

const since = (await drawings()).filter((d) => d.at > drawnBefore);
/*
 * State must not draw ahead of the lists and then rebuild when those lists arrive.
 * A list drawn earlier is already visible, even though its reason was cleared from the
 * render log before state/templates drew. Treating that order as a premature state draw
 * rejects the opposite of the regression this check is meant to catch.
 */
const lists = ['live', 'restorable', 'resumable'];
let listsDrawn = false;
const premature = since.filter((d) => {
  if (d.since.some((key) => lists.includes(key))) listsDrawn = true;
  return (d.since.includes('state') || d.since.includes('templates')) && !listsDrawn;
});
r.ok(
  'and state does not redraw ahead of the lists',
  since.length > 0 && (since.length === 1 || premature.length === 0),
  `${String(since.length)} drawings: ${JSON.stringify(since.map((d) => d.since))}`,
);

/*
 * And the rows are never taken away on the way there.
 *
 * A screen that empties and fills again is the flicker this suite is named for, and it is the one
 * a person would point at. Sampled on every change to the page, which is finer than any clock: a
 * timer is throttled in a tab that is not in front, so a blank shorter than a second could pass
 * between two samples and be recorded as never having happened. Nothing is measured in the
 * callback, only counted, so this cannot force a layout of its own.
 */
const sampled = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => {
         window.__watching.disconnect();
         return JSON.stringify({ low: window.__low, seen: window.__seen });
       })()`,
    ),
  ),
);
r.ok(
  'and the rows were never taken away while it waited',
  sampled.low > 0,
  `fewest rows seen was ${String(sampled.low)} across ${String(sampled.seen)} changes`,
);

await finish();
r.done();
