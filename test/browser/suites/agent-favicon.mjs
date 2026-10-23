// What the tab's icon says while an agent runs, driven by the agent's own hooks.
//
// The icon is the one part of a terminal that is read from somewhere else, and this whole path,
// hook script to bridge to daemon to page to canvas, had never been driven end to end. A report
// of an icon stuck on "waiting for you" after the agent had finished is what it took.
//
// Real hook posts to the real bridge, not a synthetic message injected into the page: the
// question is whether the sequence an agent actually produces leaves the icon telling the truth,
// and a message the test writes itself cannot answer that.
import { openTerminal, evaluate, waitFor, sleep, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(600);

const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';

const panes = await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())');
const sessionId = JSON.parse(String(panes))[0]?.sessionId ?? '';
r.ok('the tab has a session for a hook to report against', sessionId !== '', String(panes));

/** One hook event, exactly as the installed shell script sends it. */
async function hook(name) {
  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, hook: name }),
  });
  // 204 is the bridge's answer to everything it accepts, recognised or not.
  if (res.status !== 204) throw new Error(`${name} answered ${String(res.status)}`);
  await sleep(400);
}

const icon = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.faviconNow())')));

await hook('UserPromptSubmit');
r.ok('a prompt makes the tab say something is running', (await icon()).showing === 'running');

await hook('PreToolUse');
r.ok('and it stays running through a tool call', (await icon()).showing === 'running');

/**
 * The notification an agent raises when it wants a person.
 *
 * With permissions skipped this is the only thing that produces the amber icon, and it is also
 * what an agent fires after sitting idle, which is the case this suite exists for.
 */
await hook('Notification');
const waiting = await icon();
r.ok('a notification turns the tab amber', waiting.showing === 'waiting', JSON.stringify(waiting));

/**
 * The turn ends. This is the assertion the reported bug fails.
 *
 * "claude had finished but it still showed the yellow orange ish one." Finishing is `Stop`, and
 * after it nothing is waiting for anybody.
 */
await hook('Stop');
const finished = await icon();
r.ok(
  'and finishing clears it, rather than leaving the tab asking for a person',
  finished.showing !== 'waiting' && finished.showing !== 'approval',
  JSON.stringify(finished),
);

/**
 * The order that actually happens on a machine, which is not the order above.
 *
 * An agent finishes its turn first and a minute later sends its idle reminder, so `Notification`
 * arrives after `Stop`. That reminder is not news: the turn ending was, and it was already shown.
 * It used to turn every finished tab amber a minute later and raise "Agent is waiting for you"
 * for a tab somebody was reading. Now the tick stays.
 */
await hook('UserPromptSubmit');
await hook('Stop');
await hook('Notification');
const reminded = await icon();
r.ok(
  'the idle reminder after a turn leaves the tick, not amber',
  reminded.showing === 'success',
  JSON.stringify(reminded),
);
await evaluate(client, 'window.__tabterm.lookAtTab()');
await sleep(300);

/**
 * A subagent finishing in the middle of a turn is not the agent finishing.
 *
 * It was read as idle, so the tab dropped out of busy with every subagent, and sometimes the
 * person's turn was ended early by it.
 */
await hook('UserPromptSubmit');
await hook('SubagentStop');
const mid = await icon();
r.ok(
  'a subagent stopping mid-turn keeps the tab busy',
  mid.showing === 'running',
  JSON.stringify(mid),
);
await hook('Stop');
r.ok('and the agent stopping is the outcome', (await icon()).showing === 'success');

/**
 * Work between prompts is not a result.
 *
 * A monitor reporting, a background task finishing, a recap: the agent works and stops without
 * anybody having asked. Each of those used to read as a new turn ending, with a new tick and a
 * new flash. With an outcome nobody has seen yet, it is left in place.
 */
await hook('PreToolUse');
const wokeOverTick = await icon();
r.ok(
  'unprompted work leaves an unseen tick in place',
  wokeOverTick.showing === 'success',
  JSON.stringify(wokeOverTick),
);
await hook('Stop');
await evaluate(client, 'window.__tabterm.lookAtTab()');
await sleep(300);
await hook('PreToolUse');
r.ok('with nothing unseen, unprompted work shows the ring', (await icon()).showing === 'running');
await hook('Stop');
const afterRecap = await icon();
r.ok(
  'and ends without a tick, because nobody was waiting for it',
  afterRecap.showing === 'idle',
  JSON.stringify(afterRecap),
);

/**
 * A tab that reloads while an agent is waiting comes back still saying so.
 *
 * Attaching used to set every pane back to idle, and agent state is only ever pushed when it
 * changes, so the one event that would have corrected it is the one that never comes: the agent
 * is waiting, and the next thing it does is wait some more.
 */
await hook('UserPromptSubmit');
await hook('Notification');
await evaluate(client, 'location.reload()');
await sleep(3000);
await waitFor(client, 'window.__tabterm !== undefined');
await sleep(1200);
const reloaded = await icon();
r.ok(
  'a reload keeps an agent that is waiting for somebody',
  reloaded.showing === 'waiting',
  JSON.stringify(reloaded),
);

// Nothing may be dropped silently. Every decision is accounted for.
const log = (await icon()).log;
r.ok(
  'every icon decision was drawn rather than skipped',
  log.every((entry) => entry.drew !== 'nothing'),
  JSON.stringify(log.filter((e) => e.drew === 'nothing')),
);

await finish();
r.done();
