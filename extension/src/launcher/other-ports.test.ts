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

  it('show a program s ports rather than hiding them behind it', () => {
    expect(launcher).toContain('this.#isOpen(key, true)');
  });

  it('only make a group of a program holding more than one', () => {
    // A heading that hides a single row is worse than the row.
    expect(launcher).toContain('worthGrouping(group)');
  });

  it('are capped by rows, since rows are what fills a screen', () => {
    // One browser can hold a dozen ports on its own, so a cap counted in programs lets it through.
    expect(launcher).toContain("this.#visibleCount('ports'");
    expect(launcher).toContain("this.#moreRow('ports'");
    expect(launcher).toContain('MAX_PORT_ROWS');
  });

  it('tell a nested fold apart from the section it is inside', () => {
    expect(launcher).toContain('launcher-fold-inner');
  });

  it('ask before ending a process this product did not start, and show it first', () => {
    expect(launcher).toContain('#closeConfirm');
    expect(launcher).toContain('launcher-port-preview');
    // The preview is built inside the confirmation, which is to say only when it is asked for.
    const confirm = launcher.slice(launcher.indexOf('#closeConfirm(other: OtherLocalPort'));
    expect(confirm.slice(0, 3000)).toContain("createElement('iframe')");
    /*
     * Scripts allowed, because an empty sandbox previews a white rectangle for every page that
     * draws itself with script, which is nearly all of them. Forms, popups, downloads and
     * navigating this page away stay refused, which is the part that matters.
     */
    expect(confirm.slice(0, 3000)).toContain("'allow-scripts allow-same-origin'");
    expect(confirm.slice(0, 3000)).not.toContain('allow-forms');
    expect(confirm.slice(0, 3000)).not.toContain('allow-top-navigation');
  });

  it('answers the question from the keyboard, both ways', () => {
    const confirm = launcher.slice(
      launcher.indexOf('#closeConfirm(other: OtherLocalPort'),
      launcher.indexOf('#closeConfirm(other: OtherLocalPort') + 4000,
    );
    expect(confirm).toContain("e.key === 'Escape'");
    expect(confirm).toContain("e.key === 'Enter'");
  });
});
