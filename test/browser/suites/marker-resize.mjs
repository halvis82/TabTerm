// Check the painted pixels as well as the buffer through a split and window resizes.
import { openTerminal, evaluate, type, waitFor, finish, sleep, decodePng } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
const r = reporter();
const { client } = await openTerminal();
try {
  await type(client, 'echo marker-resize');
  await waitFor(client, "document.querySelector('.pane-time')?.textContent.startsWith('took ')");
  const pane = (await evaluate(client, 'window.__tabterm.paneIds()'))[0];
  await evaluate(client, "window.__tabterm.insertMarker('resize landmark', '#8ae2a0')");
  await waitFor(client, 'window.__tabterm.markers().length === 1');
  async function check(name) {
    await evaluate(client, `window.__tabterm.focus(${JSON.stringify(pane)})`);
    await waitFor(client, 'window.__tabterm.markers().length === 1');
    const mark = (await evaluate(client, 'window.__tabterm.markers()'))[0];
    await evaluate(client, `window.__tabterm.scrollToLine(${mark.row})`);
    await sleep(600);
    const { grid, viewport, marks } = await evaluate(
      client,
      '({grid: window.__tabterm.geometry(), viewport: window.__tabterm.viewportY(), marks: window.__tabterm.markers()})',
    );
    r.ok(`${name}: one landmark survives`, marks.length === 1, JSON.stringify(marks));
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    const png = decodePng(Buffer.from(data, 'base64'));
    let good = 0;
    const height = marks[0]?.height ?? 3;
    // The last cell was never printed even at the original width. Only the renderer's
    // background decoration can fill it, including short wrapped tails after narrowing.
    for (let row = 0; row < height; row++) {
      const x = Math.floor(grid.left + (grid.cols - 0.5) * grid.cellWidth);
      const y = Math.floor(grid.top + (marks[0].row + row - viewport) * grid.cellHeight + 1);
      const at = (y * png.width + x) * png.channels;
      if (png.pixels[at] === 138 && png.pixels[at + 1] === 226 && png.pixels[at + 2] === 160)
        good++;
    }
    r.ok(
      `${name}: every row is painted to the right edge`,
      good === height,
      `${good}/${height}, ${JSON.stringify(grid)}`,
    );
    r.ok(
      `${name}: the label remains in the output`,
      String(await evaluate(client, 'window.__tabterm.readScreen()'))
        .split('\n')
        .map((s) => s.trim())
        .join('')
        .includes('resize landmark'),
    );
  }
  await check('original width');
  await evaluate(client, "window.__tabterm.split('horizontal')");
  await waitFor(client, 'window.__tabterm.paneIds().length === 2');
  await check('split right');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 960,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await check('narrow window');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await check('wide window');
  await client.send('Page.reload');
  await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);
  await check('refresh');
} finally {
  await finish();
}
r.done();
