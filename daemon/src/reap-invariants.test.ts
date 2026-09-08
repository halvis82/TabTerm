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
        for (const tabDisposition of ['open', 'closed', 'unknown'] as const)
          for (const paneClosedByUser of [false, true])
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
                                tabDisposition,
                                paneClosedByUser,
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
      (i) => i.tabDisposition === 'open' && i.attachedClients === 0 && noUndoWindow(i) && ends(i),
    );
    expect(wrong).toEqual([]);
  });

  it('never ends anything without positive evidence that somebody closed its tab', () => {
    /**
     * The invariant this product is built around, over every arrangement of every other fact.
     *
     * Only `closed` can authorize an automatic ending, and `closed` is only ever produced by an
     * explicit statement that somebody closed that specific tab. Everything else in the world
     * that could make a workspace stop being reported is `unknown`: closing Chrome, closing a
     * window, a crash, a reload of the extension, a discarded tab, a machine that slept, a
     * socket that dropped, a daemon that restarted, a second profile that never had it, a report
     * that arrived late or empty.
     *
     * Three things authorize an ending, and all three are acts or facts rather than inferences:
     * somebody closed the tab, somebody closed the pane, or the process has already exited and
     * there is nothing left to signal. `closedPaneSecondsLeft` is exempt for the same reason as
     * the second: it is the undo window for a pane a person closed.
     */
    const authorized = (i: ReapInput): boolean =>
      i.tabDisposition === 'closed' || i.paneClosedByUser || i.exited;
    const wrong = ALL.filter((i) => !authorized(i) && noUndoWindow(i) && ends(i));
    expect(wrong.map((i) => JSON.stringify(i))).toEqual([]);
  });

  it('never ends anything merely because a long time has passed', () => {
    // A month detached, and nothing else true. Time is not consent, and a laptop shut in a drawer
    // is not somebody finishing with a terminal.
    const month = 60 * 60 * 24 * 30;
    const wrong = ALL.filter(
      (i) =>
        i.tabDisposition === 'unknown' &&
        !i.paneClosedByUser &&
        !i.exited &&
        i.detachedForSeconds === month &&
        noUndoWindow(i) &&
        ends(i),
    );
    expect(wrong.map((i) => JSON.stringify(i))).toEqual([]);
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
        i.tabDisposition !== 'closed' &&
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
      if (i.tabDisposition !== 'unknown' || i.attachedClients > 0) return false;
      // A pane the person closed is an authorization of its own, and not what this is about.
      if (i.paneClosedByUser || i.exited) return false;
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

  it('has no horizon left to schedule, which is the point', () => {
    /**
     * There used to be one: nobody has claimed this session for a week, so end it. It was
     * scheduled from when the session was last detached rather than from now, so a daemon restart
     * could not reset it.
     *
     * It is gone. A week of silence is still silence, and silence is not somebody closing a
     * terminal. What replaced it is nothing at all: a session nobody can account for is kept, and
     * shows up in Running Now for a person to end if they want it ended.
     */
    const base: ReapInput = {
      pinned: false,
      persistent: false,
      attachedClients: 0,
      tabDisposition: 'unknown',
      paneClosedByUser: false,
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
    for (const detachedForSeconds of [0, 60, 7 * 24 * 60 * 60, 10 ** 9]) {
      expect(decideReap({ ...base, detachedForSeconds }, config)).toEqual({
        afterSeconds: null,
        reason: 'no-close-evidence',
      });
    }
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
