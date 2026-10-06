import { describe, expect, it } from 'vitest';
import {
  createPathLinkProvider,
  findCandidates,
  findUrls,
  continuesHard,
  readLogicalLine,
  candidatesIn,
} from './path-links.js';
import type { Terminal } from '@xterm/xterm';

const texts = (s: string) => findCandidates(s).map((c) => c.text);

describe('path candidate detection', () => {
  it('finds an absolute path', () => {
    expect(texts('  ⎿  /Users/me/Documents/code/wifi-site-blocker')).toContain(
      '/Users/me/Documents/code/wifi-site-blocker',
    );
  });

  it('finds a relative path', () => {
    expect(texts('editing src/main.ts now')).toContain('src/main.ts');
  });

  it('keeps a line and column suffix attached', () => {
    expect(texts('src/main.ts:42:7: error')).toContain('src/main.ts:42:7');
  });

  it('finds a home-relative path', () => {
    expect(texts('cd ~/Projects/eeg')).toContain('~/Projects/eeg');
  });

  it('strips trailing punctuation a human would not include', () => {
    expect(texts('see src/main.ts, then go')).toContain('src/main.ts');
    expect(texts('(src/main.ts)')).toContain('src/main.ts');
  });

  it('finds several paths on one line', () => {
    const found = texts('cp src/a.ts dist/b.ts');
    expect(found).toContain('src/a.ts');
    expect(found).toContain('dist/b.ts');
  });

  it('ignores ordinary prose with no path in it', () => {
    expect(texts('Cooked for 3s and everything was fine')).toHaveLength(0);
  });

  it('does not match a bare word', () => {
    expect(texts('pwd')).toHaveLength(0);
  });

  it('reports offsets that map back to the original text', () => {
    const line = 'error in src/main.ts here';
    const [c] = findCandidates(line);
    expect(c).toBeDefined();
    expect(line.slice(c!.start, c!.end)).toBe('src/main.ts');
  });

  it('survives a line of pure punctuation without throwing', () => {
    expect(() => findCandidates('////::::....~~~~')).not.toThrow();
  });
});

describe('a file URL', () => {
  it('yields the path inside it, since nothing else would open it', () => {
    const found = findCandidates('see (file:///Users/someone/guide.pdf) for the rest').map(
      (c) => c.text,
    );
    expect(found).toEqual(['/Users/someone/guide.pdf']);
  });

  it('while a web URL still keeps its path to itself', () => {
    expect(findCandidates('https://example.com/some/path.html')).toEqual([]);
  });
});

describe('URL detection', () => {
  it('finds a bare URL', () => {
    expect(findUrls('see https://example.com/docs for more').map((u) => u.text)).toContain(
      'https://example.com/docs',
    );
  });

  it('strips trailing punctuation from a URL', () => {
    expect(findUrls('(https://example.com/x).').map((u) => u.text)).toContain(
      'https://example.com/x',
    );
  });

  it('ignores non-http schemes entirely', () => {
    expect(findUrls('javascript:alert(1) data:text/html,x file:///etc/passwd')).toHaveLength(0);
  });

  it('does not treat a path as a URL', () => {
    expect(findUrls('/Users/me/Projects')).toHaveLength(0);
  });
});

/**
 * Just enough terminal for the provider: one unwrapped line, and a width.
 *
 * The provider reads the buffer and asks for columns, and nothing else, so a real terminal here
 * would only add a canvas and a font to something that is really string arithmetic.
 */
function fakeTerminal(text: string): Terminal {
  const line = { isWrapped: false, translateToString: () => text };
  return {
    cols: 200,
    buffer: { active: { length: 1, getLine: (y: number) => (y === 0 ? line : undefined) } },
  } as unknown as Terminal;
}

describe('which mouse button follows a link', () => {
  const activateFirst = (text: string, button: number): string[] => {
    const opened: string[] = [];
    const provider = createPathLinkProvider(fakeTerminal(text), {
      resolve: () => {},
      lookup: (candidate) => ({
        candidate,
        absolute: `/tmp/${candidate}`,
        exists: true,
        isDirectory: false,
      }),
      activate: () => opened.push('path'),
      openUrl: () => opened.push('url'),
      modifierHeld: () => true,
    });
    provider.provideLinks(1, (links) => {
      for (const link of links ?? []) link.activate({ button } as MouseEvent, link.text);
    });
    return opened;
  };

  it('follows a link on a left click', () => {
    expect(activateFirst('see https://example.com/docs', 0)).toContain('url');
  });

  it('does nothing on a right click, which is asking for a menu', () => {
    // Right-clicking a URL used to open it and show the menu, so asking what the options were
    // was the same gesture as choosing one.
    expect(activateFirst('see https://example.com/docs', 2)).toEqual([]);
  });

  it('does not open a path on a right click either', () => {
    expect(activateFirst('edit src/main.ts now', 2)).toEqual([]);
  });
});

/**
 * A path a program broke by hand, filling a row to its last column and then writing a newline.
 *
 * xterm connects rows only when it wrapped them itself, so Claude Code's path in a narrow pane
 * arrived as two rows with nothing joining them: underlined on the first row only, and opening
 * the directory that row happened to name. The join is a guess, so the rows' own candidates are
 * kept beside the joined one and the daemon decides which exists.
 */
describe('a path broken across rows by the program that printed it', () => {
  const fakeTerm = (rows: { text: string; wrapped?: boolean }[], cols: number) =>
    ({
      cols,
      buffer: {
        active: {
          length: rows.length,
          getLine: (y: number) => {
            const row = rows[y];
            if (!row) return undefined;
            return {
              isWrapped: row.wrapped === true,
              translateToString: (trim: boolean) => (trim ? row.text : row.text.padEnd(cols, ' ')),
            };
          },
        },
      },
    }) as unknown as Parameters<typeof readLogicalLine>[0];

  it('joins a filled row ending in a path character to a row beginning with one', () => {
    expect(continuesHard('/private/tmp/some-directory-', 'c10627ad/changes.pdf', 28)).toBe(true);
  });

  it('does not join a row that was not filled to its last column', () => {
    expect(continuesHard('/private/tmp/dir/', 'changes.pdf', 40)).toBe(false);
  });

  it('joins a row filled to the column before the last, which is where ink stops', () => {
    // Every wrapped row of a Claude Code answer in a 94 column pane was 93 characters long.
    expect(continuesHard('/Users/someone/Documents/StudyGuide_', 'Lec01.pdf', 37)).toBe(true);
    expect(continuesHard('/Users/someone/Documents/StudyGuide_', 'Lec01.pdf', 38)).toBe(false);
  });

  it('does not join rows that meet on a space', () => {
    // A row that ends in a space is not filled: xterm trims it, so it is shorter than the pane.
    expect(continuesHard('the file is in /tmp,', 'and it works', 21)).toBe(false);
  });

  it("joins on a dot, since a path can break there, and keeps the row's own path beside it", () => {
    // "changes." then "pdf" is a real break. A sentence that happens to meet the same way costs
    // one candidate that does not exist, and the row's own path is still offered.
    const cols = 20;
    const term = fakeTerm([{ text: 'see /tmp/report.pdf.' }, { text: 'Then rebuild it' }], cols);
    const line = readLogicalLine(term, 0);
    expect(line?.hardJoins).toBe(true);
    const texts = candidatesIn(line as NonNullable<typeof line>).map((c) => c.text);
    expect(texts).toContain('/tmp/report.pdf.Then');
    expect(texts).toContain('/tmp/report.pdf');
  });

  it('reads the two rows as one line and finds the whole path on it', () => {
    const cols = 30;
    const first = '/private/tmp/a-directory-name/';
    const second = 'changes.pdf';
    const term = fakeTerm(
      [{ text: 'intro' }, { text: first }, { text: second }, { text: 'after' }],
      cols,
    );
    const line = readLogicalLine(term, 2);
    expect(line?.rows.map((r) => r.y)).toEqual([1, 2]);
    expect(line?.hardJoins).toBe(true);
    const texts = candidatesIn(line as NonNullable<typeof line>).map((c) => c.text);
    expect(texts).toContain(first + second);
    expect(texts, 'and the first row on its own, in case the join was wrong').toContain(first);
    const whole = candidatesIn(line as NonNullable<typeof line>).find(
      (c) => c.text === first + second,
    );
    expect(line?.offsetToColumn(whole?.start ?? -1)).toEqual({ x: 0, y: 2 });
    expect(line?.offsetToColumn((whole?.end ?? 0) - 1)).toEqual({ x: second.length - 1, y: 3 });
  });

  it('joins rows ink broke one column short, without a space where the padding was', () => {
    const cols = 31;
    const first = '/private/tmp/a-directory-name/'; // 30 characters in a 31 column pane
    const second = 'changes.pdf';
    const term = fakeTerm([{ text: first }, { text: second }], cols);
    const line = readLogicalLine(term, 1);
    expect(line?.text).toBe(first + second);
    const whole = candidatesIn(line as NonNullable<typeof line>).find(
      (c) => c.text === first + second,
    );
    expect(whole).toBeDefined();
    expect(line?.offsetToColumn((whole?.end ?? 0) - 1)).toEqual({ x: second.length - 1, y: 2 });
  });

  it('joins a continuation ink indented under its bullet, and maps columns past the indent', () => {
    // The second screenshot: "  Source: /Users/.../CSE250A_StudyGui" then "  de_Lec01-03.tex".
    const cols = 40;
    const first = '  Source: /Users/someone/docs/CSE250A_St'; // 39 characters
    const second = '  udyGuide.tex (file:///Users/someone/d';
    const third = '  ocs/CSE250A_StudyGuide.tex)';
    const term = fakeTerm([{ text: first }, { text: second }, { text: third }], cols);
    const line = readLogicalLine(term, 2);
    expect(line?.rows.map((r) => r.y)).toEqual([0, 1, 2]);
    expect(line?.text).toBe(
      '  Source: /Users/someone/docs/CSE250A_StudyGuide.tex (file:///Users/someone/docs/CSE250A_StudyGuide.tex)',
    );
    const texts = candidatesIn(line as NonNullable<typeof line>).map((c) => c.text);
    expect(texts).toContain('/Users/someone/docs/CSE250A_StudyGuide.tex');
    expect(texts.filter((t) => t === '/Users/someone/docs/CSE250A_StudyGuide.tex')).toHaveLength(2);
    const whole = candidatesIn(line as NonNullable<typeof line>).find(
      (c) => c.text === '/Users/someone/docs/CSE250A_StudyGuide.tex',
    );
    // The link starts on the first row and ends on the second, after its two-space indent.
    expect(line?.offsetToColumn(whole?.start ?? -1)).toEqual({ x: 10, y: 1 });
    expect(line?.offsetToColumn((whole?.end ?? 0) - 1)).toEqual({
      x: 2 + 'udyGuide.tex'.length - 1,
      y: 2,
    });
  });

  it('does not treat a deeply indented row as a continuation', () => {
    expect(continuesHard('/Users/someone/some-long-directory-name/', '          code', 41)).toBe(
      false,
    );
  });

  it('offers only the joined path when xterm itself wrapped the row', () => {
    const cols = 30;
    const term = fakeTerm(
      [{ text: '/private/tmp/a-directory-name/' }, { text: 'changes.pdf', wrapped: true }],
      cols,
    );
    const line = readLogicalLine(term, 0);
    expect(line?.hardJoins).toBe(false);
    expect(candidatesIn(line as NonNullable<typeof line>).map((c) => c.text)).toEqual([
      '/private/tmp/a-directory-name/changes.pdf',
    ]);
  });
});
