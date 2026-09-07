// The bar on top of each pane in a tab that holds more than one.
//
// A name, a way to the pane's own menu, and a way to close it. Nothing else: everything that can
// be done to a pane is in that menu already, and a bar with three entries of its own would be a
// second list to keep in step with a list that is already right.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  realClick,
  openPaneMenu,
  type,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.pane')");
await type(client, 'echo pane-bar');
await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
await sleep(600);

const barsShown = () =>
  evaluate(
    client,
    `String([...document.querySelectorAll('.pane-bar')].filter((b) => b.getBoundingClientRect().height > 2).length)`,
  );

/**
 * One terminal has no bar at all.
 *
 * The tab's own title already says what it would, and a strip across the top would take rows
 * from the terminal to repeat something.
 */
r.ok('a single pane has no bar', String(await barsShown()) === '0', String(await barsShown()));

// Split, which is the state the bar exists for.
await openPaneMenu(client, 200, 300);
await realClick(client, '.term-menu-item', 'Split right');
await waitFor(client, `document.querySelectorAll('.pane').length === 2`, 12000);
await sleep(800);

r.ok(
  'splitting gives every pane a bar',
  String(await barsShown()) === '2',
  String(await barsShown()),
);

const bars = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => {
         const bar = p.querySelector('.pane-bar');
         const box = bar?.getBoundingClientRect();
         return {
           pane: p.dataset.paneId ?? '',
           focused: p.classList.contains('focused'),
           name: bar?.querySelector('.pane-bar-name')?.textContent ?? '',
           height: Math.round(box?.height ?? 0),
           buttons: bar ? bar.querySelectorAll('.pane-bar-button').length : 0,
           background: bar ? getComputedStyle(bar).backgroundImage : '',
         };
       }))`,
    ),
  );

{
  const all = await bars();
  r.ok(
    'the bar is thin, and takes almost nothing from the terminal',
    all.every((b) => b.height > 0 && b.height <= 26),
    JSON.stringify(all.map((b) => b.height)),
  );
  r.ok(
    'each bar has exactly two buttons: the menu and the close',
    all.every((b) => b.buttons === 2),
    JSON.stringify(all.map((b) => b.buttons)),
  );
  r.ok(
    'and each says what its own pane is',
    all.every((b) => b.name !== ''),
    JSON.stringify(all.map((b) => b.name)),
  );
  /**
   * The focused pane's bar is lit, and the others are not.
   *
   * Asked for as "a slightly different color from the other, just like a different gradient or
   * something of the same color". The border already says which pane has the keyboard; this says
   * it again where the name is, without introducing a hue that means nothing else in the product.
   */
  const focused = all.filter((b) => b.focused);
  const rest = all.filter((b) => !b.focused);
  r.ok(
    'exactly one pane is focused',
    focused.length === 1,
    JSON.stringify(all.map((b) => b.focused)),
  );
  r.ok(
    "the focused pane's bar is drawn differently from the others",
    focused.length === 1 &&
      rest.length > 0 &&
      rest.every((b) => b.background !== focused[0].background),
    JSON.stringify([focused[0]?.background, rest[0]?.background]),
  );
}

/**
 * The terminal is not underneath the bar.
 *
 * The pane's content fills it absolutely on its own, so adding a strip on top covered the first
 * row, which is exactly where a prompt is.
 */
{
  const overlap = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => {
         const bar = p.querySelector('.pane-bar')?.getBoundingClientRect();
         const term = p.querySelector('.pane-terminal')?.getBoundingClientRect();
         return Math.round((bar?.bottom ?? 0) - (term?.top ?? 0));
       }))`,
    ),
  );
  r.ok(
    'the terminal starts below the bar rather than under it',
    overlap.every((n) => n <= 1),
    JSON.stringify(overlap),
  );
}

/** The dots give the pane's own menu, which is the same one a right click gives. */
{
  await evaluate(client, `document.querySelector('.pane .pane-bar-button')?.click()`);
  await sleep(500);
  const labels = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
    ),
  );
  r.ok(
    'the dots open the pane menu',
    labels.includes('Split right') && labels.includes('Close session'),
    labels.join(' | ').slice(0, 110),
  );
  /**
   * Opened back into the pane, not off the edge of it.
   *
   * The button sits at the right of a bar that can be half a narrow window wide, so a menu that
   * opened rightwards from it would hang off the screen.
   */
  const fits = await evaluate(
    client,
    `(() => { const m = document.querySelector('.term-menu'); if (!m) return 'none';
       const b = m.getBoundingClientRect();
       return b.right <= window.innerWidth + 1 && b.left >= -1 ? 'yes' : 'no'; })()`,
  );
  r.ok('and it opens somewhere it fits', String(fits) === 'yes', String(fits));
  await evaluate(client, `document.querySelector('.term-menu')?.remove()`);
}

/** The cross closes that pane, and only that one. */
{
  const before = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => p.dataset.paneId ?? ''))`,
    ),
  );
  await realClick(client, '.pane .pane-bar-button.is-close');
  const closed = await waitFor(
    client,
    `document.querySelectorAll('.pane').length === ${String(before.length - 1)}`,
    12000,
  );
  const after = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => p.dataset.paneId ?? ''))`,
    ),
  );
  r.ok('the cross closes a pane', closed, `${String(before.length)} -> ${String(after.length)}`);
  r.ok('and it closes the one it belongs to', !after.includes(before[0]), JSON.stringify(after));
}

// And back to one pane, the bars go away again.
await sleep(600);
r.ok(
  'the last pane left loses its bar again',
  String(await barsShown()) === '0',
  String(await barsShown()),
);

await finish();
r.done();
