import { foregroundOf, isNoise, type ForegroundProcess } from './foreground.js';
import { debug } from './log.js';

/**
 * Command start and end for shells with no integration installed.
 *
 * A fallback, and explicitly second-best: OSC 133 is exact, instant, and free, and this is
 * neither instant nor free. It exists because "install the shell integration or these features
 * do nothing" is a bad answer when the OS can answer the question.
 *
 * **It defers to the real thing.** The moment a session reports an OSC 133 mark, this stops
 * looking at that session for good. Two sources of truth would double every history entry.
 *
 * ### Why there is a timer here, when the rest of the daemon has none
 *
 * `docs/11-performance.md` says any timer must justify why an event cannot serve instead. Here
 * is the justification:
 *
 * - **Starting** is event-driven. Nothing runs until the user presses Enter, which the daemon
 *   already sees as input. One `ps` follows, once.
 * - **Finishing** has no event. A process exiting produces no output and no input, and the
 *   daemon holds no handle on it. So a check runs while a command is known to be in flight —
 *   and *only* then. An idle shell, which is the overwhelmingly common state, costs nothing at
 *   all: no timer exists.
 *
 * The interval is deliberately slack. Elapsed time is computed in the frontend from the start
 * timestamp, so a late end event costs a slightly late "finished", not a wrong duration.
 */

/** Long enough for the shell to fork and exec, short enough to catch a command that is brief. */
const START_DELAY_MS = 220;

/** Only ever runs while something is in flight. */
const POLL_MS = 1000;

/** A command still running after this stops being polled; it is a session, not a command. */
const MAX_TRACKED_MS = 6 * 60 * 60 * 1000;

export interface TrackerEvents {
  onStart: (sessionId: string, command: string, startedAt: number) => void;
  onEnd: (sessionId: string, command: string, durationMs: number) => void;
}

interface Tracked {
  shellPid: number;
  /** Set while a command is running. */
  running?: { command: string; pid: number; startedAt: number };
  timer?: NodeJS.Timeout;
  /** Set once the session proves it has real shell integration. */
  hasIntegration: boolean;
}

export class CommandTracker {
  readonly #sessions = new Map<string, Tracked>();
  readonly #events: TrackerEvents;
  readonly #probe: (pid: number) => Promise<ForegroundProcess | null>;

  constructor(events: TrackerEvents, probe = foregroundOf) {
    this.#events = events;
    this.#probe = probe;
  }

  add(sessionId: string, shellPid: number): void {
    this.#sessions.set(sessionId, { shellPid, hasIntegration: false });
  }

  remove(sessionId: string): void {
    const tracked = this.#sessions.get(sessionId);
    if (tracked?.timer) clearTimeout(tracked.timer);
    this.#sessions.delete(sessionId);
  }

  /**
   * This session has real shell integration, so stop guessing at it.
   *
   * Called on the first OSC 133 mark. Anything this was mid-way through is abandoned rather
   * than completed, because the integration will report it properly.
   */
  markIntegrated(sessionId: string): void {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked || tracked.hasIntegration) return;
    tracked.hasIntegration = true;
    delete tracked.running;
    if (tracked.timer) clearTimeout(tracked.timer);
    delete tracked.timer;
    debug('tracker.deferring-to-integration', { sessionId });
  }

  /**
   * Input arrived. A carriage return is the only byte worth reacting to.
   *
   * Everything else a person types is editing a line that has not been submitted yet.
   */
  onInput(sessionId: string, data: string): void {
    if (!data.includes('\r') && !data.includes('\n')) return;
    const tracked = this.#sessions.get(sessionId);
    if (!tracked || tracked.hasIntegration || tracked.running) return;

    if (tracked.timer) clearTimeout(tracked.timer);
    const timer = setTimeout(() => {
      void this.#checkStart(sessionId);
    }, START_DELAY_MS);
    timer.unref();
    tracked.timer = timer;
  }

  async #checkStart(sessionId: string): Promise<void> {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked || tracked.hasIntegration || tracked.running) return;
    delete tracked.timer;

    const foreground = await this.#probe(tracked.shellPid);
    // Nothing running means the user pressed Enter on an empty prompt, or ran a builtin. Both
    // are correct outcomes, not failures.
    if (!foreground || isNoise(foreground.command)) return;
    /**
     * The shell itself is not a command it ran.
     *
     * An idle shell is its own foreground process, so this reported `/bin/zsh -l` as a command
     * that had been running for as long as the session had existed. Every idle session did it,
     * which is why five identical notifications arrived at once saying a shell had finished
     * after twelve minutes.
     */
    if (foreground.pid === tracked.shellPid) return;

    const startedAt = Date.now();
    tracked.running = { command: foreground.command, pid: foreground.pid, startedAt };
    this.#events.onStart(sessionId, foreground.command, startedAt);
    this.#scheduleEndCheck(sessionId);
  }

  #scheduleEndCheck(sessionId: string): void {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked?.running) return;
    if (tracked.timer) clearTimeout(tracked.timer);

    const timer = setTimeout(() => {
      void this.#checkEnd(sessionId);
    }, POLL_MS);
    timer.unref();
    tracked.timer = timer;
  }

  async #checkEnd(sessionId: string): Promise<void> {
    const tracked = this.#sessions.get(sessionId);
    if (!tracked?.running) return;
    delete tracked.timer;

    const running = tracked.running;
    if (Date.now() - running.startedAt > MAX_TRACKED_MS) {
      // Something that has run for hours is a session, not a command. Stop watching it rather
      // than checking forever.
      delete tracked.running;
      return;
    }

    const foreground = await this.#probe(tracked.shellPid);
    if (foreground && foreground.pid === running.pid) {
      this.#scheduleEndCheck(sessionId);
      return;
    }

    // Either nothing is in the foreground, or something else is. Either way the command that
    // was being tracked is over.
    delete tracked.running;
    this.#events.onEnd(sessionId, running.command, Date.now() - running.startedAt);

    // A different command already in the foreground means one finished and the next began
    // between checks, which happens with a `&&` chain. Pick it up rather than missing it.
    if (foreground && foreground.pid !== tracked.shellPid && !isNoise(foreground.command)) {
      const startedAt = Date.now();
      tracked.running = { command: foreground.command, pid: foreground.pid, startedAt };
      this.#events.onStart(sessionId, foreground.command, startedAt);
      this.#scheduleEndCheck(sessionId);
    }
  }

  /** Whether anything is currently being tracked, for tests and diagnostics. */
  isRunning(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.running !== undefined;
  }

  usesIntegration(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.hasIntegration ?? false;
  }
}
