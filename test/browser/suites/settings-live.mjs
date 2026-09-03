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

/**
 * The settings page, and what it says about where you are.
 *
 * Settings are not one of the tabs across the top, so while they are open none of those tabs is
 * current. The highlight followed the remembered tab, so pressing the gear left Actions still
 * lit, which says you are on a page you are not on.
 */
// Opened first. The panel's elements exist while it is closed, so clicking them worked and
// nothing redrew, because a closed panel declines to re-render.
await evaluate(a.client, 'document.querySelector("#cmd-button")?.click()');
await sleep(600);
r.ok(
  'the panel is open before anything is asked of it',
  Boolean(await evaluate(a.client, '!!document.querySelector(".cmd-panel:not([hidden])")')),
);
await evaluate(a.client, 'document.querySelector(".cmd-tab[data-tab=\'actions\']")?.click()');
await sleep(400);
r.ok(
  'a tab is lit while you are on it',
  Boolean(
    await evaluate(
      a.client,
      'document.querySelector(".cmd-tab[data-tab=\'actions\']")?.classList.contains("on")',
    ),
  ),
);

await evaluate(a.client, 'document.querySelector(".cmd-gear")?.click()');
await sleep(500);
r.ok(
  'opening settings lights the gear',
  Boolean(
    await evaluate(a.client, 'document.querySelector(".cmd-gear")?.classList.contains("on")'),
  ),
);
r.ok(
  'and stops lighting the tab you came from',
  Number(await evaluate(a.client, 'document.querySelectorAll(".cmd-tab.on").length')) === 0,
);

/**
 * The keep-alive picker offers what it can actually store, and stores what is picked.
 *
 * One machine sat on "1 minutes" in a list whose shortest choice is five: the browser suites
 * used to run against the daemon somebody was working in, and one of them sets the timeout to a
 * second to test expiry, which the daemon clamps to sixty. Nobody chose that. A stored value
 * below the shortest the panel offers is ignored now, and the suites have their own daemon.
 *
 * The round trip is what is checked rather than the starting value, because the starting value
 * is whatever the daemon was last told and that is not this suite's business.
 */
const timeoutSelect = `[...document.querySelectorAll('.set-field')].find((f) => f.textContent.includes('after its tab closes'))?.querySelector('select')`;
const offered = JSON.parse(
  String(
    await evaluate(
      a.client,
      `JSON.stringify([...(${timeoutSelect}?.options ?? [])].map((o) => o.value))`,
    ),
  ),
);
r.ok(
  'the keep-alive picker offers the useful range, an hour included',
  ['300', '900', '1800', '3600', '14400', 'forever'].every((v) => offered.includes(v)),
  JSON.stringify(offered),
);

await evaluate(
  a.client,
  `(() => { const sel = ${timeoutSelect}; if (sel) { sel.value = '3600'; sel.dispatchEvent(new Event('change', { bubbles: true })); } })()`,
);
const stored = await waitFor(a.client, 'window.__tabterm.keepAlive() === 3600', 8000);
r.ok(
  'and picking an hour is what the daemon is actually told',
  stored,
  String(await evaluate(a.client, 'JSON.stringify(window.__tabterm.keepAlive())')),
);

/**
 * A picker for how long a notification you are not receiving has to have taken is a puzzle,
 * not a setting. It appears with the switch that governs it and goes with it.
 */
const thresholdShown = () =>
  evaluate(
    a.client,
    `[...document.querySelectorAll('.set-label')].some((el) => el.textContent.includes('took longer than'))`,
  );
const notifySwitch = `[...document.querySelectorAll('.set-toggle')].find((el) => el.textContent.includes('Tell me when something finishes'))?.querySelector('input')`;

/**
 * Set and dispatched, not clicked.
 *
 * The switch is an input inside a label, so a synthetic click on it is re-dispatched by the
 * label and lands twice, leaving the switch exactly where it started.
 */
const setNotify = async (on) => {
  await evaluate(
    a.client,
    `(() => { const box = ${notifySwitch}; if (box) { box.checked = ${String(on)}; box.dispatchEvent(new Event('change', { bubbles: true })); } })()`,
  );
  await sleep(1200);
};

const wasOn = Boolean(await evaluate(a.client, `${notifySwitch}?.checked`));
await setNotify(true);
r.ok('the threshold is offered while notifications are on', Boolean(await thresholdShown()));

await setNotify(false);
r.ok(
  'and is gone when they are off',
  !(await thresholdShown()),
  `switch now ${String(await evaluate(a.client, `${notifySwitch}?.checked`))}, labels: ` +
    String(
      await evaluate(
        a.client,
        `JSON.stringify([...document.querySelectorAll('.set-label')].map((e) => e.textContent.slice(0, 28)))`,
      ),
    ),
);

// Put it back the way it was found.
await setNotify(wasOn);

await finish();
r.done();
