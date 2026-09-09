// Six rows, and the rest one click away.
//
// The start screen is a shortcut, not an inventory, so its lists are cut short. That is only
// reasonable if the rest is reachable, and the two numbers involved have to agree: a section that
// draws six and offers "show 9 more" while holding eight is counting one list twice.
//
// The arithmetic is checked in `launcher.test.ts`, where it is a pure function and every case can
// be stated. This checks the wiring, which is the part that can be right on paper and dead in the
// page: that a control is drawn at all, that clicking it grows the list, and that it survives
// being opened so the list can be closed again.
import { openTerminal, evaluate, sleep, finish, realClick, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const COLLAPSED = 6;
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
// The lists arrive from the daemon after the screen is drawn, so this waits for the answers
// rather than for the shape.
await waitFor(client, `document.querySelectorAll('.launcher-section').length > 1`, 20000);
await sleep(600);

/** Every section, and whether it holds more than it is showing. */
const survey = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.launcher-section')].map((s) => {
         const more = s.querySelector('.launcher-more');
         return {
           heading: s.querySelector('.launcher-heading')?.textContent ?? '',
           rows: s.querySelectorAll('.launcher-row-wrap').length,
           control: more ? more.textContent : null,
           open: more ? more.getAttribute('aria-expanded') : null,
         };
       }))`,
    ),
  );

const before = await survey();

// No section may ever draw more than the collapsed cap while closed. True on any machine,
// including one with nothing stored, so it is checked before anything that needs a long list.
r.ok(
  'no section draws more than six while closed',
  before.every((s) => s.rows <= COLLAPSED),
  JSON.stringify(before.map((s) => `${s.heading}:${s.rows}`)),
);

const target = before.find((s) => s.control !== null);
if (!target) {
  // A machine with six or fewer of everything. The cap is still checked above, and a control
  // nobody can reach is the correct outcome rather than a missing test.
  r.ok(
    'nothing here holds more than six, so no control is offered',
    before.every((s) => s.control === null),
    JSON.stringify(before.map((s) => s.heading)),
  );
} else {
  r.ok(
    'a full section says how many more it has, rather than only offering to show them',
    /^Show \d+ more$/.test(target.control),
    `${target.heading}: ${target.control}`,
  );
  r.ok('and it is closed to six until asked', target.rows === COLLAPSED, String(target.rows));

  const promised = Number(/\d+/.exec(target.control)?.[0] ?? '0');

  await realClick(client, '.launcher-more');
  await sleep(400);
  const opened = (await survey()).find((s) => s.heading === target.heading);
  r.ok(
    'clicking it shows exactly what it promised',
    opened.rows === target.rows + promised,
    `${target.rows} + ${promised} -> ${opened.rows}`,
  );
  r.ok(
    'the control stays, so the list can be closed again',
    opened.control === 'Show fewer' && opened.open === 'true',
    JSON.stringify(opened),
  );

  await realClick(client, '.launcher-more');
  await sleep(400);
  const closed = (await survey()).find((s) => s.heading === target.heading);
  r.ok('and closing it puts the list back', closed.rows === COLLAPSED, String(closed.rows));
}

await finish();
r.done();
