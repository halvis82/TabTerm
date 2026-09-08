import { describe, expect, it } from 'vitest';
import { decideReap, type ReapInput } from './cleanup.js';
import { DEFAULTS } from './config.js';

/**
 * The invariant, checked over the whole input space rather than at chosen points.
 *
 * Every other test here names a situation somebody thought of. This one asks the question the
 * product is built around, of every combination of inputs there is: **is there any way at all to
 * get a timer out of this function without an act by a person authorizing it?**
 *
 * Worth having because the failures in this area have never been in the rules themselves. They
 * were in a case nobody enumerated: a pane in no workspace, a report that arrived empty, a
 * session that had exited, a browser still waking up. An exhaustive sweep does not need anybody
 * to have thought of the case.
 */

const DISPOSITIONS = ['open', 'closed', 'unknown'] as const;
const PROGRAMS = [undefined, 'zsh', 'nvim', 'node'];

function* everyInput(): Generator<ReapInput> {
  for (const pinned of [false, true])
    for (const persistent of [false, true])
      for (const attachedClients of [0, 1])
        for (const tabDisposition of DISPOSITIONS)
          for (const paneClosedByUser of [false, true])
            for (const inWorkspace of [false, true])
              for (const sharesWorkspace of [false, true])
                for (const exited of [false, true])
                  for (const listeningPort of [undefined, 3000])
                    for (const foregroundProgram of PROGRAMS)
                      for (const hasExplicitCommand of [false, true])
                        for (const keepBackgroundSeconds of [null, 300, 1800])
                          for (const neverUsed of [false, true])
                            for (const closedPaneSecondsLeft of [null, 0, 120])
                              yield {
                                pinned,
                                persistent,
                                attachedClients,
                                tabDisposition,
                                paneClosedByUser,
                                inWorkspace,
                                sharesWorkspace,
                                exited,
                                listeningPort,
                                foregroundProgram,
                                hasExplicitCommand,
                                keepBackgroundSeconds,
                                neverUsed,
                                closedPaneSecondsLeft,
                                detachedForSeconds: 10_000,
                              };
}

/**
 * The four things that authorize ending a live process, and nothing else is one.
 *
 * A closed pane and a closed tab are acts by a person. An already exited process is not a live
 * process at all, and its entry is tidied rather than signalled. Everything else in the world,
 * a browser quitting, a socket dropping, a machine sleeping, a report that arrived empty or late,
 * a daemon restarting, arrives as absence, and absence authorizes nothing.
 */
const authorized = (i: ReapInput): boolean =>
  i.exited ||
  i.paneClosedByUser ||
  i.tabDisposition === 'closed' ||
  (i.closedPaneSecondsLeft !== null && i.closedPaneSecondsLeft !== undefined);

describe('over every combination of inputs there is', () => {
  it('never schedules an ending without an act that authorizes it', () => {
    let checked = 0;
    const offenders: string[] = [];
    for (const input of everyInput()) {
      checked += 1;
      const decision = decideReap(input, DEFAULTS);
      if (decision.afterSeconds !== null && !authorized(input)) {
        offenders.push(`${decision.reason}: ${JSON.stringify(input)}`);
      }
    }
    // A number, so a change that quietly stops covering the space is visible rather than silent.
    expect(checked).toBeGreaterThan(30_000);
    expect(offenders.slice(0, 3)).toEqual([]);
  });

  it('and always keeps what is pinned, persistent, or attached, whatever else is true', () => {
    for (const input of everyInput()) {
      if (!input.pinned && !input.persistent && input.attachedClients === 0) continue;
      expect(decideReap(input, DEFAULTS).afterSeconds).toBe(null);
    }
  });

  it('and always keeps a session whose tab is open, whatever else is true', () => {
    // The rule that matters most in daily use: a backgrounded tab, one in a collapsed group and
    // one Chrome has discarded all look identical from the daemon, and none of them is a close.
    for (const input of everyInput()) {
      if (input.tabDisposition !== 'open') continue;
      if (input.pinned || input.persistent || input.attachedClients > 0) continue;
      // A pane the person closed has its own deadline and is ahead of this, deliberately.
      if (input.closedPaneSecondsLeft !== null && input.closedPaneSecondsLeft !== undefined) {
        continue;
      }
      expect(decideReap(input, DEFAULTS).afterSeconds).toBe(null);
    }
  });

  it('and never ends a session that is listening on a port', () => {
    // Killing a running server because a tab closed would be the most annoying possible thing.
    for (const input of everyInput()) {
      if (input.listeningPort === undefined || input.exited) continue;
      if (input.closedPaneSecondsLeft !== null && input.closedPaneSecondsLeft !== undefined) {
        continue;
      }
      // In a workspace whose tab was closed, the background timeout still applies to it: that is
      // a tab somebody closed, and the setting is the setting. Outside one, it is protected.
      if (input.inWorkspace && input.tabDisposition === 'closed') continue;
      expect(decideReap(input, DEFAULTS).afterSeconds).toBe(null);
    }
  });

  it('and honors the chosen timeout exactly for a closed tab', () => {
    // The other half of the promise, and the half that was broken: the number somebody picked is
    // the number used, not a default and not something shorter.
    for (const seconds of [300, 1800]) {
      const decision = decideReap(
        {
          pinned: false,
          persistent: false,
          attachedClients: 0,
          tabDisposition: 'closed',
          paneClosedByUser: false,
          inWorkspace: true,
          sharesWorkspace: false,
          exited: false,
          hasExplicitCommand: false,
          keepBackgroundSeconds: seconds,
          neverUsed: false,
          closedPaneSecondsLeft: null,
          detachedForSeconds: 10_000,
        },
        DEFAULTS,
      );
      expect(decision).toEqual({ afterSeconds: seconds, reason: 'tab-closed' });
    }
  });

  it('and keeps forever when that is what was chosen', () => {
    for (const input of everyInput()) {
      if (input.keepBackgroundSeconds !== null) continue;
      if (!input.inWorkspace || input.tabDisposition !== 'closed') continue;
      if (input.exited || input.neverUsed) continue;
      if (input.closedPaneSecondsLeft !== null && input.closedPaneSecondsLeft !== undefined) {
        continue;
      }
      if (input.pinned || input.persistent || input.attachedClients > 0) continue;
      expect(decideReap(input, DEFAULTS).afterSeconds).toBe(null);
    }
  });
});
