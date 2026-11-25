// A program that holds the mouse and redraws a link it is hovering, the way Codex does.
//
// Prints one marked link on the third row. Every mouse report it is sent redraws that row, which
// is what makes the terminal forget and re-find the link under the pointer. It also redraws the
// whole screen every few milliseconds, the way Codex animates its status line. A click it is told
// about is written on the fifth row as `CLICKED`, so a suite can read whether one arrived.
const url = process.argv[2];
const row = (hover) =>
  `\u001b[3;1H\u001b[2K  ${hover ? '\u001b[4m' : ''}\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\\u001b[0m`;
process.stdin.setRawMode(true);
process.stdout.write('\u001b[?1049h\u001b[2J\u001b[?1003h\u001b[?1006h' + row(false));
let clicks = 0;
let hovered = false;
let frame = 0;
setInterval(() => {
  frame++;
  process.stdout.write(
    `\u001b[?2026h${row(hovered)}\u001b[10;1H\u001b[2KWorking ${'.'.repeat(frame % 4)}\u001b[?2026l`,
  );
}, 16);
process.stdin.on('data', (d) => {
  const s = d.toString();
  // eslint-disable-next-line no-control-regex -- the reports start with ESC
  for (const m of s.matchAll(/\u001b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const button = Number(m[1]);
    if (button < 32 && m[4] === 'M') {
      clicks++;
      process.stdout.write(`\u001b[5;1H\u001b[2KCLICKED ${clicks}`);
    }
  }
  hovered = true;
  process.stdout.write(row(true));
  if (s.includes('q')) {
    process.stdout.write('\u001b[?1003l\u001b[?1006l\u001b[?1049l');
    process.exit(0);
  }
});
