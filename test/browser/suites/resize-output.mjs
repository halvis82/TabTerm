// Resizing a pane must not add anything to what the terminal has printed.
//
// Reported after running one `ls`: resizing the window left several blank prompt lines under the
// output. A terminal that grows its own transcript when a window is dragged is writing history
// nobody wrote, and the scrollback it ends up with is not the one that happened.
//
// The window is resized through the debugging protocol, which is the same event a person dragging
// a window corner produces, rather than by telling the page a number.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

/*
 * Filled first, so the buffer has scrolled and the prompt is on the last row.
 *
 * The report came from a terminal with a long command's output above the prompt, and a resize is
 * a different operation on a buffer that has scrolled: the rows move under the cursor. A probe
 * against an almost empty screen resized cleanly and proved nothing.
 */
await type(client, 'for i in $(seq 1 120); do echo filler-$i; done\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('filler-120')`, 20000);
await sleep(600);
await type(client, 'ls\r');
await sleep(1500);

/** Lines with anything on them, which is what growing a transcript would change. */
const lines = async () => {
  const screen = String(await evaluate(client, 'window.__tabterm?.readScreen() ?? ""'));
  return screen.split('\n').filter((l) => l.trim() !== '');
};

const before = await lines();
r.ok(
  'the command ran',
  before.some((l) => l.includes('ls')),
  before.slice(-3).join(' | '),
);

/**
 * Several sizes, the way a drag produces them, then back to where it started.
 *
 * One resize proves little: the report is about dragging, which is a stream of them, and a shell
 * redrawing its prompt once in place is correct behavior that only becomes a transcript when it
 * happens repeatedly and each redraw lands on a new line.
 */
const sizes = [
  [1100, 780],
  [980, 720],
  [1180, 820],
  [900, 700],
  [1200, 800],
];
for (const [width, height] of sizes) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);
}
await client.send('Emulation.clearDeviceMetricsOverride');
await sleep(1200);

const after = await lines();
/*
 * A prompt may be redrawn. It may not be redrawn onto a new line each time, which is the
 * difference between a terminal reflowing and a terminal narrating.
 */
const grewBy = after.length - before.length;
r.ok(
  'resizing did not add lines to the transcript',
  grewBy <= 1,
  `${String(before.length)} -> ${String(after.length)}: ${after.slice(-6).join(' | ')}`,
);

const promptsBefore = before.filter((l) => l.includes('%')).length;
const promptsAfter = after.filter((l) => l.includes('%')).length;
r.ok(
  'and did not leave a stack of prompts behind',
  promptsAfter - promptsBefore <= 1,
  `${String(promptsBefore)} -> ${String(promptsAfter)}`,
);

/**
 * And the daemon's copy of the screen agrees with the page's.
 *
 * Two emulators reflow the same buffer on a resize: xterm in the page, and the daemon's headless
 * one, which is what a reattaching tab is rebuilt from. A resize that is clean in the page and
 * grows the daemon's copy is invisible until the next time a tab is restored, and then it is the
 * transcript somebody keeps.
 */
{
  await client.send('Page.reload');
  await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 25000);
  await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('$')`, 20000).catch(
    () => {},
  );
  await sleep(1500);
  const restored = await lines();
  r.ok(
    'the restored screen is the one the page had',
    Math.abs(restored.length - after.length) <= 1,
    `page ${String(after.length)} -> restored ${String(restored.length)}: ${restored.slice(-6).join(' | ')}`,
  );
  const promptsRestored = restored.filter((l) => l.includes('%')).length;
  r.ok(
    'and has no stack of prompts the page never had',
    promptsRestored - promptsAfter <= 1,
    `${String(promptsAfter)} -> ${String(promptsRestored)}`,
  );
}

/**
 * And the same again by dragging the divider between two panes, which is what was reported.
 *
 * A pane resized by a divider is a different path from a window resized by its corner: the window
 * tells every pane at once, and a divider changes two of them against each other, many times, as
 * fast as the pointer moves.
 */
{
  await evaluate(client, "window.__tabterm.split('horizontal')");
  await sleep(2500);
  await waitFor(client, 'window.__tabterm.paneIds().length === 2');
  const linesIn = async (paneId) => {
    const screen = String(
      await evaluate(client, `window.__tabterm?.readScreen(${JSON.stringify(paneId)}) ?? ""`),
    );
    return screen.split('\n').filter((l) => l.trim() !== '').length;
  };
  const [first] = JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
  );
  const wasThere = await linesIn(first);

  const box = JSON.parse(
    String(
      await evaluate(
        client,
        `(() => { const d = document.querySelector('.divider'); if (!d) return '""';
           const b = d.getBoundingClientRect();
           return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`,
      ),
    ),
  );
  if (typeof box === 'object' && box !== null && 'x' in box) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    for (const dx of [-60, -120, -40, 40, 120, 0]) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x + dx,
        y: box.y,
        button: 'left',
      });
      await sleep(180);
    }
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(1500);
    const nowThere = await linesIn(first);
    r.ok(
      'dragging the divider did not add lines to a pane',
      nowThere - wasThere <= 1,
      `${String(wasThere)} -> ${String(nowThere)}`,
    );
  } else {
    r.skip('dragging the divider did not add lines to a pane', 'no divider on screen');
  }
}

/**
 * And the window resized while the tab is split, which is what was reported.
 *
 * A split tab is the case where a window resize is not one resize: both panes change at once, each
 * one by a different amount, and each one is a separate message to a separate shell. Reported as
 * blank prompt lines appearing under an `ls` after the window was dragged.
 */
{
  await waitFor(client, 'window.__tabterm.paneIds().length === 2');
  const ids = JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
  );
  const linesIn = async (paneId) => {
    const screen = String(
      await evaluate(client, `window.__tabterm?.readScreen(${JSON.stringify(paneId)}) ?? ""`),
    );
    return screen.split('\n').filter((l) => l.trim() !== '');
  };
  // Something short in the second pane, so both have a transcript worth counting.
  await evaluate(client, `window.__tabterm.focusPane(${JSON.stringify(ids[1])})`).catch(() => {});
  await type(client, 'ls\r');
  await sleep(1500);

  const was = [await linesIn(ids[0]), await linesIn(ids[1])];
  const sentBefore = Number(await evaluate(client, 'window.__tabterm.sizesSentForTest()'));
  /*
   * Fast, and many, which is what a drag is.
   *
   * Five resizes with half a second between them is five settled sizes, and it passed while the
   * reported fault was real: it only appeared under a full run, where everything is slower and a
   * resize produces more intermediate sizes. A drag is what produces them, so this drags. Measured
   * on the run that caught it: five window resizes became twenty one distinct sizes for one
   * session, and the shell redrew its prompt for each.
   */
  for (let step = 0; step < 4; step++) {
    for (const [width, height] of [
      [1150, 800],
      [1080, 760],
      [1010, 720],
      [960, 700],
      [1040, 740],
      [1120, 780],
      [1200, 800],
    ]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(40);
    }
  }
  await sleep(600);
  await client.send('Emulation.clearDeviceMetricsOverride');
  await sleep(1500);

  /**
   * How many sizes the shell was told about, which is the thing being fixed.
   *
   * The stack of prompt lines only appears when the machine is loaded enough for a resize to
   * produce many intermediate sizes, so a check for the lines alone passes on a quiet machine
   * whether or not the fault is there. This does not: 28 frames of a drag are 28 frames, and a
   * terminal that turns each of them into a `SIGWINCH` is the whole of what went wrong.
   */
  const sentAfter = Number(await evaluate(client, 'window.__tabterm.sizesSentForTest()'));
  r.ok(
    'a drag of 28 frames is not 28 sizes for the shell to redraw at',
    sentAfter - sentBefore <= 12,
    `${String(sentAfter - sentBefore)} sizes sent for 28 frames across 2 panes`,
  );

  const now = [await linesIn(ids[0]), await linesIn(ids[1])];
  for (const i of [0, 1]) {
    r.ok(
      `resizing the window did not add lines to pane ${String(i + 1)} of a split tab`,
      now[i].length - was[i].length <= 1,
      `${String(was[i].length)} -> ${String(now[i].length)}: ${now[i].slice(-5).join(' | ')}`,
    );
  }
}

await finish();
r.done();
