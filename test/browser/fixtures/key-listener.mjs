// A program that behaves the way an agent's interface does, and says what it was sent.
//
// Raw mode, focus reporting on, and every byte printed as hex. That combination is the point:
// an agent CLI reads keys in raw mode and 62 of the sessions on this machine asked this terminal
// for focus reporting, so a check that only tries a shell prompt is not testing the case that
// matters.
process.stdout.write('[?1004h');
process.stdin.setRawMode(true);
process.stdin.resume();

const seen = [];
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) seen.push(byte.toString(16).padStart(2, '0'));
  process.stdout.write('\r\nSAW:' + seen.join(',') + '\r\n');
  if (seen.length > 40) {
    process.stdout.write('[?1004l');
    process.exit(0);
  }
});
