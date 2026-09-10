import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * That one session is shown in one place.
 *
 * Clicking a running session in a second window opened a second copy of it, one per window. The
 * intent was already written down above `openLiveSession`: a session a tab has is focused rather
 * than attached again. It decided that from `attached`, which the daemon answers as "a socket is
 * open".
 *
 * Those are different questions. Chrome freezes and discards tabs in windows that are not on
 * screen, and a discarded tab has no socket, so a session plainly open in another window reported
 * itself unattached and the second window showed it too.
 *
 * Whether a **tab** has the workspace is Chrome's to answer and it is exact, because the workspace
 * is written into the tab's URL when it is adopted.
 */
const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, 'terminal-page.ts'), 'utf8');
const worker = readFileSync(join(here, '..', 'service-worker.ts'), 'utf8');

const openLive = page.slice(
  page.indexOf('async function openLiveSession('),
  page.indexOf('async function openLiveSession(') + 5000,
);

describe('opening a session that is already in a tab', () => {
  it('asks Chrome whether a tab has it, rather than the daemon whether a socket is open', () => {
    expect(openLive).toContain("t: 'tabterm:focus-workspace'");
    expect(openLive).toContain('found?.focused === true');
  });

  it('never decides where to show it from whether a socket happens to be attached', () => {
    // The exact expression that produced one session in two windows.
    expect(openLive).not.toContain('!session.attached && spare');
  });

  it('is answered by the worker rather than merely acknowledged', () => {
    expect(worker).toContain('sendResponse({ ok: true, focused: r.focused })');
    // The listener must keep the channel open, or the reply never arrives.
    expect(worker).toContain('return true;');
  });

  it('shows it here only when no tab has it', () => {
    const afterFound = openLive.slice(openLive.indexOf('found?.focused === true'));
    expect(afterFound).toContain('if (spare) {');
    expect(afterFound).toContain('location.href');
  });
});

describe('bringing a session to this tab on purpose', () => {
  it('is offered, and lets go of the tab that had it', () => {
    expect(page).toContain("label: 'Bring here'");
    expect(page).toContain("t: 'tabterm:release-workspace-tab'");
  });

  it('never closes the tab that asked', () => {
    // Bringing a session here and closing the tab you are in is a way of losing it.
    expect(worker).toContain('releaseWorkspaceTab(wanted, _sender.tab?.id)');
    expect(worker).toContain('existing.id === exceptTabId');
  });

  it('takes the workspace after letting the other tab go, not before', () => {
    const bring = page.slice(
      page.indexOf("label: 'Bring here'"),
      page.indexOf("label: 'Bring here'") + 1200,
    );
    expect(bring.indexOf('release-workspace-tab')).toBeLessThan(bring.indexOf('location.href'));
  });
});
