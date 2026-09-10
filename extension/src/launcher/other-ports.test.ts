import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * That the second group of ports survives the whole way to the screen.
 *
 * The daemon answered `server-list` with both groups, the launcher knew how to draw the second one,
 * and the line in between called `setServers(msg.servers)` with one argument. The parameter has a
 * default, so nothing failed: `others` was quietly an empty list, the section returned null, and the
 * feature was absent with every individual piece of it working.
 *
 * Checked at the source because there is no seam between those two: it is one call, and what makes
 * it wrong is what is missing from it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, '..', 'terminal', 'terminal-page.ts'), 'utf8');
const launcher = readFileSync(join(here, 'launcher.ts'), 'utf8');

describe('the ports the daemon reports that no session accounts for', () => {
  it('are handed to the launcher rather than dropped at the handler', () => {
    expect(page).toMatch(/setServers\(msg\.servers,\s*msg\.others/);
  });

  it('reach a section that can draw them', () => {
    expect(launcher).toMatch(/#otherPortsSection\(\)/);
    expect(launcher).toContain('const otherPorts = this.#otherPortsSection();');
  });

  it('are foldable, and the fold is remembered rather than per tab', () => {
    expect(launcher).toContain("this.#folded.has('otherPorts')");
    expect(launcher).toContain('void saveFolded(this.#folded)');
    expect(page).toContain('launcher.restoreFolds()');
  });

  it('are grouped by the program holding them', () => {
    expect(launcher).toContain('groupPorts(this.#otherPorts)');
    expect(launcher).toContain('portGroupKey(group.program)');
  });

  it('start with each program folded, so the section is a list of programs', () => {
    // Twenty six ports on a real machine were eight programs. The ports are the detail behind one.
    expect(launcher).toContain('this.#isOpen(key, false)');
  });

  it('are capped like every other list on this screen', () => {
    expect(launcher).toContain("this.#visibleCount('ports'");
    expect(launcher).toContain("this.#moreRow('ports'");
  });

  it('ask before ending a process this product did not start, and show it first', () => {
    expect(launcher).toContain('#closeConfirm');
    expect(launcher).toContain('launcher-port-preview');
    // The preview is built inside the confirmation, which is to say only when it is asked for.
    const confirm = launcher.slice(launcher.indexOf('#closeConfirm('));
    expect(confirm.slice(0, 3000)).toContain("createElement('iframe')");
    // And it can do nothing: no scripts, no forms, no same-origin.
    expect(confirm.slice(0, 3000)).toContain("setAttribute('sandbox', '')");
  });

  it('answers the question from the keyboard, both ways', () => {
    const confirm = launcher.slice(
      launcher.indexOf('#closeConfirm('),
      launcher.indexOf('#closeConfirm(') + 3500,
    );
    expect(confirm).toContain("e.key === 'Escape'");
    expect(confirm).toContain("e.key === 'Enter'");
  });
});
