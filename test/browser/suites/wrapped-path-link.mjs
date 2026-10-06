// A path a program broke across two rows is one link, and the whole of it is underlined.
//
// Reported from Claude Code in a narrow pane: the path was underlined on its first row only and
// pointed at the directory that row happened to name. xterm joins rows it wrapped itself; a
// program that fills a row and writes a newline leaves nothing to join, so the page joins a
// filled row ending in a path character to the row that follows, and lets the daemon say
// which of the results exist.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
const geo = JSON.parse(await evaluate(client, `JSON.stringify(window.__tabterm.geometry())`));
const cols = geo.cols;

// A file whose path is longer than the pane is wide, printed the way ink prints a bullet: the
// first row one column short of the pane, every row after it indented two spaces under it, so
// no row is marked as wrapped, no row is full, and no continuation starts with the path.
const tag = `wrap${String(Date.now()).slice(-6)}`;
const segment = 'a-long-directory-name-'.repeat(Math.ceil((cols + 30) / 22));
await type(
  client,
  `d=$(mktemp -d)/${tag}/${segment}x; mkdir -p "$d"; f="$d/changes.pdf"; touch "$f"; p="  PDF: $f"; printf '%s\\n' "\${p:0:${String(cols - 1)}}"; printf '%s\\n' "\${p:${String(cols - 1)}}" | fold -w ${String(cols - 3)} | sed 's/^/  /'`,
);
await sleep(2500);

// Measured again now that the start screen is gone: the strip under it sits lower and is
// shorter than the pane that replaces it, and a hover aimed with its geometry lands nowhere.
const geoNow = JSON.parse(await evaluate(client, `JSON.stringify(window.__tabterm.geometry())`));
const lines = (await evaluate(client, `window.__tabterm.readScreen()`)).split('\n');
// The printed rows, not the command that printed them: output starts at the first column.
const firstRow = lines.findIndex(
  (l) => l.startsWith('  PDF: /') && l.includes(tag) && l.length === cols - 1,
);
const rows = [];
for (let y = firstRow; firstRow >= 0 && y < lines.length && rows.length < 6; y++) {
  rows.push(lines[y]);
  if (lines[y].endsWith('changes.pdf')) break;
}
// What was printed, read back the way the page must read it: the first row from after its
// label, the continuations from after their indent.
const full = rows.map((row, i) => (i === 0 ? row.slice('  PDF: '.length) : row.slice(2))).join('');
const lastRow = firstRow + rows.length - 1;
r.ok(
  'the path is on screen across rows the program broke by hand',
  firstRow >= 0 && rows.length >= 2 && full.endsWith('changes.pdf'),
  `rows ${String(firstRow)} to ${String(lastRow)} of ${String(cols)} columns`,
);

r.ok(
  'the whole path is resolved before anybody hovers it',
  await waitFor(
    client,
    `(window.__tabterm.resolvedPaths() ?? []).some((p) => p.candidate === ${JSON.stringify(full)} && p.exists)`,
    8000,
  ),
  JSON.stringify(
    JSON.parse(
      await evaluate(
        client,
        `JSON.stringify((window.__tabterm.resolvedPaths() ?? []).map((p) => p.candidate))`,
      ),
    ).filter((c) => c.includes(tag)),
  ),
);

const hover = async (col, row) => {
  const y = Math.round(geoNow.top + (row + 0.5) * geoNow.cellHeight);
  for (const step of [-2, -1, 0]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(geoNow.left + (col + step) * geoNow.cellWidth),
      y,
      modifiers: 4,
    });
    await sleep(120);
  }
  await sleep(500);
};
const underlined = () =>
  evaluate(
    client,
    `[...document.querySelectorAll('.xterm-decoration')].filter((d) => d.style.borderBottom !== '').length`,
  );

// Park away first, then on the last row, which is the part that used to be inert.
await hover(10, lastRow + 5);
await hover(5, lastRow);
r.ok(
  'holding Command on the last row shows the path is clickable',
  await waitFor(client, "!!document.querySelector('.xterm-cursor-pointer')", 4000),
);
r.ok(
  'and every row of it is underlined, since all of them are the path',
  await waitFor(
    client,
    `[...document.querySelectorAll('.xterm-decoration')].filter((d) => d.style.borderBottom !== '').length === ${String(rows.length)}`,
    4000,
  ),
  `${String(await underlined())} underlined for ${String(rows.length)} rows, decorations at ${await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.xterm-decoration')].map((d) => { const b = d.getBoundingClientRect(); return { row: Math.round((b.top - ${String(geoNow.top)}) / ${String(geoNow.cellHeight)}), w: Math.round(b.width), ul: d.style.borderBottom !== '' }; }))`,
  )} rows ${String(firstRow)} to ${String(lastRow)}`,
);

await finish();
r.done();
