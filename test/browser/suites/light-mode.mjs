// Light mode is a theme, not a filter over a dark one.
//
// Reported as looking like garbage, and it did: most of the start screen was painted with the
// dark theme's colors written out by hand, so a white page was covered in near-black rectangles
// with gradients fading off them. The miniature on a session card, the box a path is typed into
// and the folder chips were all dark washes.
//
// Checked by measuring rather than by looking, because "looks fine" is not a thing a suite can
// see: every surface has to be lighter than its text, and every piece of text has to stand off
// what is behind it.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const seed = await openTerminal();
await waitFor(seed.client, "document.querySelector('.launcher-input')");
await type(seed.client, 'echo LIGHT-MODE-SEED');
await sleep(1600);

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(2200);

/** Luminance and contrast, the same way a browser's accessibility tools work it out. */
const MEASURE = `(() => {
  const lum = (c) => { const m = (c || '').match(/\\d+/g) || [0, 0, 0];
    const [r, g, b] = m.slice(0, 3).map(Number).map((v) => { const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const solidBehind = (el) => { let node = el;
    while (node) { const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      node = node.parentElement; }
    return 'rgb(255, 255, 255)'; };
  const worst = { contrast: 99, what: '' };
  const darkest = { lum: 9, what: '' };
  const sel = '.launcher-chip, .launcher-completion, .launcher-heading, .launcher-hint,' +
              ' .session-card, .session-title, .session-badge, .session-screen, .launcher-input';
  for (const el of document.querySelectorAll(sel)) {
    if (el.getBoundingClientRect().height < 2) continue;
    const s = getComputedStyle(el);
    const bg = solidBehind(el);
    /**
     * Only the surfaces something sits on, not every coloured thing.
     *
     * A badge is deliberately the accent, which is dark in light mode and is meant to be: it is
     * the one label that says a session is open somewhere. The claim being checked is that the
     * page and the panels on it are light, not that nothing anywhere is.
     */
    if (/session-card|session-screen|launcher-input|launcher-chip|launcher-completion/.test(el.className)) {
      const l = lum(bg);
      if (l < darkest.lum) { darkest.lum = Math.round(l * 1000) / 1000;
        darkest.what = el.className.slice(0, 34) + ' ' + bg; }
    }
    const text = (el.textContent || '').trim();
    if (text === '') continue;
    const l1 = lum(s.color), l2 = lum(bg);
    const c = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (c < worst.contrast) { worst.contrast = Math.round(c * 10) / 10;
      worst.what = el.className.slice(0, 34) + ' "' + text.slice(0, 14) + '" ' + s.color + ' on ' + bg; }
  }
  return JSON.stringify({ worst, darkest });
})()`;

await evaluate(client, `window.__tabterm.setTheme('light')`);
await sleep(900);
const light = JSON.parse(await evaluate(client, MEASURE));

/**
 * Nothing on a light page is painted dark.
 *
 * The threshold is generous: it is not asking for a particular shade, only that no surface is
 * one of the near-black rectangles that made this unusable. The worst offender was 0.005.
 */
r.ok(
  'no panel, card, box or chip on the start screen is dark in light mode',
  light.darkest.lum > 0.4,
  `${String(light.darkest.lum)} at ${light.darkest.what}`,
);
r.ok(
  'and every piece of text stands off what is behind it',
  light.worst.contrast >= 4.5,
  `${String(light.worst.contrast)}:1 at ${light.worst.what}`,
);

/** And the same page in dark mode, which must not have been made light by fixing it. */
await evaluate(client, `window.__tabterm.setTheme('dark')`);
await sleep(900);
const dark = JSON.parse(await evaluate(client, MEASURE));
r.ok(
  'dark mode is still dark',
  dark.darkest.lum < 0.2,
  `${String(dark.darkest.lum)} at ${dark.darkest.what}`,
);
r.ok(
  'and readable too',
  dark.worst.contrast >= 4.5,
  `${String(dark.worst.contrast)}:1 at ${dark.worst.what}`,
);

/**
 * And no decoration that fades content out.
 *
 * The list dissolved into the page at the bottom and the card miniatures faded at the top. Both
 * hid the thing being read, and over a light page both read as damage rather than as depth.
 */
const fades = JSON.parse(
  await evaluate(
    client,
    `(() => { const out = [];
       for (const el of document.querySelectorAll('.launcher-body, .session-screen, .launcher-hint')) {
         const s = getComputedStyle(el);
         const mask = s.maskImage || s.webkitMaskImage || 'none';
         if (mask !== 'none' || /gradient/.test(s.backgroundImage)) out.push(el.className.slice(0, 30));
       }
       return JSON.stringify(out); })()`,
  ),
);
r.ok('nothing fades the content it is showing', fades.length === 0, fades.join(' | '));

/**
 * Put the theme back the way it was found.
 *
 * A theme is a preference, so it is stored once and applies to every tab: leaving it set here
 * changed what a suite running beside this one saw, and one of them checks that switching the
 * theme repaints the page. It reported no change, correctly, because this suite had already
 * switched it.
 */
await evaluate(client, `window.__tabterm.setTheme('dark')`);
await sleep(400);

await finish();
r.done();
