// The offer to open a folder never appears over a pane that is in use. Not briefly, not at all.
//
// It is an offer for a pane with nothing in it, and it was being drawn over panes holding an agent
// and then taken away a second or two later. The end state was right, which is why this needs its
// own check: the fault is entirely in the moments before it, and a check that looks once after a
// reload sees nothing wrong.
//
// The cause is the order things arrive in. A layout can reach a page before the daemon's account of
// what is in each pane: `workspace-updated` carries a layout and no pane facts, and a page that has
// just connected can be sent one before its own attach is answered. Deciding then means deciding
// from an empty page, which answers "nothing in it" for every pane there is.
//
// So it is watched continuously through the whole reload rather than sampled at the end.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

// Two panes, both used, which is the arrangement the offer must stay out of.
await type(client, 'echo PANE-ONE-USED\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('PANE-ONE-USED')`, 20000);
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1500);
/*
 * Focused explicitly before typing into it.
 *
 * The first version of this assumed the split left the new pane focused and typed into the old
 * one, so the second pane was a bare prompt for the whole check. The offer over it was then
 * entirely correct, and the check reported two hundred and sixty two failures that were the
 * product behaving exactly as intended.
 */
const [, second] = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
/*
 * Typed until it lands, because focusing and typing are two events and the second can beat the
 * first. Two runs of this check failed on its own setup rather than on the product, once with the
 * second pane left as a bare prompt for the whole watch, which the offer is supposed to cover.
 */
let landed = false;
for (let attempt = 0; attempt < 5 && !landed; attempt++) {
  await evaluate(client, `window.__tabterm.focus(${JSON.stringify(second)})`);
  await sleep(500);
  await type(client, 'echo PANE-TWO-USED\r');
  /*
   * Waited for the output, not for the text of the command.
   *
   * A pane showing `% echo PANE-TWO-USED` contains the marker and is still one line of prompt,
   * which is exactly what the offer is for. The command having run is the second line.
   */
  landed =
    (await waitFor(
      client,
      `(window.__tabterm.readScreen(${JSON.stringify(second)}) ?? '').split('\\n').filter((l) => l.trim()).length > 1`,
      8000,
    )) === true;
}
r.ok('the second pane was actually typed into', landed);
// Both panes have run something now, which is the arrangement the offer must stay out of.
const used = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify(window.__tabterm.paneIds().map((id) => (window.__tabterm.readScreen(id) ?? '').split('\\n').filter((l) => l.trim()).length))`,
    ),
  ),
);
r.ok(
  'both panes have output in them, not a bare prompt',
  used.every((n) => n > 1),
  JSON.stringify(used),
);

const offerShowing = async () =>
  (await evaluate(client, `document.querySelectorAll('.pane-chooser').length`)) ?? 0;

r.ok('no offer over either pane to begin with', Number(await offerShowing()) === 0);

/**
 * Watched all the way through the reload, not asked afterwards.
 *
 * "It shows up for a few seconds and then goes" is the report, so the end state is not the
 * question. Every sample from the moment the page starts loading until well after it has settled
 * has to be clean.
 */
await client.send('Page.reload');
let sawOffer = 0;
let samples = 0;
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  let showing = 0;
  try {
    showing = Number(await offerShowing());
  } catch {
    // The page is between documents. Nothing is on screen to be wrong.
  }
  if (showing > 0) sawOffer += 1;
  samples += 1;
  await sleep(50);
}

r.ok(
  'and none at any point while the tab reloaded',
  sawOffer === 0,
  `${String(sawOffer)} of ${String(samples)} samples had the offer up`,
);

// And the panes really did come back, so the check above was not watching an empty page.
const panes = Number(await evaluate(client, 'window.__tabterm.paneIds().length'));
r.ok('and the two panes came back, so there was something to cover', panes === 2, String(panes));
r.ok(
  'and their output came back with them',
  String(
    await evaluate(client, `window.__tabterm.readScreen(${JSON.stringify(second)}) ?? ''`),
  ).includes('PANE-TWO-USED'),
);

/*
 * And a pane that really is empty is still offered something, which is the feature.
 *
 * A fix that never draws the offer at all would pass everything above and take away the thing it
 * exists for.
 */
await evaluate(client, "window.__tabterm.split('vertical')");
await waitFor(client, 'window.__tabterm.paneIds().length === 3', 20000);
const offered = await waitFor(
  client,
  `document.querySelectorAll('.pane-chooser').length > 0`,
  12000,
);
r.ok('but a genuinely empty pane is still offered somewhere to go', offered === true);

/*
 * And the case that survived the first fix: a pane somebody is working in where no command ever
 * finishes.
 *
 * That is every pane running an agent. The command is the agent itself and it runs for hours, so
 * nothing anybody types is a command that completes: the count of commands run says none, and the
 * screen says very little because a full-screen program draws on the alternate buffer. Reported
 * after the first attempt as still appearing "for like 1.5 seconds" over a working agent, which is
 * how long it takes the restored screen to fill in.
 *
 * Typed without Return here, which produces exactly that state without needing an agent: somebody
 * has typed into the pane, no command has run, and the screen is one line of prompt.
 */
await evaluate(client, "window.__tabterm.split('vertical')");
await waitFor(client, 'window.__tabterm.paneIds().length === 4', 20000);
await sleep(1200);
const fresh = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
).at(-1);
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(fresh)})`);
await sleep(500);
/*
 * Switched to the alternate screen, which is where an agent lives.
 *
 * This is the whole of why the other answers fail for that pane. A full-screen program draws on
 * the alternate buffer, so what the daemon serializes is nearly empty and the page sees one line.
 * The command is the agent itself and it runs for hours, so no command ever finishes and the count
 * of commands run stays at none. Typing into it is the only evidence that survives, and it is the
 * evidence the host keeps across a daemon restart.
 */
const altScreen = `printf '\\033[?1049h'`;
await type(client, `${altScreen}\r`);
await sleep(800);
await type(client, 'a prompt somebody is waiting on', { submit: false });
await sleep(1200);

await client.send('Page.reload');
/*
 * Counted over that pane alone, not over the tab.
 *
 * There is a genuinely empty pane in this tab by now, from the check above that the offer still
 * appears where it should. Counting every offer in the document counts that one too, and reports
 * the feature working as a failure.
 */
const offerOver = (id) =>
  evaluate(client, `document.querySelectorAll('.pane[data-pane-id="${id}"] .pane-chooser').length`);

let offerOverTyped = 0;
const until = Date.now() + 12000;
while (Date.now() < until) {
  let showing = 0;
  try {
    showing = Number(await offerOver(fresh));
  } catch {
    // Between documents.
  }
  if (showing > 0) offerOverTyped += 1;
  await sleep(50);
}
r.ok(
  'and none over a pane that was typed into but has run nothing',
  offerOverTyped === 0,
  `${String(offerOverTyped)} samples had an offer up`,
);

await finish();
r.done();
