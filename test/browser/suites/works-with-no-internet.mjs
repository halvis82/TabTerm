// A terminal is on-device work, so nothing about opening one or running a command may wait on a
// network. Asked as three questions, each answered by measurement rather than by reading the code.
//
//   1. Does anything leave this machine at all while a tab opens and commands run?
//   2. Does the daemon hold a socket to anywhere but this machine?
//   3. With everything off-machine made to fail outright, is any of it slower?
//
// The third is the one that matters to somebody waiting: a product that merely "works offline"
// while taking two seconds longer has still made a terminal wait on the internet.
import { execFileSync } from 'node:child_process';
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

/** Loopback, this extension, or something that never left the page. */
const isLocal = (url) =>
  url.startsWith('chrome-extension://') ||
  url.startsWith('data:') ||
  url.startsWith('blob:') ||
  /^wss?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|\/)/.test(url) ||
  /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|\/)/.test(url) ||
  url === 'about:blank';

/** Open a tab, watch every request it makes, and time the two things a person waits for. */
async function measure({ blockOffMachine }) {
  const asked = [];
  const { client } = await openTerminal();
  // Every message, filtered here: this client hands listeners the whole frame rather than
  // subscribing by name.
  client.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      asked.push(message.params?.request?.url ?? '');
    }
  });
  await client.send('Network.enable');
  if (blockOffMachine) {
    // Everything that is not this machine fails outright, which is a harder world than being
    // offline: offline at least fails fast in the same way for everyone.
    await client.send('Network.setBlockedURLs', {
      urls: ['http://*', 'https://*', 'ws://*', 'wss://*'],
    });
  }

  const openedAt = Date.now();
  const ready = await waitFor(client, "document.querySelector('.launcher-input')", 20000);
  const promptMs = Date.now() - openedAt;

  const marker = `NO-INTERNET-${String(Math.floor(Math.random() * 1e6))}`;
  const before = Date.now();
  await type(client, `echo ${marker}\r`);
  const ran = await waitUntil(
    async () =>
      String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(marker),
    20000,
  );
  const commandMs = Date.now() - before;

  // And a second one, because the first carries the cost of the shell starting.
  const second = `AGAIN-${String(Math.floor(Math.random() * 1e6))}`;
  const beforeSecond = Date.now();
  await type(client, `echo ${second}\r`);
  const ranAgain = await waitUntil(
    async () =>
      String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(second),
    20000,
  );
  const secondMs = Date.now() - beforeSecond;

  await sleep(500);
  return { asked, ready, ran, ranAgain, promptMs, commandMs, secondMs };
}

/*
 * With the machine as it is. Every request the page makes is recorded, including the ones the
 * extension makes for its own files, so "nothing left the machine" is a statement about a list
 * rather than about the absence of one.
 */
const normal = await measure({ blockOffMachine: false });
r.ok('a terminal opens and runs commands', normal.ready && normal.ran && normal.ranAgain);
const offMachine = normal.asked.filter((u) => u && !isLocal(u));
r.ok(
  'nothing it asks for leaves this machine',
  offMachine.length === 0,
  `${String(normal.asked.length)} requests, off-machine: ${JSON.stringify(offMachine.slice(0, 5))}`,
);

/*
 * The daemon, asked of the operating system rather than of the daemon itself. It is the half that
 * a page cannot see, and the half that would be holding a connection open if anything did.
 */
const port = Number(process.env.TT_DAEMON_PORT);
let sockets = '';
try {
  const pid = execFileSync('lsof', ['-ti', `tcp:${String(port)}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')[0];
  // `-a`, or lsof ORs its selectors and answers with every socket on the machine rather than
  // this process's. Without it this check reported the operating system's own connections.
  sockets = execFileSync('lsof', ['-nP', '-a', '-p', pid, '-i'], { encoding: 'utf8' });
} catch {
  sockets = '';
}
const remote = sockets
  .split('\n')
  .slice(1)
  .map((line) => line.split(/\s+/)[8] ?? '')
  .filter((where) => where !== '' && !/127\.0\.0\.1|\[::1\]|localhost/.test(where));
r.ok(
  'and the daemon holds no socket to anywhere else',
  sockets !== '' && remote.length === 0,
  sockets === '' ? 'could not ask lsof' : JSON.stringify(remote.slice(0, 5)),
);

/*
 * Now with everything off-machine failing. The same work, timed the same way: what a person
 * waits for is the prompt appearing and a command answering, and neither may change.
 */
const cut = await measure({ blockOffMachine: true });
r.ok(
  'it opens and runs with everything off-machine blocked',
  cut.ready && cut.ran && cut.ranAgain,
  `prompt ${String(cut.promptMs)}ms, first ${String(cut.commandMs)}ms, second ${String(cut.secondMs)}ms`,
);
r.ok(
  'nothing was asked of the network even then',
  cut.asked.filter((u) => u && !isLocal(u)).length === 0,
  JSON.stringify(cut.asked.filter((u) => u && !isLocal(u)).slice(0, 5)),
);

/*
 * And it is not slower. A generous allowance, because these are whole-machine timings on a
 * machine running other suites: what this rules out is a wait on something that is not there,
 * which costs seconds, not milliseconds.
 */
r.ok(
  'the prompt takes no longer without a network',
  cut.promptMs <= normal.promptMs + 2000,
  `${String(normal.promptMs)}ms with, ${String(cut.promptMs)}ms without`,
);
r.ok(
  'and a command answers just as fast',
  cut.secondMs <= normal.secondMs + 1000,
  `${String(normal.secondMs)}ms with, ${String(cut.secondMs)}ms without`,
);

/*
 * The number itself, said out loud. A terminal that answers a local command in a second is a
 * terminal somebody is waiting on, network or no network.
 */
r.ok(
  'a local command answers in well under a second',
  cut.secondMs < 1000 && normal.secondMs < 1000,
  `${String(normal.secondMs)}ms with a network, ${String(cut.secondMs)}ms without`,
);

console.log(
  `    timings: prompt ${String(normal.promptMs)}ms then ${String(cut.promptMs)}ms blocked, ` +
    `first command ${String(normal.commandMs)}ms then ${String(cut.commandMs)}ms, ` +
    `second ${String(normal.secondMs)}ms then ${String(cut.secondMs)}ms, ` +
    `${String(normal.asked.length)} requests, none off-machine`,
);

await finish();
r.done();
