// A right click on a Running Now card offers what to do with that session, and paste goes
// somewhere.
//
// Two things reported together. The card had a menu about the folder it sits in and nothing about
// the terminal on it, which is the thing a person is looking at. And the start screen's Paste
// entry did nothing at all: it wrote to the focused pane, and nothing focuses a pane while the
// panel has the keyboard, so the one state where it is offered is the one state where it had no
// target. The strip along the bottom did not offer Paste at all.
import { openTerminal, evaluate, sleep, finish, waitFor, type, realClick } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A session for the list, in a tab that then goes to the background.
const donor = await openTerminal();
await waitFor(donor.client, "document.querySelector('.launcher-input')");
await type(donor.client, 'echo CARD-MENU');
await sleep(2500);

const here = await openTerminal();
await waitFor(here.client, "document.querySelector('.launcher-input')");
await sleep(2500);

/** Right click something and read back what the menu offers. */
const menuOver = async (selector) => {
  await evaluate(here.client, "document.querySelector('.term-menu')?.remove()");
  const opened = await evaluate(
    here.client,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
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
      here.client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => b.textContent))`,
    ),
  );
};

const onCard = await menuOver('.session-card');
r.ok('a card offers opening the session', onCard.includes('Open session'), onCard.join(' | '));
r.ok('and ending it', onCard.includes('Kill session'), onCard.join(' | '));
r.ok(
  'and still offers what the folder offers',
  onCard.includes('Open in Finder') && onCard.includes('Copy path'),
  onCard.join(' | '),
);

const onPane = await menuOver('.pane');
r.ok('the terminal itself offers Paste', onPane.includes('Paste'), onPane.join(' | '));
await evaluate(here.client, "document.querySelector('.term-menu')?.remove()");

/**
 * And Paste reaches the shell, driven the whole way: a real clipboard, the real menu entry, and a
 * real click on it.
 *
 * The first version of this called the paste path directly and passed while the menu entry did
 * nothing at all, which is worse than no test. What it skipped is where the bug was: xterm keeps
 * a hidden textarea to receive keystrokes, it is what `document.activeElement` reports whenever a
 * terminal has the keyboard, and it is an `HTMLTextAreaElement`, so "is a text box focused"
 * answered yes and the clipboard went into a box nobody can see.
 */
await evaluate(here.client, `navigator.clipboard.writeText('PASTE-ME-FOR-REAL')`);
await evaluate(
  here.client,
  `(() => {
     const el = document.querySelector('.sessions') ?? document.querySelector('.launcher');
     const b = el.getBoundingClientRect();
     el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
       clientX: Math.round(b.left + 40), clientY: Math.round(b.top + 10) }));
   })()`,
);
await sleep(700);
await realClick(here.client, '.term-menu-item', 'Paste');

const landed = await waitFor(
  here.client,
  `(window.__tabterm.readViewport() ?? '').includes('PASTE-ME-FOR-REAL')`,
  8000,
);
r.ok('pressing Paste in the menu reaches the shell', landed);

// And it went to the shell rather than into the hidden box, which is a different failure that
// looks identical from the outside: nothing visible happens either way.
const hidden = String(
  await evaluate(here.client, `document.querySelector('.xterm-helper-textarea')?.value ?? ''`),
);
r.ok("and not into the terminal's hidden helper textarea", !hidden.includes('PASTE-ME'), hidden);

await finish();
r.done();
