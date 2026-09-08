// A marker can only be added where a marker means something: at a prompt.
//
// It is printed into the session's output. That is right in scrollback, which is a record of what
// has happened, and wrong inside anything that owns the screen: an agent, an editor, a pager, a
// build that redraws. The bars land in the middle of what is being drawn and the program redraws
// over and around them.
//
// Reported twice. The first fix gated on panes the daemon said were *started with* a command,
// which covers "Open agent here" and covers nothing about the usual way people get an agent,
// which is typing `claude` into a shell that is already open.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  openPaneMenu,
  type,
  interrupt,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo marker-gate');
await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
await sleep(800);

/** Whether the pane menu offers a usable marker entry right now. */
const markerOffered = async () => {
  await openPaneMenu(client, 200, 300);
  const state = JSON.parse(
    await evaluate(
      client,
      `(() => { const b = [...document.querySelectorAll('.term-menu-item')]
         .find((x) => (x.textContent || '').trim() === 'Add a marker here');
         return JSON.stringify({ there: !!b, enabled: b ? !b.disabled : null }); })()`,
    ),
  );
  await evaluate(client, `document.querySelector('.term-menu')?.remove()`);
  return state;
};

{
  const at = await markerOffered();
  r.ok('at a prompt, a marker is offered', at.there && at.enabled === true, JSON.stringify(at));
}

/**
 * Something running, which is every case at once.
 *
 * A sleep stands in for an agent, an editor and a build alike: what matters is that a program has
 * the screen, not which program it is.
 */
{
  await type(client, 'sleep 25');
  await waitFor(
    client,
    `window.__tabterm.paneFacts().length > 0 && document.title.includes('sleep')`,
    12000,
  ).catch(() => undefined);
  await sleep(1500);
  const during = await markerOffered();
  r.ok(
    'while something is running, it is offered but greyed',
    during.there && during.enabled === false,
    JSON.stringify(during),
  );
}

/**
 * And an agent, said by the agent's own hooks rather than inferred from the screen.
 *
 * This is the signal that does not depend on the shell integration noticing anything, which is
 * what makes it the one that closes the reported gap: a `claude` typed into a shell reports its
 * state whether or not anything else spotted it starting.
 */
{
  /**
   * Back to a prompt first, so this tests the agent signal and not the previous one.
   *
   * With a command still running, everything below would pass on the strength of that alone, and
   * the check that closes the reported gap would be proving nothing.
   */
  await interrupt(client);
  await sleep(1500);
  const backAtPrompt = await markerOffered();
  r.ok(
    'the sleep is over and a marker is offered again',
    backAtPrompt.enabled === true,
    JSON.stringify(backAtPrompt),
  );

  const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
  const token = process.env['TT_DAEMON_TOKEN'] ?? '';
  const panes = JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
  );
  const sessionId = panes[0]?.sessionId ?? '';
  r.ok('a session for the agent to report against', sessionId !== '');

  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, hook: 'UserPromptSubmit' }),
  });
  r.ok('the agent hook was accepted', res.status === 204, String(res.status));
  await sleep(800);

  const withAgent = await markerOffered();
  r.ok(
    'a pane an agent has reported in never offers a marker',
    withAgent.there && withAgent.enabled === false,
    JSON.stringify(withAgent),
  );

  /**
   * And it stays refused once the agent goes quiet.
   *
   * An agent between turns looks exactly like a prompt from the outside, and it is not one: the
   * next thing it does is redraw. A pane that has held an agent holds it until something else is
   * put there.
   */
  await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, hook: 'Stop' }),
  });
  await sleep(1200);
  const idle = await markerOffered();
  r.ok(
    'and still refuses once that agent is between turns',
    idle.there && idle.enabled === false,
    JSON.stringify(idle),
  );
}

await finish();
r.done();
