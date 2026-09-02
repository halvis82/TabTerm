// The command menu is as tall as whatever it is showing, so it has to keep itself on screen.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await evaluate(client, "document.getElementById('cmd-button').click()");
await sleep(600);

const box = () =>
  evaluate(
    client,
    `(() => { const b = document.querySelector('.cmd-panel').getBoundingClientRect();
      return JSON.stringify({ top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }); })()`,
  );
const fits = async () => {
  const b = JSON.parse(await box());
  return {
    ...b,
    ok: b.top >= 0 && b.bottom <= Number(await evaluate(client, 'window.innerHeight')) + 1,
  };
};

r.ok('it opens fully on screen', (await fits()).ok, await box());

// Put it low, then switch to a taller page. Actions is short, Settings is tall.
await evaluate(
  client,
  `(() => { const p = document.querySelector('.cmd-panel');
    p.style.top = (window.innerHeight - p.getBoundingClientRect().height - 8) + 'px'; })()`,
);
await sleep(200);
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find(b => b.textContent === 'Actions')?.click()`,
);
await sleep(400);
await evaluate(client, "document.querySelector('.cmd-gear')?.click()");
await sleep(700);
const afterSettings = await fits();
r.ok(
  'switching to a taller page moves it back into view',
  afterSettings.ok,
  JSON.stringify(afterSettings),
);

// Growing content does the same thing without any tab changing.
await evaluate(client, "document.querySelector('.cmd-gear')?.click()");
await sleep(300);
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find(b => b.textContent === 'Recent')?.click()`,
);
await sleep(600);
const afterGrowing = await fits();
r.ok('and so does the list growing', afterGrowing.ok, JSON.stringify(afterGrowing));

// And the window changing under it.
const { windowId } = await client.send('Browser.getWindowForTarget');
await client.send('Browser.setWindowBounds', { windowId, bounds: { width: 900, height: 420 } });
await sleep(900);
const afterResize = await fits();
r.ok('and the window being resized', afterResize.ok, JSON.stringify(afterResize));
await client.send('Browser.setWindowBounds', { windowId, bounds: { width: 1200, height: 800 } });

await finish();
r.done();
