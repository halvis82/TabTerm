import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { OutputArchive } from './output-archive.js';

const ESC = '\u001b';
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;

const on = () => new OutputArchive(new Database(':memory:'), true);
const off = () => new OutputArchive(new Database(':memory:'));

describe('the default', () => {
  it('is off, because this is the most sensitive thing the product can hold', () => {
    const archive = off();
    expect(archive.enabled).toBe(false);
    archive.begin('s1', 'npm test', '/w');
    archive.write('s1', 'output nobody asked to keep');
    archive.end('s1', 0);
    expect(archive.search({})).toEqual([]);
  });

  it('drops anything mid-capture when it is turned off', () => {
    // Turning it off has to mean the output stops being recorded, including what is already
    // buffered. Writing that out on the next command end would be the worst possible reading.
    const archive = on();
    archive.begin('s1', 'npm test', '/w');
    archive.write('s1', 'buffered');
    archive.setEnabled(false);
    archive.end('s1', 0);
    expect(archive.search({})).toEqual([]);
  });
});

describe('capturing a command', () => {
  it('stores what a command printed, with its exit code', () => {
    const archive = on();
    archive.begin('s1', 'npm test', '/w/app');
    archive.write('s1', '3 tests passed\n');
    archive.end('s1', 0);

    const [record] = archive.search({});
    expect(record?.command).toBe('npm test');
    expect(record?.output).toContain('3 tests passed');
    expect(record?.exitCode).toBe(0);
    expect(record?.cwd).toBe('/w/app');
  });

  it('captures nothing outside a command boundary', () => {
    // This is what makes it a bounded archive rather than a transcript of a terminal.
    const archive = on();
    archive.write('s1', 'a prompt redraw nobody asked about');
    expect(archive.search({})).toEqual([]);
  });

  it('discards a command that printed nothing', () => {
    const archive = on();
    archive.begin('s1', 'cd /tmp', '/w');
    archive.write('s1', '   \n');
    archive.end('s1', 0);
    expect(archive.search({})).toEqual([]);
  });

  it('keeps sessions separate', () => {
    const archive = on();
    archive.begin('s1', 'one', '/w');
    archive.begin('s2', 'two', '/w');
    archive.write('s1', 'from one');
    archive.write('s2', 'from two');
    archive.end('s1', 0);
    archive.end('s2', 0);
    expect(archive.search({ query: 'from one' })[0]?.command).toBe('one');
    expect(archive.search({ query: 'from two' })[0]?.command).toBe('two');
  });

  it('abandons a capture whose session went away', () => {
    const archive = on();
    archive.begin('s1', 'npm test', '/w');
    archive.write('s1', 'partial');
    archive.abandon('s1');
    archive.end('s1', 0);
    expect(archive.search({})).toEqual([]);
  });
});

describe('alt-screen periods are skipped', () => {
  it('drops everything a full-screen program drew', () => {
    // vim redraws constantly. Archiving that would capture megabytes of repaints that mean
    // nothing the moment it exits.
    const archive = on();
    archive.begin('s1', 'vim notes.txt', '/w');
    archive.write('s1', `before${ALT_ON}REDRAW REDRAW REDRAW${ALT_OFF}after`);
    archive.end('s1', 0);

    const output = archive.search({})[0]?.output ?? '';
    expect(output).toContain('before');
    expect(output).toContain('after');
    expect(output).not.toContain('REDRAW');
  });

  it('handles a transition split across chunks', () => {
    // PTY output arrives in arbitrary pieces, so the enter and the leave routinely land in
    // different writes.
    const archive = on();
    archive.begin('s1', 'less big.log', '/w');
    archive.write('s1', `head${ALT_ON}page one`);
    archive.write('s1', 'page two');
    archive.write('s1', `page three${ALT_OFF}tail`);
    archive.end('s1', 0);

    const output = archive.search({})[0]?.output ?? '';
    expect(output).toBe('headtail');
  });

  it('recognizes the older alt-screen sequences too', () => {
    const archive = on();
    archive.begin('s1', 'top', '/w');
    archive.write('s1', `a${ESC}[?47hhidden${ESC}[?47lb`);
    archive.end('s1', 0);
    expect(archive.search({})[0]?.output).toBe('ab');
  });

  it('stores nothing when a command was entirely full-screen', () => {
    const archive = on();
    archive.begin('s1', 'htop', '/w');
    archive.write('s1', `${ALT_ON}all of it redrawn${ALT_OFF}`);
    archive.end('s1', 0);
    expect(archive.search({})).toEqual([]);
  });
});

describe('secrets', () => {
  it('never archives output from a command that history would refuse to store', () => {
    // The same rule, applied to something far more revealing than a command line: the output
    // of an export is the value itself.
    const archive = on();
    archive.begin('s1', 'export AWS_SECRET_KEY=abc123', '/w');
    archive.write('s1', 'abc123');
    archive.end('s1', 0);
    expect(archive.search({})).toEqual([]);
  });
});

describe('bounds', () => {
  it('caps a single command and says so rather than truncating silently', () => {
    const archive = on();
    archive.begin('s1', 'cat huge.log', '/w');
    archive.write('s1', 'x'.repeat(2_000_000));
    archive.end('s1', 0);

    const record = archive.search({})[0];
    expect(record).toBeDefined();
    expect(record?.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(record?.output).toContain('truncated');
  });

  it('reports how much disk it is using', () => {
    const archive = on();
    archive.begin('s1', 'echo hi', '/w');
    archive.write('s1', 'hi there');
    archive.end('s1', 0);
    const usage = archive.usage();
    expect(usage.rows).toBe(1);
    expect(usage.bytes).toBeGreaterThan(0);
  });

  it('prunes by age', () => {
    const archive = on();
    archive.begin('s1', 'echo hi', '/w');
    archive.write('s1', 'hi');
    archive.end('s1', 0);
    archive.prune({ olderThanMs: -1, maxTotalBytes: 1e9 });
    expect(archive.search({})).toEqual([]);
  });

  it('prunes by total size, oldest first', () => {
    // Age alone fails on one noisy afternoon, and size alone keeps nothing through a quiet
    // week. Both limits exist because either on its own has a case it handles badly.
    const archive = on();
    for (let i = 0; i < 10; i++) {
      archive.begin('s1', `command ${String(i)}`, '/w');
      archive.write('s1', 'y'.repeat(10_000));
      archive.end('s1', 0);
    }
    expect(archive.usage().rows).toBe(10);

    archive.prune({ olderThanMs: 1e9, maxTotalBytes: 25_000 });
    const left = archive.search({});
    expect(left.length).toBeLessThan(10);
    expect(archive.usage().bytes).toBeLessThanOrEqual(25_000);
    // What survives is the most recent, which is what anyone would want kept.
    expect(left[0]?.command).toBe('command 9');
  });

  it('clears everything on request', () => {
    const archive = on();
    archive.begin('s1', 'echo hi', '/w');
    archive.write('s1', 'hi');
    archive.end('s1', 0);
    archive.clear();
    expect(archive.usage().rows).toBe(0);
  });
});

describe('searching', () => {
  it('finds by output text and by command', () => {
    const archive = on();
    archive.begin('s1', 'npm run build', '/w');
    archive.write('s1', 'ERROR: module not found');
    archive.end('s1', 1);

    expect(archive.search({ query: 'module not found' })).toHaveLength(1);
    expect(archive.search({ command: 'npm run' })).toHaveLength(1);
    expect(archive.search({ query: 'nothing like this' })).toHaveLength(0);
  });

  it('does not let a query escape into SQL', () => {
    const archive = on();
    archive.begin('s1', 'echo hi', '/w');
    archive.write('s1', 'hi');
    archive.end('s1', 0);
    expect(() => archive.search({ query: `'; DROP TABLE command_output; --` })).not.toThrow();
    expect(archive.usage().rows).toBe(1);
  });

  it('caps an absurd limit', () => {
    expect(on().search({ limit: 100_000 })).toHaveLength(0);
  });
});
