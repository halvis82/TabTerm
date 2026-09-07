import { describe, expect, it } from 'vitest';
import { decideReap, type ReapInput } from './cleanup.js';
import { DEFAULTS, type Config } from './config.js';

const config: Config = { ...DEFAULTS };

/**
 * Every combination of inputs, rather than the handful somebody thought of.
 *
 * The question is not "does the policy do the right thing in these five cases" but "is there any
 * arrangement of facts in which a session that should live is ended". A sweep answers that, and
 * the space is small enough to walk: six thousand cases run in a few milliseconds.
 */
function everyInput(): ReapInput[] {
  const out: ReapInput[] = [];
  for (const pinned of [false, true])
    for (const persistent of [false, true])
      for (const attachedClients of [0, 1])
        for (const hasOpenTab of [true, false, null])
          for (const inWorkspace of [false, true])
            for (const sharesWorkspace of [false, true])
              for (const neverUsed of [false, true])
                for (const exited of [false, true])
                  for (const listeningPort of [undefined, 3000])
                    for (const hasExplicitCommand of [false, true])
                      for (const closedPaneSecondsLeft of [null, 30])
                        for (const keepBackgroundSeconds of [null, 600])
                          for (const detachedForSeconds of [0, 60 * 60 * 24 * 30])
                            out.push({
                              pinned,
                              persistent,
                              attachedClients,
                              hasOpenTab,
                              inWorkspace,
                              sharesWorkspace,
                              neverUsed,
                              exited,
                              listeningPort,
                              hasExplicitCommand,
                              closedPaneSecondsLeft,
                              keepBackgroundSeconds,
                              detachedForSeconds,
                            });
  return out;
}

const ALL = everyInput();
/** No pane of this session was deliberately closed, so no undo window is counting down. */
const noUndoWindow = (i: ReapInput): boolean =>
  i.closedPaneSecondsLeft === null || i.closedPaneSecondsLeft === undefined;

/** Would this input end the session at all, at any delay? */
const ends = (input: ReapInput): boolean => decideReap(input, config).afterSeconds !== null;

describe('across every arrangement of facts, a session ends only when it should', () => {
  it('covers a real space rather than a few examples', () => {
    expect(ALL.length).toBeGreaterThan(4000);
  });

  it('never ends a session somebody is looking at', () => {
    // A connection is the strongest evidence there is: a window is open on this terminal now.
    const wrong = ALL.filter((i) => i.attachedClients > 0 && ends(i));
    expect(wrong).toEqual([]);
  });

  it('never ends a session whose tab is open', () => {
    /**
     * Unless the pane inside that tab was deliberately closed, which is the undo window and is
     * the one case where a countdown against an open tab is correct.
     */
    const wrong = ALL.filter(
      (i) => i.hasOpenTab === true && i.attachedClients === 0 && noUndoWindow(i) && ends(i),
    );
    expect(wrong).toEqual([]);
  });

  it('never ends a pinned or persistent session, whatever else is true', () => {
    expect(ALL.filter((i) => (i.pinned || i.persistent) && ends(i))).toEqual([]);
  });

  it('never ends a session that is serving on a port', () => {
    /**
     * A listening port means something is running that other things are talking to. It is the
     * one signal the daemon has that a detached session is doing work rather than idling.
     */
    const wrong = ALL.filter(
      (i) =>
        i.listeningPort !== undefined &&
        i.attachedClients === 0 &&
        noUndoWindow(i) &&
        !i.exited &&
        i.hasOpenTab !== false &&
        ends(i),
    );
    expect(wrong).toEqual([]);
  });

  it('never ends a session that was given a command to run, on the never-used rule', () => {
    // Its output is the reason it exists. "Nothing was typed here" is not evidence about it.
    const wrong = ALL.filter(
      (i) => i.hasExplicitCommand && decideReap(i, config).reason === 'never-used',
    );
    expect(wrong).toEqual([]);
  });

  it('never ends a session sharing a workspace with others, on the never-used rule', () => {
    /**
     * The reported one. Five terminals ended thirty seconds after an extension reload, by the
     * rule that clears untouched panes: a pane in an arrangement somebody spent the morning
     * building is not a tab they opened and forgot.
     */
    const wrong = ALL.filter(
      (i) => i.sharesWorkspace && decideReap(i, config).reason === 'never-used',
    );
    expect(wrong).toEqual([]);
  });

  it('never ends one nobody could report on any time soon', () => {
    /**
     * `null` means the extension could not say. Silence is not evidence that a tab is gone, so
     * the only thing that ends one of these is the abandonment horizon, days away.
     *
     * Stated as a delay rather than as a yes or no, because that is what the policy actually
     * decides. Everything it schedules is re-decided at the moment the timer fires, so a long
     * delay is not a countdown to a death: it is a promise to look again much later.
     */
    const soon = 60 * 60; // An hour. Nothing here should be scheduled inside one.
    const wrong = ALL.filter((i) => {
      if (i.hasOpenTab !== null || i.attachedClients > 0) return false;
      if (
        (i.closedPaneSecondsLeft !== null && i.closedPaneSecondsLeft !== undefined) ||
        i.pinned ||
        i.persistent
      )
        return false;
      if (i.detachedForSeconds >= (config.abandonUnclaimedSeconds ?? Infinity)) return false;
      const after = decideReap(i, config).afterSeconds;
      return after !== null && after < soon;
    });
    expect(wrong).toEqual([]);
  });

  it('and schedules the horizon from when it was last detached, not from now', () => {
    // A restart happens on every update, and treating a session as new each time would reset a
    // clock that is supposed to run out after a week of nobody claiming it.
    const base: ReapInput = {
      pinned: false,
      persistent: false,
      attachedClients: 0,
      hasOpenTab: null,
      inWorkspace: false,
      sharesWorkspace: false,
      neverUsed: false,
      exited: false,
      listeningPort: undefined,
      hasExplicitCommand: false,
      closedPaneSecondsLeft: null,
      keepBackgroundSeconds: null,
      detachedForSeconds: 0,
    };
    const horizon = config.abandonUnclaimedSeconds ?? 0;
    expect(decideReap(base, config).afterSeconds).toBe(horizon);
    const old = decideReap({ ...base, detachedForSeconds: horizon - 100 }, config);
    expect(old.afterSeconds).toBe(100);
    const overdue = decideReap({ ...base, detachedForSeconds: horizon + 5000 }, config);
    expect(overdue.afterSeconds).toBe(0);
  });

  it('gives every decision a reason, and every ending a delay that is not negative', () => {
    for (const input of ALL) {
      const d = decideReap(input, config);
      expect(d.reason).toMatch(/^[a-z-]+$/);
      if (d.afterSeconds !== null) expect(d.afterSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('ends something, or the policy would be a leak rather than a policy', () => {
    // The other direction: a rule that never fires keeps every abandoned shell on the machine
    // forever, which is what the seven day horizon exists to prevent.
    expect(ALL.some((i) => ends(i))).toBe(true);
  });
});
