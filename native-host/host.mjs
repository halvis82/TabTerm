#!/usr/bin/env node
// Native messaging host. Its entire job is to hand the daemon's token to the extension once.
//
// It spawns nothing, accepts no commands, and reads exactly one file. Chrome enforces the
// allowed_origins list in the host manifest, which is what makes this also authenticate the
// extension in a way the loopback socket alone cannot. See docs/05-security.md §3.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN = join(homedir(), '.local', 'state', 'tabterm', 'token');

function reply(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) return;
    buffer = buffer.subarray(4 + len);
    try {
      const token = readFileSync(TOKEN, 'utf8').trim();
      reply(/^[0-9a-f]{64}$/.test(token) ? { token } : { error: 'token-malformed' });
    } catch {
      reply({ error: 'token-unavailable' });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
