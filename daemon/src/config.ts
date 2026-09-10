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
  /** Copies of files dropped onto a window, so a drop can become a path. See `dropped-files.ts`. */
  get dropped() {
    return join(this.state, 'dropped');
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
   * There is no age at which a terminal may be ended.
   *
   * `abandonUnclaimedSeconds` used to be here, at seven days, with a comment explaining why that
   * was a reasonable age. Nothing read it. No policy consulted it, and the only reference left in
   * the product was a test modelling a rule that had already been taken out.
   *
   * Deleted rather than left, because a setting for a destructive policy that no longer exists is
   * a path back to one, and the rule it would bring back is the one this product is built around.
   * Age is not evidence of intent: a laptop closed for a fortnight is not somebody saying they
   * are finished. What keeps the supply of pseudo-terminals from filling is the background
   * timeout, which is authorised by a browser saying the tab is gone.
   */
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
/**
 * What each field is actually allowed to be.
 *
 * Written out per field rather than inferred from the type of the shipped default. The generic
 * rule accepted anything of the right JavaScript type within a million times the default, which
 * meant `memoryMode: "banana"` was a string and therefore fine, `logLevel: "chatty"` was fine, and
 * a port of four billion was a positive number well inside the ceiling. None of those are values
 * this program can do anything sensible with, and a resource bound derived from "the default times
 * a million" is not a bound anybody chose.
 *
 * The point is not that a hand-written local config file is dangerous. It is that a value which
 * cannot work should be refused where it is read, and named, rather than carried into the middle
 * of the daemon to fail somewhere with no obvious connection to the file.
 */
type Rule = (value: unknown) => boolean;

const isInt =
  (min: number, max: number): Rule =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
/**
 * Seconds, which may be fractional, and must be more than none.
 *
 * Greater than zero rather than at least zero, which is what this refused before and is worth
 * keeping: a grace period of zero reads like "no grace" and behaves like "end it on the next tick",
 * and nobody writing a config file means the second one.
 */
const isSeconds =
  (max: number): Rule =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max;
const isOneOf =
  (...allowed: readonly string[]): Rule =>
  (v) =>
    typeof v === 'string' && allowed.includes(v);
const isText =
  (max: number): Rule =>
  (v) =>
    typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isTextList =
  (maxItems: number, maxLength: number): Rule =>
  (v) =>
    Array.isArray(v) &&
    v.length <= maxItems &&
    v.every((item) => typeof item === 'string' && item.trim() !== '' && item.length <= maxLength);
const isBool: Rule = (v) => typeof v === 'boolean';

const PORT = isInt(1, 65535);

const RULES: Record<string, Rule> = {
  port: PORT,
  agentBridgePort: PORT,
  // Ten million lines of scrollback is far more than anybody keeps and still allocatable.
  scrollbackLines: isInt(1, 10_000_000),
  // A grace period of a year is meaningless, and zero is "immediately", which tests use.
  reapIdleShellSeconds: isSeconds(365 * 24 * 60 * 60),
  reapAgentOrEditorSeconds: isSeconds(365 * 24 * 60 * 60),
  reapDefaultSeconds: isSeconds(365 * 24 * 60 * 60),
  // A second of coalescing would be visible as lag. One millisecond is the smallest that means
  // anything; zero was refused before this table existed and still is.
  coalesceMs: isInt(1, 1000),
  // Big enough for any terminal write, small enough that one allocation is not a problem.
  maxChunkBytes: isInt(1024, 16 * 1024 * 1024),
  creditWindowBytes: isInt(1024, 64 * 1024 * 1024),
  shell: isText(4096),
  editor: isText(4096),
  guiEditor: isText(4096),
  longLivedPrograms: isTextList(256, 256),
  agentCommand: isTextList(64, 4096),
  logLevel: isOneOf('debug', 'info', 'warn', 'error'),
  memoryMode: isOneOf('low', 'balanced', 'full'),
  archiveOutput: isBool,
};

function usableFields(parsed: Partial<Config>, base: Config): Partial<Config> {
  const good: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const fallback = (base as unknown as Record<string, unknown>)[key];
    if (fallback === undefined) continue; // Not a field this build knows about.

    const rule = RULES[key];
    /**
     * A known field with no rule is a mistake in this table, not permission.
     *
     * Refusing it keeps the default, which is the safe direction, and the field is named in the
     * report so it is visible rather than silently ignored for ever.
     */
    if (rule !== undefined && rule(value)) {
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
