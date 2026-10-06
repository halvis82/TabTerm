import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { findMarkers } from './markers.js';

describe('landmarks through real terminal reflow', () => {
  it('keeps short wrapped tails in the same landmark', async () => {
    const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      // Concealed padding, the way the daemon writes a landmark. See `marker-block.ts`.
      const line = '\x1b[48;2;122;162;247m\x1b[8m' + ' '.repeat(79) + '\x1b[0m\r\n';
      await new Promise<void>((resolve) =>
        term.write('\r\n' + line.repeat(3) + 'prompt\r\n', resolve),
      );
      term.resize(38, 24);
      const marks = findMarkers(term as unknown as Terminal);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.height).toBe(9);
      term.resize(120, 24);
      expect(findMarkers(term as unknown as Terminal)).toHaveLength(1);
    } finally {
      term.dispose();
    }
  });
});
