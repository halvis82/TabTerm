import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';

/**
 * Whether a card may say a terminal is in a tab.
 *
 * Reported as terminals in a second Chrome window being labelled `background`. They were in tabs
 * the whole time. Two separate reasons, and both had to go:
 *
 * - The label asked whether a **page** was attached. Chrome discards a tab it has not needed for a
 *   while: the tab stays in the strip, the page is thrown away, and the socket goes with it
 * - The daemon forgets a browser's report when that browser's connection drops, and Chrome's
 *   service worker sleeps constantly. Forgetting is right for **deciding** anything, because
 *   ending a terminal on a stale report is the worst mistake available here. It is wrong for
 *   **describing** one
 *
 * Nothing was ever at risk: the rule that ends sessions asks a different question and keeps
 * anything it is unsure about.
 */
const config: Config = { ...DEFAULTS };

function manager(): SessionManager {
  initLog('error');
  return new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
}

describe('where a card may say a terminal is', () => {
  it('says a tab holds it while a browser is reporting that tab', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1']);
    expect(sessions.tabHolds('s-1')).toBe(true);
  });

  /*
   * The case this exists for. The worker sleeps, its connection goes, and the report goes with it.
   * The tab has not moved.
   */
  it('and still says so once that browser goes quiet, because a sleeping worker is not a closed tab', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1']);
    sessions.forgetReporter('chrome:control');
    expect(sessions.tabHolds('s-1')).toBe(true);
  });

  /*
   * And a tab that really went away stops being somewhere a terminal is. Closing is an explicit
   * statement, which is the only thing this listens to.
   */
  it('but not once somebody actually closes that tab', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1']);
    sessions.recordTabClosed('ws-1', 'event-1');
    /*
     * And the browser's next list, which no longer has it.
     *
     * Both halves happen when a tab closes, and the order matters: a list that still mentions a
     * workspace settles it as open, deliberately, because reopening one inside the window is the
     * case the timer exists to be cancelled by. So the close is only final once the browser has
     * stopped saying it is there.
     */
    sessions.reportOpenWorkspaces('chrome:control', []);
    expect(sessions.tabHolds('s-1')).toBe(false);
  });

  /*
   * And a browser that is here and does not mention it is saying the tab is gone, which is better
   * evidence than anything it said earlier. The memory is for the gap where there is nobody to
   * ask, not for arguing with somebody who is.
   */
  it('and defers to a browser that is connected and no longer lists it', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1']);
    sessions.reportOpenWorkspaces('chrome:control', ['ws-other']);
    expect(sessions.tabHolds('s-1')).toBe(false);
  });

  /**
   * The one seen on a real machine: closed, and still described as held.
   *
   * A reporter's list is the last thing that browser said, and "open beats closed" reads it first
   * so that a workspace reopened inside the window can cancel a timer. That is right about a newer
   * list and wrong about an older one, and a tab closing does not rewrite a list sent before it.
   * A session with three `tab-closed` events against its workspace was still saying "open in a
   * tab" because no report had happened to arrive since.
   */
  it('stops being held the moment its tab is closed, not when the next report arrives', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1', 'ws-2']);
    expect(sessions.tabHolds('s-1')).toBe(true);

    sessions.recordTabClosed('ws-1', 'event-1', 'chrome:control');
    expect(sessions.tabHolds('s-1')).toBe(false);
  });

  /*
   * And a browser that says it is open again wins, which is the case the rule was written for:
   * reopening a workspace inside the window has to be able to cancel the timer.
   */
  it('and a later report saying it is back is believed', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1']);
    sessions.recordTabClosed('ws-1', 'event-1', 'chrome:control');
    sessions.reportOpenWorkspaces('chrome:control', ['ws-1']);
    expect(sessions.tabHolds('s-1')).toBe(true);
  });

  it('and says nothing about a workspace no browser has ever mentioned', () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-never');
    expect(sessions.tabHolds('s-1')).toBe(false);
  });

  /**
   * And one of two browsers closing is not both.
   *
   * A workspace open in two browsers, one of which closes its tab, is still open in the other.
   * Clearing every list would end a terminal somebody is looking at, which is the one outcome this
   * product does not accept.
   */
  it("leaves another browser's claim alone when one of them closes", () => {
    const sessions = manager();
    sessions.setWorkspaceLookup(() => 'ws-1');
    sessions.reportOpenWorkspaces('chrome-a:control', ['ws-1']);
    sessions.reportOpenWorkspaces('chrome-b:control', ['ws-1']);
    sessions.recordTabClosed('ws-1', 'event-1', 'chrome-a:control');
    expect(sessions.tabHolds('s-1')).toBe(true);
  });
});
