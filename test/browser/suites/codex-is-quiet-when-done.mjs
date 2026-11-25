// A Codex pane neither spins nor flashes on its own account.
//
// Reported: "codex session in tabterm for some reason flashes when done without that enabled in
// right click menu sometimes and icon says loading sometimes when it's done". Two causes. The
// agent's command was shown as running for as long as it was open, so the icon spun over a Codex
// sitting at its prompt. And Codex rings the bell at the end of a turn when it thinks nobody is
// looking, and the bell flashed whatever the pane's own flash setting said.
//
// A stand-in `codex` on the PATH does the two things that matter: it stays open, and it rings.
import { openTerminal, evaluate, waitFor, sleep, finish, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const r = reporter();
const bin = mkdtempSync(join(tmpdir(), 'tabterm-fake-codex-'));
writeFileSync(
  join(bin, 'codex'),
  "#!/bin/sh\necho fake-codex-ready\nsleep 1.5\nprintf '\\007'\nexec cat >/dev/null\n",
);
chmodSync(join(bin, 'codex'), 0o755);

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, `PATH=${bin}:$PATH codex`);
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('fake-codex-ready')`, 10000);

const icon = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.faviconNow())')));
const paneId = String(await evaluate(client, 'window.__tabterm.paneIds()[0]'));
const bells = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.bellsRung())')));

// Past the bell, with time for it to have been drawn.
await sleep(2600);
r.ok(
  'an open Codex with nothing reported is not shown as running',
  (await icon()).showing !== 'running',
  JSON.stringify(await icon()),
);
r.ok(
  'and its bell flashes nothing while the pane flash setting is off',
  !(await bells()).includes(paneId),
  JSON.stringify(await bells()),
);

// Its hooks are what say it is working, and that it is done.
const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const sessionId =
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')))[0]
    ?.sessionId ?? '';
async function hook(name) {
  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, hook: name, agentSessionId: 'cx-1', agent: 'codex' }),
  });
  if (res.status !== 204) throw new Error(`${name} answered ${String(res.status)}`);
  await sleep(400);
}
await hook('UserPromptSubmit');
r.ok('a Codex prompt shows it working', (await icon()).showing === 'running');
await hook('Stop');
r.ok(
  'and its Stop ends that',
  await waitFor(client, `window.__tabterm.faviconNow().showing !== 'running'`, 3000),
  JSON.stringify(await icon()),
);

await type(client, '\u0003', { submit: false });
await finish();
r.done();
