import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Filesystem layout. See docs/01-architecture.md.
 *
 * The token file is the only security boundary on the local socket, so its mode is enforced
 * at startup rather than assumed.
 */
/**
 * A whole separate installation, for tests.
 *
 * `TABTERM_HOME` moves the config, the state, the database, the token and the PTY host's socket
 * somewhere else, which makes a second daemon genuinely independent of the one somebody is
 * working in rather than merely on a different port.
 *
 * It exists because the browser suites were sharing a daemon with a person, and a sweep that
 * meant to tidy up test sessions ended a real terminal. Sharing a daemon and being careful is
 * not a safe arrangement; not sharing one is.
 */
const root = process.env['TABTERM_HOME'] ?? homedir();

export const paths = {
  config: join(root, '.config', 'tabterm'),
  state: join(root, '.local', 'state', 'tabterm'),
  get configFile() {
    return join(this.config, 'config.json');
  },
  get tokenFile() {
    return join(this.state, 'token');
  },
  get database() {
    return join(this.state, 'tabterm.sqlite');
  },
  get scrollback() {
    return join(this.state, 'scrollback');
  },
  get logs() {
    return join(this.state, 'logs');
  },
  get lockFile() {
    return join(this.state, 'daemon.lock');
  },
} as const;

export interface Config {
  port: number;
  /** Scrollback lines retained per session. Measured cost is 3.6 MB per session at 10000. */
  scrollbackLines: number;
  /** Detached grace periods, seconds. Workspaces are pinned and never reaped, see ADR-0012. */
  reapIdleShellSeconds: number;
  reapAgentOrEditorSeconds: number;
  reapDefaultSeconds: number;
  /**
   * How long a session survives with nobody able to speak for it, or null to keep it forever.
   *
   * Not the same question as the background timeout, and the difference is the whole reason this
   * exists. The background timeout applies when Chrome has **said** a tab was closed. This
   * applies when Chrome has said nothing at all, for a very long time: closed, crashed, or on a
   * machine whose browser never came back.
   *
   * "Nobody told us" is read as a gap in what we know rather than as permission to end a
   * terminal, which is right and which is also how a machine ends up holding sessions from a
   * browser that stopped existing weeks ago. Three correct rules combined to make those
   * immortal, and on 2026-09-02 that filled the machine's supply of pseudo-terminals and stopped
   * every terminal in every application. See AGENTS/BACKLOG.md WP-27.
   *
   * Seven days. Long enough that a closed laptop, a holiday and a browser crash all cost
   * nothing, short enough that abandoned work does not accumulate forever. What makes ending
   * one acceptable at all is that it does not lose anything: the scrollback is on disk and the
   * tab's recovery page still shows the last screen and the folder it was in.
   */
  abandonUnclaimedSeconds: number | null;
  shell: string;
  /**
   * Foreground processes that get the longer detached grace period. An editor or an agent CLI
   * holds state a shell does not, so losing one to a timer costs more.
   */
  longLivedPrograms: readonly string[];
  /** Coalescing and flow control. The socket is not the bottleneck, the VT parser is. */
  coalesceMs: number;
  maxChunkBytes: number;
  creditWindowBytes: number;
  /** Terminal editor used for Option-click. Receives a line number when one was printed. */
  /** Loopback port for agent CLI hook events. Separate from the socket, same token. */
  agentBridgePort: number;
  /** Command used to launch an agent CLI. argv, never a shell string. */
  agentCommand: readonly string[];
  editor: string;
  /** GUI editor used for Command-click. */
  guiEditor: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * One dial for the memory settings that only make sense together. See memory-modes.ts.
   * A config file may still override any individual field; the mode supplies the baseline.
   */
  memoryMode: 'low' | 'balanced' | 'full';
  /**
   * Archive what commands print. **Off by default and deliberately so**: this is the most
   * sensitive thing the product can hold. See daemon/src/output-archive.ts.
   */
  archiveOutput: boolean;
}

/**
 * Fields of `config.json` that were refused, in the order they were found.
 *
 * Reported by the daemon once logging exists. A person who mistypes a setting should be told
 * which one rather than left wondering why it had no effect.
 */
export const ignoredConfigFields: string[] = [];

/**
 * The fields of a config file that can actually be used, with the rest left at their defaults.
 *
 * The file was spread whole into the running configuration, so anything in it became the truth:
 * a port of `"7377"` as a string, a scrollback of `-1`, a reap interval of `NaN`, a chunk size of
 * `1e12`. None of those is refused anywhere further down, and several of them reach the layer that
 * keeps terminals alive. A hand-edited optional file should not be able to destabilise that.
 *
 * Validated per field rather than per file, and a bad field is warned about and dropped rather
 * than taking the whole file with it. Somebody who mistypes one number should not silently lose
 * the other nine settings they got right.
 *
 * `DEFAULTS` is the schema. Every field's default says what kind it is and what a sane magnitude
 * looks like, which keeps this honest as fields are added: a new field is covered the moment it
 * has a default, rather than the day somebody remembers to add it here.
 */
function usableFields(parsed: Partial<Config>, base: Config): Partial<Config> {
  const good: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const fallback = (base as unknown as Record<string, unknown>)[key];
    if (fallback === undefined) continue; // Not a field this build knows about.

    if (typeof fallback === 'number') {
      // Finite, positive, and not absurd. A million times the shipped value is far past anything
      // meant, and well short of the sizes that turn an allocation into a crash.
      const ceiling = Math.max(Math.abs(fallback), 1) * 1_000_000;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= ceiling) {
        good[key] = value;
        continue;
      }
    } else if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') {
        good[key] = value;
        continue;
      }
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string' && value.trim() !== '') {
        good[key] = value;
        continue;
      }
    } else if (Array.isArray(fallback)) {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '')) {
        good[key] = value;
        continue;
      }
    } else {
      // A shape this function does not understand is left alone rather than guessed at.
      good[key] = value;
      continue;
    }

    /**
     * Recorded, not logged from here.
     *
     * `log.ts` reads `paths` from this module, so importing it back would be a cycle, and this
     * runs before logging has been set up in any case. The daemon reports these once it can.
     */
    ignoredConfigFields.push(key);
  }
  return good;
}

export const DEFAULTS: Config = {
  // `TABTERM_PORT` goes with `TABTERM_HOME`: a separate installation needs a separate port.
  port: Number(process.env['TABTERM_PORT'] ?? '') || 7377,
  scrollbackLines: 10_000,
  reapIdleShellSeconds: 180,
  reapAgentOrEditorSeconds: 600,
  reapDefaultSeconds: 300,
  abandonUnclaimedSeconds: 7 * 24 * 60 * 60,
  shell: process.env['SHELL'] ?? '/bin/zsh',
  longLivedPrograms: ['vim', 'nvim', 'emacs', 'ssh', 'claude', 'agent'],
  coalesceMs: 6,
  maxChunkBytes: 64 * 1024,
  creditWindowBytes: 256 * 1024,
  /**
   * Follows the main port, so a separate installation gets a separate bridge.
   *
   * It was a fixed 7378, which meant only one daemon on the machine could ever start: a second
   * one bound its own port fine and then died on this, and the failure said `EADDRINUSE 7378`
   * with no hint that the bridge was what it was about. That is the whole reason the test
   * daemon looked flaky for days.
   */
  agentBridgePort:
    Number(process.env['TABTERM_AGENT_PORT'] ?? '') ||
    (Number(process.env['TABTERM_PORT'] ?? '') || 7377) + 1,
  agentCommand: ['claude'],
  editor: 'nvim',
  guiEditor: 'code',
  /**
   * Raised with `TABTERM_LOG=debug`, so a defect that only happens on somebody's machine can be
   * looked at without shipping them a special build.
   */
  logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(
    (process.env['TABTERM_LOG'] ?? '') as 'debug' | 'info' | 'warn' | 'error',
  )
    ? (process.env['TABTERM_LOG'] as 'debug' | 'info' | 'warn' | 'error')
    : 'info',
  memoryMode: 'balanced',
  archiveOutput: false,
};

export async function loadConfig(): Promise<Config> {
  const { readFile } = await import('node:fs/promises');
  const { applyMemoryMode, isMemoryMode } = await import('./memory-modes.js');
  try {
    const raw = await readFile(paths.configFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    // The mode supplies the baseline, then explicit fields win. Someone who set a mode *and* a
    // scrollback figure meant both, and the more specific one is the one they typed.
    const base = isMemoryMode(parsed.memoryMode)
      ? applyMemoryMode(DEFAULTS, parsed.memoryMode)
      : DEFAULTS;
    return { ...base, ...usableFields(parsed, base) };
  } catch {
    return { ...DEFAULTS };
  }
}
