import { openTerminal, evaluate, type, waitFor, waitUntil, finish, sleep } from '../helpers.mjs';
import { reporter, listTargets } from '../cdp.mjs';

const r = reporter();
try {
  for (const method of ['button', 'menu']) {
    const work = await openTerminal();
    await type(work.client, `echo kill-group-${method}`);
    await waitFor(
      work.client,
      `(window.__tabterm.readScreen() ?? '').includes('kill-group-${method}')`,
    );
    const original = JSON.parse(
      await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneSessions())'),
    )[0];
    await evaluate(work.client, "window.__tabterm.split('horizontal')");
    await waitFor(work.client, 'window.__tabterm.paneIds().length === 2');
    // Leave the second shell untouched. It may not have a Running now card, but must survive.
    const viewer = await openTerminal();
    const card = `.session-card[data-session-id="${original.sessionId}"]`;
    await waitFor(viewer.client, `document.querySelector(${JSON.stringify(card)})`);
    if (method === 'button') {
      await evaluate(
        viewer.client,
        `document.querySelector(${JSON.stringify(card + ' .session-close')}).click()`,
      );
    } else {
      await evaluate(
        viewer.client,
        `document.querySelector(${JSON.stringify(card)}).dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:100,clientY:150}))`,
      );
      await evaluate(
        viewer.client,
        "[...document.querySelectorAll('.term-menu-item')].find(e => e.textContent === 'Kill session').click()",
      );
    }
    await sleep(100);
    await evaluate(
      viewer.client,
      "[...document.querySelectorAll('button')].find(e => e.textContent === 'Kill it anyway')?.click()",
    );
    await waitFor(viewer.client, `!document.querySelector(${JSON.stringify(card)})`, 10000);
    const alive = (await listTargets()).some((t) => t.id === work.tab.id);
    r.ok(`${method}: killing one pane keeps its tab`, alive);
    if (alive) {
      r.ok(
        `${method}: the surviving layout has one pane`,
        await waitFor(work.client, 'window.__tabterm.paneIds().length === 1'),
      );
      await work.client.send('Page.bringToFront');
      await type(work.client, `echo survivor-${method}`);
      r.ok(
        `${method}: the remaining shell still works`,
        await waitFor(
          work.client,
          `(window.__tabterm.readScreen() ?? '').includes('survivor-${method}')`,
        ),
      );
      const last = JSON.parse(
        await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneSessions())'),
      )[0];
      await viewer.client.send('Page.bringToFront');
      const lastCard = `.session-card[data-session-id="${last.sessionId}"] .session-close`;
      await waitFor(viewer.client, `document.querySelector(${JSON.stringify(lastCard)})`);
      await evaluate(viewer.client, `document.querySelector(${JSON.stringify(lastCard)}).click()`);
      await evaluate(
        viewer.client,
        "[...document.querySelectorAll('button')].find(e => e.textContent === 'Kill it anyway')?.click()",
      );
      r.ok(
        `${method}: killing the last session closes its tab`,
        await waitUntil(
          async () => !(await listTargets()).some((t) => t.id === work.tab.id),
          10000,
        ),
      );
    }
  }
} finally {
  await finish();
}
r.done();
