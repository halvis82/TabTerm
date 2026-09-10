import { describe, it, expect } from 'vitest';
import {
  scanIsOverdue,
  missHasExpired,
  askHasLapsed,
  MAX_WAIT_MS,
  QUIET_MS,
  MISS_TTL_MS,
  ASK_TIMEOUT_MS,
} from './link-scan.js';

describe('when the rows on screen are read for paths', () => {
  it('waits for the output to settle when a scan has just run', () => {
    expect(scanIsOverdue(1000 + QUIET_MS, 1000)).toBe(false);
  });

  it('gives up waiting once output has kept arriving for long enough', () => {
    // The case that was broken: an agent redrawing its screen renders continuously, so the
    // settle never happens and without this the scan never runs at all.
    expect(scanIsOverdue(1000 + MAX_WAIT_MS, 1000)).toBe(true);
  });

  it('treats a pane that has never been scanned as overdue', () => {
    expect(scanIsOverdue(1, 0)).toBe(true);
  });
});

describe('a path that did not exist yet', () => {
  it('is trusted for a moment', () => {
    expect(missHasExpired(1000 + MISS_TTL_MS - 1, 1000)).toBe(false);
  });

  it('is asked about again after that', () => {
    // The agent names the file before it writes it, and the command that creates a file carries
    // its path. Keeping the first answer meant it never became clickable afterwards.
    expect(missHasExpired(1000 + MISS_TTL_MS, 1000)).toBe(true);
  });
});

describe('a question already put to the daemon', () => {
  it('is not asked twice while it may still be on its way', () => {
    expect(askHasLapsed(1000 + ASK_TIMEOUT_MS - 1, 1000)).toBe(false);
  });

  it('is asked again once it clearly went nowhere', () => {
    // Some questions never get an answer: the socket is not open yet when the first screen is
    // drawn, the pane is not bound to a session, the daemon caps one message. Without this the
    // candidate was marked as asked for the life of the page.
    expect(askHasLapsed(1000 + ASK_TIMEOUT_MS, 1000)).toBe(true);
  });
});
