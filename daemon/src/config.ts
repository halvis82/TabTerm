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
  agentBridgePort: 7378,
  agentCommand: ['claude'],
  editor: 'nvim',
  guiEditor: 'code',
  logLevel: 'info',
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
    return { ...base, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}
