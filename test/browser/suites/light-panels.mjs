// The panels in light mode, which the start-screen check could not see.
//
// Measured separately because they are drawn over the terminal rather than on the page, and
// because the first pass at light mode fixed what was visible in a screenshot and left the
// command menu with five things nobody could read: the tabs at 3.2 to 1, the chosen tab at 2.9,
// and the two buttons that end things at 1.7 and 2.3, which for a warning is worse than nothing.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await evaluate(client, `window.__tabterm.setTheme('light')`);
await sleep(700);
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(900);
const MEASURE = `(() => {
  const lum = (c) => { const m = (c||'').match(/[0-9]*\\.?[0-9]+/g) || [0,0,0];
    const [r,g,b] = m.slice(0,3).map(Number).map(v => { const s = v > 1 ? v/255 : v;
      return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
    return 0.2126*r + 0.7152*g + 0.0722*b; };
  const behind = (el) => { let n = el; while (n) { const b = getComputedStyle(n).backgroundColor;
    if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b; n = n.parentElement; }
    return 'rgb(255,255,255)'; };
  /**
   * The accent as the browser computes it, not as it is written.
   *
   * The token is a hex string and a computed background is an rgb triple, so comparing them
   * directly never matches. Letting the browser resolve it is the only comparison that means
   * anything, and it costs one element that is removed immediately.
   */
  const probe = document.createElement('div');
  probe.style.backgroundColor = 'var(--accent)';
  document.body.append(probe);
  const accentRgb = getComputedStyle(probe).backgroundColor;
  probe.remove();

  const bad = [];
  for (const el of document.querySelectorAll('.cmd-panel *')) {
    const b = el.getBoundingClientRect(); if (b.height < 3 || b.width < 3) continue;
    const s = getComputedStyle(el); const bg = behind(el);
    const text = (el.textContent||'').trim();
    if (el.children.length === 0 && text) {
      const l1 = lum(s.color), l2 = lum(bg);
      const c = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      if (c < 4.5) bad.push({ what: (el.className||el.tagName).toString().slice(0,26), t: text.slice(0,12), c: Math.round(c*10)/10, color: s.color, bg });
    }
    /**
     * A surface painted with the accent is deliberate, whatever its luminance.
     *
     * The chosen tab and the open gear are meant to be the most legible things in their rows,
     * which in light mode means the accent behind them rather than a tint of it under the text.
     * The claim being checked is that no surface is dark **by accident**.
     */
    const own = s.backgroundColor;
    const isAccent = own === accentRgb;
    if (!isAccent && own !== 'rgba(0, 0, 0, 0)' && own !== 'transparent' && lum(own) < 0.25 && b.height > 12 && b.width > 40) {
      bad.push({ what: (el.className||el.tagName).toString().slice(0,26), dark: own, size: Math.round(b.width)+'x'+Math.round(b.height) });
    }
  }
  return JSON.stringify(bad.slice(0, 6));
})()`;
const bad = JSON.parse(await evaluate(client, MEASURE));
r.ok('the command menu is readable and light in light mode', bad.length === 0, JSON.stringify(bad));
await evaluate(client, `document.querySelector('.cmd-gear')?.click()`);
await sleep(900);
const badSettings = JSON.parse(await evaluate(client, MEASURE));
r.ok('and so is settings', badSettings.length === 0, JSON.stringify(badSettings));
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
