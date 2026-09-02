// A setting is a preference, so it applies everywhere and it applies now.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const a = await openTerminal();
await waitFor(a.client, "document.querySelector('.launcher-input')");
const b = await openTerminal();
await waitFor(b.client, "document.querySelector('.launcher-input')");

const themeOf = (c) => evaluate(c, "document.documentElement.dataset.theme ?? ''");
const bgOf = (c) =>
  evaluate(c, "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()");

r.ok('a tab starts on a theme rather than on nothing', String(await themeOf(a.client)) !== '');
const darkBg = String(await bgOf(a.client));

// The control used to write an attribute no stylesheet read, so changing it did nothing at all.
await evaluate(a.client, "window.__tabterm.setTheme('light')");
await sleep(500);
r.ok('changing the theme changes this tab', String(await themeOf(a.client)) === 'light');
const lightBg = String(await bgOf(a.client));
r.ok(
  'and actually repaints it, rather than only setting an attribute',
  lightBg !== darkBg,
  `${darkBg} -> ${lightBg}`,
);

// The terminal is drawn on a canvas, so it takes its colors from xterm rather than from CSS.
const termBg = String(
  await evaluate(a.client, "window.__tabterm.terminalTheme()?.background ?? ''"),
);
r.ok(
  'including the terminal itself, which no stylesheet can reach',
  termBg.toLowerCase() !== '#12131a',
  termBg,
);

// And it reaches the other tab, because a preference that only applies where it was typed is
// not a preference.
const spread = await waitFor(b.client, "document.documentElement.dataset.theme === 'light'", 6000);
r.ok('and reaches every other open tab', spread);

await evaluate(a.client, "window.__tabterm.setTheme('dark')");
await sleep(400);
await finish();
r.done();
