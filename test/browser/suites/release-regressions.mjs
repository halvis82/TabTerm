// Real shell events and hook posts, with no logged-in agent account required.
import { openTerminal, evaluate, type, waitFor, finish, sleep, press } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
const tag = `release-${Date.now()}`;
const a = `echo ${tag}-a`;
const b = `echo ${tag}-b`;
const label = "document.querySelector('.pane-time')?.textContent ?? ''";
const run = async (command) => {
  await client.send('Page.bringToFront');
  await type(client, command);
  await waitFor(client, `(${label}).startsWith('took ')`, 15000);
};
try {
  await run(a);
  await run(b);
  await press(client, 'f', 'KeyF', 6, 70);
  r.ok(
    'Control Command F does not open terminal search',
    await evaluate(client, "document.getElementById('find').hidden"),
  );
  await press(client, 'F', 'KeyF', 12, 70);
  r.ok(
    'Shift Command F does not open terminal search',
    await evaluate(client, "document.getElementById('find').hidden"),
  );
  await press(client, 'f', 'KeyF', 4, 70);
  r.ok(
    'Command F still opens terminal search',
    await waitFor(client, "!document.getElementById('find').hidden"),
  );
  await evaluate(client, "document.getElementById('find-close').click()");
  const { client: viewer } = await openTerminal();
  await evaluate(viewer, "document.getElementById('cmd-button').click()");
  await evaluate(
    viewer,
    "[...document.querySelectorAll('.cmd-tab')].find(e => e.textContent === 'Recent').click()",
  );
  const rows = "[...document.querySelectorAll('.cmd-row-label')].map(e => e.textContent)";
  await waitFor(viewer, `${rows}.includes(${JSON.stringify(b)})`, 15000);
  await run(a);
  r.ok(
    'repeating a command promotes it in an already open Recent menu in another tab',
    await waitFor(
      viewer,
      `${rows}.filter(s => s.includes(${JSON.stringify(tag)}))[0] === ${JSON.stringify(a)}`,
      5000,
    ),
    String(await evaluate(viewer, `JSON.stringify(${rows})`)),
  );

  await client.send('Page.bringToFront');
  const sessionId = JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
  )[0].sessionId;
  const slow = `sleep 3 && echo ${tag}-slow`;
  await run(slow);
  await run(b);
  await waitFor(viewer, `${rows}[0] === ${JSON.stringify(b)}`, 5000);
  await type(client, slow);
  r.ok(
    'an existing long command moves up before it finishes',
    await waitFor(viewer, `${rows}[0] === ${JSON.stringify(slow)}`, 1500),
  );
  await waitFor(client, `(${label}).startsWith('took 3s')`, 6000);
  const hook = async (name) => {
    const res = await fetch(
      `http://127.0.0.1:${Number(process.env.TT_DAEMON_PORT) + 1}/agent-event`,
      {
        method: 'POST',
        headers: {
          'x-tabterm-token': process.env.TT_DAEMON_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId, hook: name }),
      },
    );
    if (res.status !== 204) throw new Error(`hook ${name}: ${res.status}`);
  };
  await hook('UserPromptSubmit');
  await waitFor(client, `(${label}).startsWith('answering ')`);
  await sleep(1100);
  await hook('Notification');
  await waitFor(client, `(${label}).startsWith('waiting for you')`);
  await client.send('Page.reload');
  await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 25000);
  r.ok(
    'a waiting turn remains waiting after refresh',
    await waitFor(client, `(${label}).startsWith('waiting for you')`, 5000),
    String(await evaluate(client, label)),
  );
  await hook('Stop');
  await waitFor(client, `(${label}).startsWith('answered in ')`);
  const finished = String(await evaluate(client, label)).split(' · ')[0];
  await client.send('Page.reload');
  await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 25000);
  r.ok(
    'the completed turn duration agrees before and after refresh',
    await waitFor(client, `(${label}).startsWith(${JSON.stringify(finished)})`, 5000),
    String(await evaluate(client, label)),
  );
  await type(client, 'sleep 3');
  r.ok(
    'a shell command replaces the old agent timer',
    await waitFor(client, `(${label}).startsWith('running ')`, 2000),
    String(await evaluate(client, label)),
  );
  r.ok(
    'its completion reports the shell duration',
    await waitFor(client, `(${label}).startsWith('took 3s')`, 7000),
    String(await evaluate(client, label)),
  );
  await run('ls');
  r.ok(
    'Running now describes the current shell work',
    await waitFor(
      viewer,
      `document.querySelector('[data-session-id="${sessionId}"] .session-what')?.textContent === 'shell - ls'`,
      10000,
    ),
  );
} finally {
  await finish();
}
r.done();
