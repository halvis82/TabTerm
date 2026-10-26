// Pictures in the terminal: the iTerm2 inline image protocol that imgcat uses, and Sixel.
//
// Asked for from the list of ideas: "pictures in the terminal, imgcat, Sixel and the iTerm2
// inline-image protocol, as in iTerm2, WezTerm and Ghostty". A shell in a real terminal prints each
// kind, and the picture has to be drawn: red for the inline image, green for the Sixel one.
import { openTerminal, evaluate, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'clear\r');

// A red picture 40 by 20, as `imgcat` sends it.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAYAAAD/Rn+7AAAAL0lEQVR4nO3OMQ0AAAjAsPk3DSrIOHb0LwPzGXagYEE7ULCgHShY0A4ULGgHCl5biXs6G0TdvUkAAAAASUVORK5CYII=';
const counts = () =>
  evaluate(
    client,
    `(() => {
       const out = { red: 0, green: 0 };
       for (const layer of document.querySelectorAll('.xterm-image-layer')) {
         const ctx = layer.getContext('2d');
         if (!ctx || layer.width === 0) continue;
         const d = ctx.getImageData(0, 0, layer.width, layer.height).data;
         for (let i = 0; i < d.length; i += 4) {
           if (d[i + 3] < 200) continue;
           if (d[i] > 200 && d[i + 1] < 60) out.red++;
           if (d[i + 1] > 200 && d[i] < 60) out.green++;
         }
       }
       return JSON.stringify(out);
     })()`,
  ).then((s) => JSON.parse(String(s)));

await type(client, `printf '\\033]1337;File=inline=1;size=104:${PNG}\\a\\n'\r`);
const stored = () => evaluate(client, 'window.__tabterm.imagesStored()').then(Number);
r.ok(
  'an inline image, as imgcat prints it, is drawn',
  (await waitUntil(async () => (await counts()).red > 200, 10000)) && (await stored()) > 0,
  JSON.stringify({ ...(await counts()), stored: await stored() }),
);

// Sixel: green, six pixels high and thirty wide.
await type(client, `printf '\\033Pq#1;2;0;100;0#1${'~'.repeat(30)}\\033\\\\\\n'\r`);
r.ok(
  'and so is a Sixel picture',
  await waitUntil(async () => (await counts()).green > 100, 10000),
  JSON.stringify({ ...(await counts()), stored: await stored() }),
);

// A broken picture is skipped, and the terminal goes on: output after it still shows.
await type(
  client,
  `printf '\\033]1337;File=inline=1;size=64:${'A'.repeat(88)}\\a\\n'; echo after-a-broken-$((6*7))\r`,
);
r.ok(
  'a broken picture is skipped, and what comes after it still shows',
  await waitUntil(
    async () =>
      String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(
        'after-a-broken-42',
      ),
    10000,
  ),
);

// A program asks whether pictures are supported before sending one: the answer says Sixel (4).
// The answer is an escape sequence, so its first character is dropped before it is shown.
await type(client, `printf '\\033[c'; read -t 2 -s -d c ans; echo "DA=\${ans:1}"\r`);
const screen = () => evaluate(client, 'window.__tabterm.readScreen() ?? ""').then(String);
r.ok(
  'and the terminal says it can show Sixel when asked',
  await waitUntil(async () => /DA=\[\?[\d;]*\b4\b/.test(await screen()), 10000),
  (await screen())
    .split('\n')
    .filter((l) => l.startsWith('DA='))
    .join(' '),
);
await finish();
r.done();
