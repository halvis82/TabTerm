#!/usr/bin/env node
// The native messaging host for a suite browser, which answers with this run's token.
//
// The installed host reads the token of the daemon somebody is working in, and the extension asks
// it as soon as it starts. That is a race the suites cannot win by writing the token afterwards:
// when the extension asked first, every connection in the run was refused, and the run failed
// with every page saying the daemon was not responding. Intermittent, because it depends on which
// finished first.
//
// So the test browser is given a host of its own. It cannot obtain the real token at all, which
// is also the property the suites want: nothing here can reach the daemon somebody is using.
//
// Native messaging framing: a four byte little-endian length, then the JSON.
const token = process.env.TT_DAEMON_TOKEN ?? '';

const reply = (value) => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
};

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  // Every request gets the same answer, so the body is skipped rather than parsed.
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (pending.length < 4 + length) return;
    pending = pending.subarray(4 + length);
    reply({ token });
  }
});
process.stdin.on('end', () => process.exit(0));
