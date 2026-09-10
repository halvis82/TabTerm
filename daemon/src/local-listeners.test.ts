import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which addresses count as "listening on this machine".
 *
 * This was loopback only, on the reasoning that a port bound to every interface is a system service
 * or something configured deliberately. That is wrong: a great many development servers bind
 * `0.0.0.0` by default and answer on localhost like any other. Reported as a server on port 8300
 * that plainly responded to `curl` and was not on the list.
 *
 * Read from the source because the alternative is a test that asks the machine it runs on, and the
 * answer would then depend on whose machine that was.
 */
const here = dirname(fileURLToPath(import.meta.url));
const detect = readFileSync(join(here, 'server-detect.ts'), 'utf8');

describe('the addresses a local port may be bound to', () => {
  it('counts loopback, in both families', () => {
    expect(detect).toContain("address.startsWith('127.0.0.1:')");
    expect(detect).toContain("address.startsWith('[::1]:')");
  });

  it('counts a wildcard bind, which answers on loopback too', () => {
    expect(detect).toContain("address.startsWith('*:')");
    expect(detect).toContain("address.startsWith('0.0.0.0:')");
    expect(detect).toContain("address.startsWith('[::]:')");
  });

  it('still refuses the reserved ports, where nothing a person started lives', () => {
    expect(detect).toContain('port <= 1024');
  });

  it('excludes nothing by the name of the program holding it', () => {
    // What to hide is a question about what somebody is looking at. The page knows that; this does
    // not, and a list of program names here would rot the first time somebody installed something.
    expect(detect).not.toMatch(/Google Chrome|Raycast|rapportd|ControlCenter/);
  });
});
