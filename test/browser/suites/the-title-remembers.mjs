// A tab called by what it ran is still called that after a refresh.
//
// Reported as: "when the title for a tab is set to something like the last command run and then we
// refresh, it's just set to zsh. it shouldn't default to that, it should be persistent and
// remember." The page learned it from the event that says a command started, and a page that has
// just loaded has never received one.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const marker = 'dmesg-lookalike';
await type(client, `echo ${marker}\r`);
await waitUntil(
  async () =>
    String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(marker),
  20000,
);
await sleep(1200);

const named = await waitUntil(
  async () => String(await evaluate(client, 'document.title')).includes('echo'),
  10000,
);
r.ok('the tab is called by what it ran', named, String(await evaluate(client, 'document.title')));

await client.send('Page.reload');
await sleep(1000);
await waitUntil(
  async () => String(await evaluate(client, 'window.__tabterm?.readScreen?.() ?? ""')).length > 5,
  30000,
);
await sleep(1500);

const still = await waitUntil(
  async () => String(await evaluate(client, 'document.title')).includes('echo'),
  15000,
);
r.ok('and still is after a refresh', still, String(await evaluate(client, 'document.title')));
r.ok(
  'rather than falling back to the name of the shell',
  !/^zsh\b/.test(String(await evaluate(client, 'document.title'))),
  String(await evaluate(client, 'document.title')),
);

/**
 * And a tab with an agent in it is called by the agent, before and after a refresh.
 *
 * Reported as a second half of the same thing: "the zsh name feels not necessary, we're running
 * claude there, not just normal zsh". `zsh` is the name of the shell the agent is sitting in and
 * not the thing on the screen. The folder went too: `claude — ece260a` became `claude` on a
 * refresh, because the page replaces its title fields with what arrives and the message left the
 * directory out.
 *
 * A stand-in named `claude` on the path, because what the title reads is decided by the name of
 * the program in the foreground, and driving a real agent CLI would spend somebody's money.
 */
{
  const bin = mkdtempSync(join(tmpdir(), 'tt-agent-stand-in-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "a stand in\\n"\nsleep 120\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const fresh = await openTerminal();
  await waitFor(fresh.client, "document.querySelector('.launcher-input')");
  await type(fresh.client, `cd ${JSON.stringify(bin)} && export PATH="${bin}:$PATH"\r`);
  await sleep(900);
  await type(fresh.client, 'claude\r');

  const asAgent = await waitUntil(
    async () => String(await evaluate(fresh.client, 'document.title')).startsWith('claude'),
    20000,
  );
  r.ok(
    'a tab running an agent is called by the agent',
    asAgent,
    String(await evaluate(fresh.client, 'document.title')),
  );
  const whileRunning = String(await evaluate(fresh.client, 'document.title'));
  r.ok('and says where it is, not only what it is', whileRunning.includes('—'), whileRunning);

  await evaluate(fresh.client, 'location.reload()');
  await sleep(1500);
  await waitUntil(
    async () => Boolean(await evaluate(fresh.client, 'Boolean(window.__tabterm)')),
    30000,
  );
  const back = await waitUntil(async () => {
    const title = String(await evaluate(fresh.client, 'document.title'));
    return title.startsWith('claude') && title.includes('—');
  }, 20000);
  // The facts beside the title: "claude" cannot say whether the folder was never learned or was
  // learned and not drawn, and those are different faults.
  r.ok(
    'and a refresh keeps both, rather than dropping the folder or falling back to the shell',
    back,
    `${String(await evaluate(fresh.client, 'document.title'))} from ${String(
      await evaluate(fresh.client, 'JSON.stringify(window.__tabterm.titleFacts())'),
    )}`,
  );
}

await finish();
r.done();
