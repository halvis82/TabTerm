// Keeping a session alive, from the card and from the pane, and saying so everywhere.
//
// Asked for as a keep alive feature: purple text saying (kept alive), reachable by right click
// from the start screen or from the session itself, so the terminal survives its tab and Chrome
// closing. The daemon already honoured a pinned session in its reap policy and nothing ever set
// the flag. This checks the two menus set it, that every surface says it, and that it can be
// taken back.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  type,
  realClick,
  openPaneMenu,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A session for the list, in a tab that then goes to the background.
const donor = await openTerminal();
await waitFor(donor.client, "document.querySelector('.launcher-input')");
await type(donor.client, 'echo KEEP-ALIVE-SUITE');
await sleep(2500);

/**
 * Our card, found by what the donor typed into it.
 *
 * Never the first card: the suites share one daemon, so Running Now also lists whatever the
 * suites running beside this one have started, and a session that appears a second later goes
 * to the front of the list.
 */
const CARD =
  "[...document.querySelectorAll('.session-card')].find((c) => c.textContent.includes('KEEP-ALIVE-SUITE'))";

const here = await openTerminal();
await waitFor(here.client, "document.querySelector('.launcher-input')");
await waitFor(here.client, CARD, 12000);

/** Right click an element and read back what the menu offers. */
const menuOver = async (client, finder) => {
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
  const opened = await evaluate(
    client,
    `(() => {
       const el = ${finder};
       if (!el) return 'missing';
       const b = el.getBoundingClientRect();
       el.dispatchEvent(new MouseEvent('contextmenu', {
         bubbles: true, cancelable: true,
         clientX: Math.round(b.left + b.width / 2),
         clientY: Math.round(b.top + b.height / 2),
       }));
       return 'sent';
     })()`,
  );
  if (opened !== 'sent') return [opened];
  await sleep(600);
  return JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => b.textContent))`,
    ),
  );
};
const keptOnCard = () =>
  evaluate(here.client, `${CARD}?.querySelector('.session-kept')?.textContent ?? ''`);
const donorKnows = () => evaluate(donor.client, 'JSON.stringify(window.__tabterm.keptAlive())');

r.ok('a card is not kept alive until somebody asks', (await keptOnCard()) === '');
const offered = await menuOver(here.client, CARD);
r.ok(
  'a card offers keeping the session alive',
  offered.includes('Keep alive'),
  offered.join(' | '),
);

const clicked = await realClick(here.client, '.term-menu-item', 'Keep alive');
r.ok(
  'and the card then says so',
  await waitFor(
    here.client,
    `${CARD}?.querySelector('.session-kept')?.textContent === '(kept alive)'`,
    8000,
  ),
  `card=${JSON.stringify(await keptOnCard())} clicked=${JSON.stringify(clicked)} page=${await evaluate(
    here.client,
    `JSON.stringify({ start: !!document.querySelector('.launcher-input'), menu: !!document.querySelector('.term-menu'), cards: document.querySelectorAll('.session-card').length, ours: !!(${CARD}) })`,
  )} donor=${await donorKnows()}`,
);

// In purple, which is the colour the feature was asked for in.
const colours = JSON.parse(
  await evaluate(
    here.client,
    `(() => {
       const probe = document.createElement('span');
       probe.style.color = 'var(--kept)';
       document.body.append(probe);
       const wanted = getComputedStyle(probe).color;
       probe.remove();
       const kept = ${CARD}?.querySelector('.session-kept');
       const drawn = kept ? getComputedStyle(kept).color : 'missing';
       return JSON.stringify({ wanted, drawn });
     })()`,
  ),
);
r.ok(
  'in the purple the theme names for it',
  colours.drawn === colours.wanted,
  JSON.stringify(colours),
);

const offeredAgain = await menuOver(here.client, CARD);
r.ok(
  'and the menu now offers taking it back',
  offeredAgain.includes('Stop keeping alive') && !offeredAgain.includes('Keep alive'),
  offeredAgain.join(' | '),
);
await evaluate(here.client, "document.querySelector('.term-menu')?.remove()");

// The tab holding the session is told as well, which is what its menu and bar draw from.
r.ok(
  'the tab holding the session is told',
  await waitFor(donor.client, 'window.__tabterm.keptAlive().length === 1', 8000),
  await donorKnows(),
);

// The pane's own menu shows the same fact, ticked, in the tab that holds the session.
await openPaneMenu(donor.client, 60, 60);
await sleep(300);
const onPane = JSON.parse(
  await evaluate(
    donor.client,
    `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => ({ label: b.textContent, tick: b.querySelector('.term-menu-tick')?.textContent ?? '' })))`,
  ),
);
const paneEntry = onPane.find((i) => i.label.includes('Keep alive'));
r.ok(
  'the pane menu offers it too',
  paneEntry !== undefined,
  JSON.stringify(onPane.map((i) => i.label)),
);
r.ok(
  'ticked, since the card already set it',
  paneEntry?.tick === '✓',
  `${JSON.stringify(paneEntry)} kept=${await donorKnows()} panes=${await evaluate(donor.client, 'JSON.stringify(window.__tabterm.paneSessions())')}`,
);

// And takes it back from there, which the card reflects.
await realClick(donor.client, '.term-menu-item', 'Keep alive');
r.ok(
  'taking it back from the pane clears the card',
  await waitFor(here.client, `!${CARD}?.querySelector('.session-kept')`, 8000),
  await keptOnCard(),
);

await finish();
r.done();
