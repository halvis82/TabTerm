import { openTerminal, evaluate, type, waitFor, press, finish, sleep } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
const r = reporter();
const { client } = await openTerminal();
try {
  await type(client, 'for i in {1..250}; do echo HISTORY-ROW-$i; done');
  await waitFor(client, "window.__tabterm.readScreen().includes('HISTORY-ROW-250')");
  const copy = async () => {
    await press(client, 'a', 'KeyA', 4, 65);
    await press(client, 'c', 'KeyC', 4, 67);
    await sleep(100);
    return String(await evaluate(client, 'navigator.clipboard.readText()'));
  };
  const all = await copy();
  r.ok(
    'Command A copies history above the viewport',
    all.includes('HISTORY-ROW-1\n') && all.includes('HISTORY-ROW-250'),
  );
  await evaluate(client, 'window.__tabterm.scrollLines(-100)');
  const scrolled = await copy();
  r.ok('selection does not depend on the scroll position', scrolled === all);
  // A full-screen program has a separate screen, but normal-buffer history still exists.
  await type(client, "printf '\\033[?1049hALT-SCREEN-CONTENT'; sleep 60");
  r.ok(
    'the fixture really entered the alternate screen',
    await waitFor(
      client,
      "window.__tabterm.readScreen().includes('ALT-SCREEN-CONTENT') && !window.__tabterm.readScreen().includes('HISTORY-ROW-250')",
    ),
  );
  const alt = await copy();
  r.ok(
    'Command A includes retained history while a full-screen program is running',
    alt.includes('HISTORY-ROW-1\n') && alt.includes('ALT-SCREEN-CONTENT'),
  );
} finally {
  await finish();
}
r.done();
