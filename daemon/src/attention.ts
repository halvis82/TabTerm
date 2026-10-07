import { access, constants, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { Concern, UpdatePhase } from '@tabterm/shared';
import { processTable } from './process-table.js';
import { debug, warn } from './log.js';
import { safeError } from './safe-error.js';

/**
 * Things the person needs to know about, checked live rather than once at install.
 *
 * The doctor script says all of this, and nobody runs the doctor on a Tuesday afternoon when a
 * terminal starts asking for permission on every launch. Asked for as: if Full Disk Access or
 * something crucial is missing, check for it live and say so in Settings or as a dismissable
 * notice in the tabs. So the daemon checks on a timer, says what it found, and says it again only
 * when the answer changes.
 *
 * Two levels. A `problem` is something that is making terminals worse right now and has a fix
 * the person can do; it goes to Settings and to a notice in every tab. A `note` is worth knowing
 * and goes to Settings only. Optional things, the shell integration and the agent hooks, are not
 * concerns at all: Settings already says what they are doing, and a nag about something optional
 * is how people learn to dismiss everything.
 *
 * The judgement is a pure function of facts, so every case is a unit test. Gathering the facts is
 * the only part that touches the machine.
 */

export interface AttentionFacts {
  /** Whether this daemon is the installed one running inside TabTerm.app. */
  installed: boolean;
  /** Whether Full Disk Access is granted to the bundle. `null` when it could not be told. */
  fullDiskAccess: boolean | null;
  /** Where the bundle lives, for the fix. */
  appPath: string;
  /** What the running terminal host executes, and what this build's host would. */
  hostExecutable: string | null;
  bundledNode: string;
  hostPid: number | null;
  /** The updater's phase, when there is an updater. */
  updatePhase: UpdatePhase | null;
  updateMessage: string;
  /** Pseudo-terminals in use on the whole Mac, against the kernel's ceiling. Null when unknown. */
  ptysUsed: number | null;
  ptysMax: number | null;
}

/** Past this share of the ceiling, the next terminal anywhere may fail to open. */
const PTY_WARN_SHARE = 0.9;

export function judgeAttention(facts: AttentionFacts): Concern[] {
  const concerns: Concern[] = [];

  if (facts.installed && facts.fullDiskAccess === false) {
    concerns.push({
      id: 'full-disk-access',
      level: 'problem',
      title: 'Full Disk Access is not granted to TabTerm',
      detail:
        'An agent that reads another app’s data makes macOS ask in TabTerm’s name on ' +
        'every launch, and a shell cannot read the folders macOS protects. An update can take ' +
        'the grant away: macOS keys it to the app’s signature, and the entry stays listed ' +
        'while no longer applying.',
      fix:
        'System Settings, Privacy & Security, Full Disk Access. If TabTerm is listed, select it ' +
        'and press minus first. Then press plus and add ' +
        facts.appPath +
        '. Read what that grants before you do: it is broad, and it goes to the process that runs ' +
        'your shells.',
      fingerprint: 'fda:off',
    });
  }

  if (
    facts.installed &&
    facts.hostExecutable !== null &&
    facts.hostExecutable !== facts.bundledNode
  ) {
    concerns.push({
      id: 'host-from-before-update',
      level: 'note',
      title: 'The terminal host is still the one from before an update',
      detail:
        'It runs ' +
        facts.hostExecutable +
        ', so a permission prompt names that binary rather than TabTerm and macOS cannot ' +
        'remember the answer. Nothing restarts it for you, because restarting it ends every ' +
        'terminal it holds.',
      fix:
        'When you are ready to lose the terminals it holds, in any shell: kill ' +
        String(facts.hostPid ?? '') +
        '. The daemon starts a new host within a second or two.',
      fingerprint: 'host:' + facts.hostExecutable,
    });
  }

  if (
    facts.ptysUsed !== null &&
    facts.ptysMax !== null &&
    facts.ptysMax > 0 &&
    facts.ptysUsed >= facts.ptysMax * PTY_WARN_SHARE
  ) {
    concerns.push({
      id: 'ptys-nearly-exhausted',
      level: 'problem',
      title: 'This Mac is nearly out of terminals',
      detail:
        String(facts.ptysUsed) +
        ' of ' +
        String(facts.ptysMax) +
        ' pseudo-terminals are in use, counting every app. When they run out, nothing can open ' +
        'a terminal, TabTerm or iTerm alike, and the only way back is a restart.',
      fix:
        'End terminals you are done with, in any app: Running Now lists TabTerm’s, and ' +
        'the count is machine-wide.',
      fingerprint: 'ptys:high',
    });
  }

  if (
    facts.updatePhase === 'rolled-back' ||
    facts.updatePhase === 'manual' ||
    facts.updatePhase === 'error'
  ) {
    concerns.push({
      id: 'update-needs-attention',
      level: facts.updatePhase === 'manual' ? 'problem' : 'note',
      title:
        facts.updatePhase === 'rolled-back'
          ? 'An update failed and the previous companion was restored'
          : facts.updatePhase === 'manual'
            ? 'An interrupted update needs recovery'
            : 'The last update check or install failed',
      detail: facts.updateMessage,
      fix:
        facts.updatePhase === 'manual'
          ? 'Run the companion installer once from a known-good checkout: ./scripts/install.sh'
          : 'Settings, Updates, Check for updates. If it fails again, run the installer from a ' +
            'known-good checkout.',
      fingerprint: 'update:' + facts.updatePhase + ':' + facts.updateMessage,
    });
  }

  return concerns;
}

/** Full Disk Access, probed by a file only that grant unlocks and that never raises a prompt. */
export async function probeFullDiskAccess(home: string): Promise<boolean | null> {
  /*
   * The user's own TCC database. It exists on every Mac, it is Apple's rather than another
   * app's, so reading it cannot raise the "access data from other apps" prompt, and it is
   * readable only with Full Disk Access. The folders people notice, Desktop and Documents,
   * are the wrong probe: asking about those raises a consent prompt and blocks until it is
   * answered, which the doctor script guards with a timeout for exactly that reason.
   */
  const probe = join(home, 'Library/Application Support/com.apple.TCC/TCC.db');
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000));
  try {
    const answer = await Promise.race([access(probe, constants.R_OK).then(() => 'ok'), timeout]);
    return answer === 'ok' ? true : null;
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    // Anything else is a machine this probe does not understand, and saying nothing is right.
    return null;
  }
}

/** How many pseudo-terminals the Mac is using, against the kernel's ceiling. */
export async function countPtys(): Promise<{ used: number; max: number } | null> {
  try {
    const [entries, out] = await Promise.all([
      readdir('/dev'),
      new Promise<string>((resolve) =>
        execFile('/usr/sbin/sysctl', ['-n', 'kern.tty.ptmx_max'], { timeout: 2000 }, (e, stdout) =>
          resolve(e ? '' : stdout),
        ),
      ),
    ]);
    const max = Number(out.trim());
    if (!Number.isFinite(max) || max <= 0) return null;
    const used = entries.filter((name) => /^ttys\d+$/.test(name)).length;
    return { used, max };
  } catch {
    return null;
  }
}

/** The running terminal host's executable, from the process table, or null when none runs. */
export async function findHost(): Promise<{ executable: string; pid: number } | null> {
  const table = await processTable();
  if (!table) return null;
  for (const rows of table.byParent.values()) {
    for (const row of rows) {
      if (!row.command.includes('libexec/tabterm/pty-host.mjs')) continue;
      const executable = row.command.split(/\s+/)[0] ?? '';
      if (executable === '') continue;
      return { executable, pid: row.pid };
    }
  }
  return null;
}

export interface AttentionMonitorOptions {
  gather: () => Promise<AttentionFacts>;
  changed: (concerns: Concern[]) => void;
  /** How often to look again. Every ten minutes by default: these change rarely and ps costs. */
  everyMs?: number;
}

/**
 * Checks on a timer, and says something only when the answer changes.
 */
export class AttentionMonitor {
  #concerns: Concern[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | null = null;
  readonly #opts: AttentionMonitorOptions;

  constructor(opts: AttentionMonitorOptions) {
    this.#opts = opts;
  }

  get concerns(): readonly Concern[] {
    return this.#concerns;
  }

  start(): void {
    // A little after start, so a machine still waking up is not judged on its first second.
    setTimeout(() => void this.check(), 15_000).unref?.();
    this.#timer = setInterval(() => void this.check(), this.#opts.everyMs ?? 10 * 60_000);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** Look now. Returns the concerns as they stand afterwards. */
  check(): Promise<void> {
    this.#running ??= (async () => {
      try {
        const facts = await this.#opts.gather();
        const next = judgeAttention(facts);
        if (!sameConcerns(this.#concerns, next)) {
          this.#concerns = next;
          debug('attention.changed', { ids: next.map((c) => c.id) });
          this.#opts.changed(next);
        }
      } catch (error: unknown) {
        warn('attention.check-failed', { error: safeError(error) });
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** What a test daemon is told to believe, so the surfaces can be driven without a broken Mac. */
  pretend(concerns: Concern[]): void {
    this.#concerns = concerns;
    this.#opts.changed(concerns);
  }
}

function sameConcerns(a: readonly Concern[], b: readonly Concern[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.id === b[i]?.id && c.fingerprint === b[i]?.fingerprint);
}
