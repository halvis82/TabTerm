// Every place a right click can land, and what it gives.
//
// Asked for as "flush out all the right click options in any possible case and make sure it's all
// working as expected in every case, because i feel like we keep finding problems". So this is a
// sweep rather than a sample: every surface a pointer can be over, checked for three things.
//
//   1. Chrome's own menu never appears, which means ours took the event.
//   2. What ours offers fits the place it landed.
//   3. Every entry it offers actually does something.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  openPaneMenu,
  boxOf,
  type,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1800);

/** Right click the middle of whatever matches, and report the menu it produced. */
const menuOn = async (selector) => {
  const at = await evaluate(
    client,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return '';
       const b = el.getBoundingClientRect();
       if (b.width < 2 || b.height < 2) return '';
       return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`,
  );
  if (String(at) === '') return null;
  const { x, y } = JSON.parse(String(at));
  await openPaneMenu(client, x, y);
  const out = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify({
         labels: [...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()),
         defaultPrevented: document.querySelectorAll('.term-menu').length > 0,
         enabled: [...document.querySelectorAll('.term-menu-item')].filter((b) => !b.disabled).length,
       })`,
    ),
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
  return out;
};

/**
 * The surfaces, and what each must offer.
 *
 * `must` is what has to be there. `mustNot` is what would be wrong there, which is the half that
 * catches a menu built for somewhere else: markers act on a place in a screen of output, so a
 * start screen offering one is offering something that cannot happen.
 */
const PLACES = [
  {
    what: 'the start screen background',
    sel: '.launcher',
    must: ['Paste', 'Settings', 'Close tab'],
    mustNot: ['Add a marker here', 'Kill session'],
  },
  {
    what: 'a heading on it',
    sel: '.launcher-heading',
    must: ['Paste', 'New terminal tab'],
    mustNot: ['Add a marker here'],
  },
  {
    what: 'the path box',
    sel: '.launcher-input',
    must: ['Cut', 'Copy', 'Paste', 'Select all'],
    mustNot: ['Add a marker here'],
  },
  {
    what: 'a folder chip',
    sel: '.launcher-completion',
    must: ['Paste'],
    mustNot: ['Add a marker here'],
  },
  {
    what: 'the hint line',
    sel: '.launcher-hint',
    must: ['Paste', 'Settings'],
    mustNot: ['Add a marker here'],
  },
  {
    what: 'a session card in the running list',
    sel: '.session-card',
    must: ['Paste', 'Settings'],
    mustNot: ['Add a marker here'],
  },
];

for (const place of PLACES) {
  const menu = await menuOn(place.sel);
  if (menu === null) {
    r.skip(`right click on ${place.what}`, 'not on screen in this state');
    continue;
  }
  r.ok(
    `right click on ${place.what} opens a TabTerm menu`,
    menu.labels.length > 0,
    menu.labels.join(' | ').slice(0, 110),
  );
  const missing = place.must.filter((m) => !menu.labels.some((l) => l.includes(m)));
  r.ok(`  and offers what belongs there`, missing.length === 0, `missing: ${missing.join(', ')}`);
  const wrong = place.mustNot.filter((m) => menu.labels.some((l) => l.includes(m)));
  r.ok(`  and nothing that does not`, wrong.length === 0, `offered: ${wrong.join(', ')}`);
  r.ok(
    `  and every entry is usable`,
    menu.enabled > 0,
    `${String(menu.enabled)} of ${String(menu.labels.length)}`,
  );
}

/**
 * The terminal strip under the start screen belongs to the start screen.
 *
 * A tab showing its start screen still has a real terminal in it, a few rows tall below the
 * panel, and right-clicking that got the full pane menu: split it, name it, mark a place in it,
 * kill it. None of that means anything in a tab where nothing has happened yet, and splitting
 * rearranged the layout under a panel that is not laid out for two panes, which is what "split
 * right and split down work from the homescreen and they make the view all messed up" was.
 *
 * The pane declines the gesture rather than offering a shorter menu, so it travels on and the
 * page answers with the start screen's own.
 */
{
  const at = await evaluate(
    client,
    `(() => {
       const pane = document.querySelector('.pane');
       if (!pane) return '';
       const b = pane.getBoundingClientRect();
       const panel = document.querySelector('.launcher')?.getBoundingClientRect();
       // Below the panel, which is where the terminal is actually visible.
       const y = panel ? Math.round(panel.bottom + (b.bottom - panel.bottom) / 2) : Math.round(b.bottom - 8);
       if (y >= b.bottom || y <= b.top) return '';
       return JSON.stringify({ x: Math.round(b.left + b.width / 2), y });
     })()`,
  );
  const showing = await evaluate(
    client,
    `String(document.querySelector('.launcher')?.hidden === false)`,
  );
  if (String(at) === '' || String(showing) !== 'true') {
    r.skip(
      'right click on the terminal under the start screen',
      `no strip visible in this state (at=${String(at)}, showing=${String(showing)})`,
    );
  } else {
    const { x, y } = JSON.parse(String(at));
    await openPaneMenu(client, x, y);
    const labels = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
      ),
    );
    r.ok(
      'right click on the terminal under the start screen opens a menu',
      labels.length > 0,
      labels.join(' | '),
    );
    r.ok(
      "  and it is the start screen's, not the pane's",
      !labels.some((l) => l.includes('Split right') || l.includes('Split down')),
      labels.join(' | '),
    );
    r.ok(
      '  so nothing it offers acts on a terminal nobody has used',
      !labels.some(
        (l) =>
          l.includes('Add a marker') || l.includes('Kill session') || l.includes('Name session'),
      ),
      labels.join(' | '),
    );
    await evaluate(client, "document.querySelector('.term-menu')?.remove()");
  }
}

/**
 * A template chip is the one place on the start screen that answers for itself.
 *
 * Asked for: right clicking a template should do what the `i` on it does. So the general menu
 * must stay away, and what must not happen instead is Chrome's own menu, which is what a chip
 * that merely stopped the event from travelling would have left in charge.
 */
{
  const chip = await boxOf(client, '.launcher-template');
  if (chip === null) {
    r.skip('right click on a template chip', 'no template on screen in this state');
  } else {
    await openPaneMenu(client, chip.x + chip.width / 2, chip.y + chip.height / 2);
    r.ok(
      'right click on a template chip shows the template card, not the page menu',
      Boolean(await evaluate(client, `document.querySelector('.template-card') !== null`)),
    );
    r.ok(
      '  and the page menu stays away',
      !(await evaluate(client, `document.querySelector('.term-menu') !== null`)),
    );
    await evaluate(client, `document.querySelector('.template-card')?.remove()`);
  }
}

/**
 * The row says what it will do, not what it is called.
 *
 * "Open menu" while the menu is open either does nothing or reads as a bug. Right-clicking inside
 * the panel already said "Close menu"; everywhere else went on offering to open what was open.
 */
/**
 * Somewhere the panel is not, since the panel has a menu of its own.
 *
 * The top left corner of the page, which the command menu never occupies and which is the
 * "anywhere else" case: the small set, without paste, and the way to the menu.
 */
const menuInTheCorner = async () => {
  await openPaneMenu(client, 8, 8);
  const labels = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
    ),
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
  return labels;
};

await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await waitFor(client, `!document.querySelector('.cmd-panel')?.hidden`, 8000);
{
  const labels = await menuInTheCorner();
  r.ok(
    'with the menu open, the way to it says Close menu',
    labels.includes('Close menu') && !labels.includes('Open menu'),
    JSON.stringify(labels),
  );
}
// The button that opened it is the button that closes it, which is what a person would click.
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await waitFor(client, `document.querySelector('.cmd-panel')?.hidden === true`, 8000);
{
  const labels = await menuInTheCorner();
  r.ok(
    'and with it closed, it says Open menu again',
    labels.includes('Open menu') && !labels.includes('Close menu'),
    JSON.stringify(labels),
  );
}

/** The command menu and its own surfaces. */
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await waitFor(client, `!document.querySelector('.cmd-panel')?.hidden`, 8000);
{
  const menu = await menuOn('.cmd-header');
  r.ok(
    'right click in the command menu opens a TabTerm menu',
    (menu?.labels.length ?? 0) > 0,
    JSON.stringify(menu?.labels),
  );
  r.ok(
    '  and offers a way to put it away rather than a way to open it',
    menu?.labels.includes('Close menu') === true && menu.labels.includes('Open menu') === false,
    JSON.stringify(menu?.labels),
  );
}
await evaluate(client, `document.querySelector('.cmd-header .cmd-icon')?.click()`);
await sleep(500);

/** And after a split, on the pane that is offering to be filled. */
{
  await openPaneMenu(client, 80, 200);
  const split = await evaluate(
    client,
    `(() => { const b = [...document.querySelectorAll('.term-menu-item')].find(x => (x.textContent||'').trim() === 'Split right'); if (b) { b.click(); return 'yes'; } return 'no'; })()`,
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
  if (String(split) === 'yes') {
    await sleep(1800);
    const onChooser = await menuOn('.pane-chooser');
    r.ok(
      'right click on a pane offering to be filled still gives that pane its menu',
      (onChooser?.labels ?? []).some((l) => l.includes('Close session')),
      JSON.stringify(onChooser?.labels).slice(0, 120),
    );
  } else {
    r.skip('right click on a pane offering to be filled', 'could not split');
  }
}

/**
 * And the entries do what they say, which is the half a list of labels cannot show.
 *
 * Checked on the start screen, where the generic menu lives. The terminal's own menu has its own
 * suites and is not repeated here.
 */
{
  const openMenuOn = async (selector) => {
    const at = JSON.parse(
      String(
        await evaluate(
          client,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)});
             const b = el.getBoundingClientRect();
             return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`,
        ),
      ),
    );
    await openPaneMenu(client, at.x, at.y);
  };
  const press = (label) =>
    evaluate(
      client,
      `(() => { const b = [...document.querySelectorAll('.term-menu-item')]
         .find(x => (x.textContent || '').trim() === ${JSON.stringify(label)});
         if (!b) return 'missing'; b.click(); return 'pressed'; })()`,
    );

  // Settings, from the start screen, opens settings.
  await openMenuOn('.launcher-heading');
  r.ok('pressing Settings is possible', String(await press('Settings')) === 'pressed');
  const settingsUp = await waitFor(client, `!!document.querySelector('.cmd-settings')`, 8000);
  r.ok('  and it opens settings', settingsUp);

  // And Close menu, from inside it, puts it away.
  await openMenuOn('.cmd-header');
  r.ok('pressing Close menu is possible', String(await press('Close menu')) === 'pressed');
  const gone = await waitFor(
    client,
    `document.querySelector('.cmd-panel')?.hidden !== false`,
    8000,
  );
  r.ok('  and it puts the menu away', gone);

  // Select all, in the path box, selects what is in it.
  await evaluate(
    client,
    `(() => { const i = document.querySelector('.launcher-input');
    i.value = '/tmp/right-click-check'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(300);
  await openMenuOn('.launcher-input');
  r.ok('pressing Select all is possible', String(await press('Select all')) === 'pressed');
  await sleep(300);
  const selected = await evaluate(
    client,
    `(() => { const i = document.querySelector('.launcher-input');
       return String(i.selectionEnd - i.selectionStart); })()`,
  );
  r.ok(
    '  and it selects the whole box',
    Number(selected) === '/tmp/right-click-check'.length,
    String(selected),
  );

  // Copy, with something selected, is offered rather than greyed.
  await openMenuOn('.launcher-input');
  const copyState = await evaluate(
    client,
    `(() => { const b = [...document.querySelectorAll('.term-menu-item')]
       .find(x => (x.textContent || '').trim() === 'Copy'); return b ? String(!b.disabled) : 'missing'; })()`,
  );
  r.ok(
    '  and Copy is live once there is a selection',
    String(copyState) === 'true',
    String(copyState),
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");

  // With nothing selected, Cut and Copy are greyed rather than absent.
  await evaluate(
    client,
    `(() => { const i = document.querySelector('.launcher-input');
    i.setSelectionRange(0, 0); })()`,
  );
  await openMenuOn('.launcher-input');
  const greyed = await evaluate(
    client,
    `(() => { const items = [...document.querySelectorAll('.term-menu-item')];
       const cut = items.find(x => (x.textContent||'').trim() === 'Cut');
       const copy = items.find(x => (x.textContent||'').trim() === 'Copy');
       return JSON.stringify({ cut: cut ? cut.disabled : null, copy: copy ? copy.disabled : null }); })()`,
  );
  const state = JSON.parse(String(greyed));
  r.ok(
    'with nothing selected, Cut and Copy are greyed rather than missing',
    state.cut === true && state.copy === true,
    String(greyed),
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
}

/** A second right click puts an open menu away rather than stacking another on it. */
{
  await openPaneMenu(client, 90, 210);
  const first = Number(await evaluate(client, `document.querySelectorAll('.term-menu').length`));
  await openPaneMenu(client, 140, 240);
  const after = Number(await evaluate(client, `document.querySelectorAll('.term-menu').length`));
  r.ok(
    'right clicking again never leaves two menus open',
    first === 1 && after === 1,
    `${String(first)} then ${String(after)}`,
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
}

/**
 * And a terminal somebody is actually using offers the whole pane menu.
 *
 * Last, and after the start screen has gone, because that is the only state in which it applies.
 * It used to sit in the table above and be skipped every run: the start screen was up, so the
 * terminal was a strip with no measurable box, and the richest menu in the product was covered by
 * nothing at all.
 */
await type(client, 'echo right-click-everywhere');
await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
await sleep(600);
{
  const menu = await menuOn('.xterm-screen');
  if (menu === null) {
    r.skip('right click on a terminal in use', 'no terminal on screen in this state');
  } else {
    const must = ['Copy', 'Paste', 'Clear', 'Add a marker here', 'Close session', 'Kill session'];
    const missing = must.filter((m) => !menu.labels.some((l) => l.includes(m)));
    r.ok(
      'right click on a terminal in use offers the whole pane menu',
      missing.length === 0,
      `missing: ${missing.join(', ')} | had: ${menu.labels.join(' | ')}`,
    );
    r.ok('  and every entry is usable', menu.enabled > 0, String(menu.enabled));
  }
}

await finish();
r.done();
