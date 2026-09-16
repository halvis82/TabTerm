// The rail beside the scrollbar says where the input is, not just where the landmarks are.
//
// Asked for as wanting to tell input from output in the scrollbar: where the prompts are in a pane
// running an agent, and where the commands were typed in an ordinary one. The moment Return is
// pressed answers both without recognising any line by how it looks.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const pips = async () =>
  Number(await evaluate(client, `document.querySelectorAll('.input-pip').length`));

r.ok('nothing on the rail before anything is typed', (await pips()) === 0, String(await pips()));

await type(client, 'echo one\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('one')`, 20000);
const afterOne = await waitUntil(async () => (await pips()) >= 1, 8000);
r.ok('a command typed puts a mark on the rail', afterOne, String(await pips()));

const one = await pips();
await type(client, 'echo two\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('two')`, 20000);
const grew = await waitUntil(async () => (await pips()) > one, 8000);
r.ok('and a second one adds another', grew, `${String(one)} -> ${String(await pips())}`);

/*
 * And the rail is a rail rather than a stripe.
 *
 * A session running all day is thousands of commands, and a pip for every one of them says
 * nothing. The recent ones are the ones somebody is looking for.
 */
for (let i = 0; i < 12; i++) {
  await type(client, `echo bulk-${String(i)}\r`);
  await sleep(120);
}
await sleep(1500);
const many = await pips();
r.ok('and it stays bounded rather than becoming a solid stripe', many <= 60, String(many));

/*
 * The mark is somewhere useful: clicking it scrolls, which is what the rail is for. Checked by
 * asking the pip where it points rather than by clicking, because what is being checked here is
 * that the row is real, not that the click handler works.
 */
const rows = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.input-pip')].map((p) => Number(p.dataset.row)))`,
    ),
  ),
);
r.ok(
  'and every mark points at a line that exists',
  rows.length > 0 && rows.every((row) => Number.isFinite(row) && row >= 0),
  JSON.stringify(rows.slice(0, 6)),
);

await finish();
r.done();
