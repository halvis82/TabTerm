import {
  openTerminal,
  evaluate,
  type,
  waitFor,
  waitUntil,
  ownDaemonPid,
  press,
  finish,
  sleep,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
const r = reporter();
const { client } = await openTerminal();
try {
  await type(client, 'for i in {1..250}; do echo RETAINED-HISTORY-$i; done');
  await waitFor(client, "window.__tabterm.readScreen().includes('RETAINED-HISTORY-250')");
  // A redraw-heavy program can use more than the host's 5 MB replay ring without adding a line.
  await type(
    client,
    `node -e 'process.stdout.write("\\x1b[1Gredraw".repeat(600000)); console.log("REDRAW-FINISHED")'`,
  );
  r.ok(
    'the redraw fixture has finished producing output',
    await waitFor(client, "window.__tabterm.readScreen().includes('redrawREDRAW-FINISHED')", 30000),
  );
  await sleep(500);
  r.ok(
    'history still exists after redraws while the daemon is running',
    await evaluate(client, "window.__tabterm.readScreen().includes('RETAINED-HISTORY-1\\n')"),
  );
  const daemonPid = ownDaemonPid();
  if (!daemonPid) throw new Error('refusing to restart anything without an isolated test daemon');
  process.kill(daemonPid, 'SIGTERM');
  await waitUntil(() => ownDaemonPid() !== daemonPid && ownDaemonPid() !== null, 20000);
  await client.send('Page.reload');
  await waitFor(client, "window.__tabterm?.readScreen().includes('REDRAW-FINISHED')", 30000);
  await press(client, 'a', 'KeyA', 4, 65);
  await press(client, 'c', 'KeyC', 4, 67);
  await sleep(100);
  r.ok(
    'all retained history remains copyable after an update',
    String(await evaluate(client, 'navigator.clipboard.readText()')).includes(
      'RETAINED-HISTORY-1\n',
    ),
  );
  const geo = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())'));
  const at = Number(await evaluate(client, 'window.__tabterm.viewportY()'));
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(geo.left + 40),
    y: Math.round(geo.top + 40),
    deltaX: 0,
    deltaY: -180,
  });
  r.ok(
    'the restored session can still scroll upward',
    await waitFor(client, `window.__tabterm.viewportY() < ${at}`),
  );
} finally {
  await finish();
}
r.done();
