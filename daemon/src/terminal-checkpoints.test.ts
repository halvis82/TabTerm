import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalCheckpoints } from './terminal-checkpoints.js';
import { VtState } from './vt-state.js';

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tt-checkpoint-'));
  dirs.push(root);
  const dir = join(root, 'checkpoints');
  return { dir, store: new TerminalCheckpoints(dir) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const saved = { host: 'host-1', through: 400, cols: 80, rows: 24, screen: 'retained text' };

describe('a one-use terminal handoff', () => {
  it('stores private files and consumes the handoff exactly once', () => {
    const { dir, store } = fixture();
    store.save('session-1', saved);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'session-1.json')).mode & 0o777).toBe(0o600);
    expect(store.take('session-1', 'host-1', 450)).toEqual(saved);
    expect(store.take('session-1', 'host-1', 450)).toBeNull();
  });
  it.each([
    ['other-host', 450],
    [null, 450],
    ['host-1', 399],
  ] as const)('rejects another host or an impossible watermark: %s %s', (host, latest) => {
    const { store } = fixture();
    store.save('session-1', saved);
    expect(store.take('session-1', host, latest)).toBeNull();
    expect(store.take('session-1', 'host-1', 450)).toBeNull();
  });
  it('discards malformed files without blocking adoption', () => {
    const { dir, store } = fixture();
    store.save('session-1', saved);
    writeFileSync(join(dir, 'session-1.json'), '{bad json');
    expect(store.take('session-1', 'host-1', 450)).toBeNull();
  });
  it('clears leftovers but never unrelated files', () => {
    const { dir, store } = fixture();
    store.save('session-1', saved);
    writeFileSync(join(dir, 'keep.txt'), 'not ours');
    store.clear();
    expect(existsSync(join(dir, 'session-1.json'))).toBe(false);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(() => store.save('../elsewhere', saved)).toThrow();
  });
  it('preserves history after redraws have displaced it from the replay tail', async () => {
    const { store } = fixture();
    const before = new VtState(80, 24, 500);
    const after = new VtState(80, 24, 500);
    try {
      before.write(Array.from({ length: 100 }, (_, i) => `history-${i}\r\n`).join(''));
      before.write('\x1b[1Gredraw'.repeat(1000));
      await before.flush();
      store.save('session-1', { host: 'host-1', through: 20000, ...before.snapshot(500) });
      const handoff = store.take('session-1', 'host-1', 20010);
      expect(handoff).not.toBeNull();
      after.write(handoff?.screen ?? '');
      await after.flush();
      expect(after.snapshot(500).screen).toBe(before.snapshot(500).screen);
      expect(after.snapshot(500).screen).toContain('history-0');
    } finally {
      before.dispose();
      after.dispose();
    }
  });
});
