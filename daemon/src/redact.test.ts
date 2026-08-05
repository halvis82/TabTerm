import { homedir, hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

const context = { home: '/Users/someone', hostname: 'Someones-Mac.local' };
const clean = (text: string) => redact(text, context);

describe('diagnostic redaction', () => {
  it('removes a token from a JSON line', () => {
    expect(clean('{"token":"abc123secret"}')).toBe('{"token":"<redacted>"}');
  });

  it('removes a token given as a key=value pair', () => {
    expect(clean('curl --header token=abc123def456')).not.toContain('abc123def456');
    expect(clean('PASSWORD=hunter2')).not.toContain('hunter2');
  });

  it('removes recognisable credential formats', () => {
    for (const secret of [
      'ghp_16CharactersHere1234',
      'github_pat_11ABCDEFG0abcdefghij',
      'xoxb-123456789012-abcdef',
      'sk-abcdefghijklmnop',
    ]) {
      expect(clean(`value ${secret}`)).not.toContain(secret);
    }
  });

  it('removes a long hex string, which is what a raw token looks like', () => {
    const token = 'a'.repeat(64);
    expect(clean(`token ${token}`)).not.toContain(token);
  });

  it('removes an email address', () => {
    expect(clean('from someone@example.com here')).not.toContain('someone@example.com');
  });

  it('replaces the home directory with a tilde', () => {
    expect(clean('/Users/someone/Projects/app')).toBe('~/Projects/app');
  });

  it('replaces the hostname', () => {
    expect(clean('host Someones-Mac.local up')).toBe('host <host> up');
  });

  it('redacts a secret that also sits inside a home path', () => {
    // Order is the easy thing to get wrong here: replacing the home directory first would stop
    // the narrower rules from ever matching.
    const line = '/Users/someone/.config/creds token=abcdef123456';
    const out = clean(line);
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('~/.config/creds');
  });

  it('leaves ordinary diagnostic text alone', () => {
    const line = 'daemon listening on 127.0.0.1:7377, 3 sessions, schema version 5';
    expect(clean(line)).toBe(line);
  });

  it('is idempotent, so redacting twice changes nothing further', () => {
    const once = clean('/Users/someone token=secret1234 a@b.co');
    expect(clean(once)).toBe(once);
  });

  it('removes this machine’s real home and hostname', () => {
    // The rules are only useful if they are built from the real values at runtime.
    const live = { home: homedir(), hostname: hostname() };
    const line = `${homedir()}/x on ${hostname()}`;
    const out = redact(line, live);
    expect(out).not.toContain(homedir());
    expect(out).not.toContain(hostname());
  });

  it('does not fall over when home or hostname is empty', () => {
    // An empty pattern would otherwise match between every character and destroy the bundle.
    const out = redact('some text /Users/someone', { home: '', hostname: '' });
    expect(out).toBe('some text /Users/someone');
  });
});
