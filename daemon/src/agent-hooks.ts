import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomic-write.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentHooksStatus, AgentHookTarget } from '@tabterm/shared';
import { info, warn } from './log.js';
import { safeError } from './safe-error.js';

/**
 * Agent CLI hooks: install, remove, and report.
 *
 * An agent CLI reports its own lifecycle through hooks, which is the only honest way to know
 * that a turn finished. The alternative is reading the screen, which invariant 8 forbids and
 * which would break on the next release of somebody else's tool.
 *
 * This used to be a script a person had to find in the install output, which meant almost
 * nobody ran it and agent status silently did nothing for them. It lives here so the extension
 * can offer it as a switch, and the script is now a thin wrapper over the same code. There is
 * one implementation, so the two paths cannot drift.
 *
 * Editing configuration we did not write is done carefully: opt in, additive, backed up once
 * before the first change, and removable to the byte. See docs/09-agent-integration.md.
 */

/** Ours are the only entries carrying this, so removal is exact rather than approximate. */
const MARKER = 'tabterm-agent-hook';

export const HOOK_SCRIPT = join(homedir(), '.local', 'libexec', 'tabterm', 'agent-hook.sh');

/**
 * The events worth reporting.
 *
 * `UserPromptSubmit` and `Stop` are the load-bearing pair: together they bound a turn, which is
 * what makes "this took four minutes" a thing that can be said at all.
 */
const HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
] as const;

export type AgentTarget = Omit<AgentHookTarget, 'detected' | 'installed'>;

/**
 * Agent CLIs this knows about.
 *
 * Unsupported entries are listed rather than hidden. Someone with Codex installed is better
 * served by "found, not supported yet" than by silence, and inventing a config format for a
 * tool whose format has not been verified would write hooks that quietly never fire.
 */
export const AGENT_TARGETS: readonly AgentTarget[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    settingsPath: join(homedir(), '.claude', 'settings.json'),
    supported: true,
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    settingsPath: join(homedir(), '.codex', 'config.toml'),
    supported: false,
    command: 'codex',
    install: 'npm i -g @openai/codex',
  },
];

export type AgentTargetStatus = AgentHookTarget;

type Settings = Record<string, unknown>;
type HookEntry = { matcher?: string; hooks?: unknown[] };

const isOurs = (entry: unknown): boolean => JSON.stringify(entry).includes(MARKER);

function entriesFor(settings: Settings, hook: string): unknown[] {
  const hooks = settings['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return [];
  const list = (hooks as Record<string, unknown>)[hook];
  return Array.isArray(list) ? list : [];
}

/**
 * Add our hooks to a settings object, returning a new one.
 *
 * Pure, so the interesting property can be tested without touching anyone's home directory:
 * unrelated settings come out byte identical, and running it twice produces one set of hooks
 * rather than two.
 */
export function withHooks(settings: Settings, script = HOOK_SCRIPT): Settings {
  const hooks: Record<string, unknown> = { ...((settings['hooks'] as object | undefined) ?? {}) };
  for (const hook of HOOKS) {
    const kept = entriesFor(settings, hook).filter((e) => !isOurs(e));
    const entry: HookEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: `${script} ${hook} # ${MARKER}` }],
    };
    hooks[hook] = [...kept, entry];
  }
  return { ...settings, hooks };
}

/** Remove exactly what we added, and nothing else. */
export function withoutHooks(settings: Settings): Settings {
  const hooks: Record<string, unknown> = { ...((settings['hooks'] as object | undefined) ?? {}) };
  for (const hook of Object.keys(hooks)) {
    const kept = entriesFor(settings, hook).filter((e) => !isOurs(e));
    if (kept.length === 0) delete hooks[hook];
    else hooks[hook] = kept;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length === 0) delete next['hooks'];
  else next['hooks'] = hooks;
  return next;
}

/** Whether every event we care about is wired up. A partial install is not installed. */
export function hooksPresent(settings: Settings): boolean {
  return HOOKS.every((hook) => entriesFor(settings, hook).some(isOurs));
}

function readSettings(path: string): Settings | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Settings) : null;
  } catch {
    // Unparseable means somebody else's edit is in flight, or the file is not what we think it
    // is. Either way, refusing to touch it is the only safe answer.
    return null;
  }
}

function writeSettings(path: string, settings: Settings): void {
  if (existsSync(path)) {
    // One backup, before the first modification, of a file we did not write.
    const backup = `${path}.tabterm-backup`;
    if (!existsSync(backup)) copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  // An agent's own settings file, so it is replaced whole rather than truncated and refilled.
  writeFileAtomic(path, JSON.stringify(settings, null, 2) + '\n', 0o644);
}

/**
 * Where a command actually is on this machine, or nothing.
 *
 * The command is looked for rather than assumed, because "installed for Claude Code" said to
 * somebody who does not have Claude Code is worse than saying nothing at all. A leftover
 * `~/.claude` from a tool used once and removed is not the tool.
 *
 * PATH is searched directly rather than by running a shell. Spawning one per settings panel is
 * slow, and a login shell's PATH is not necessarily the daemon's, so the answer would be about
 * the wrong environment anyway. The usual install locations are checked as well, because a
 * daemon started by launchd has a famously short PATH.
 */
function findCommand(command: string): string | undefined {
  const fromPath = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  const common = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const directory of [...fromPath, ...common]) {
    const candidate = join(directory, command);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // A directory that cannot be read is a directory the command is not in.
    }
  }
  return undefined;
}

/** Targets whose tool is actually present, since installing for an absent one is noise. */
function detectedTargets(): AgentTargetStatus[] {
  return AGENT_TARGETS.map((target) => {
    const settings = target.supported ? readSettings(target.settingsPath) : null;
    const commandPath = findCommand(target.command);
    return {
      ...target,
      /**
       * The command itself, or its configuration directory.
       *
       * Either is evidence the tool is on this machine. The directory alone used to be enough,
       * which is how a panel came to report hooks installed for a tool nobody had.
       */
      detected: commandPath !== undefined || existsSync(dirname(target.settingsPath)),
      ...(commandPath === undefined ? {} : { commandPath }),
      installed: settings !== null && hooksPresent(settings),
    };
  });
}

export function agentHooksStatus(lastEventAt?: number): AgentHooksStatus {
  const targets = detectedTargets();
  const relevant = targets.filter((t) => t.supported && t.detected);
  return {
    installed: relevant.length > 0 && relevant.every((t) => t.installed),
    targets,
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
  };
}

/**
 * Turn hooks on or off for every supported agent CLI present.
 *
 * Returns the resulting status rather than a boolean, because the caller is a settings switch
 * that has to show what actually happened, including the case where nothing was installed
 * because no supported agent CLI is on the machine.
 */
export function setAgentHooks(enabled: boolean, lastEventAt?: number): AgentHooksStatus {
  for (const target of AGENT_TARGETS) {
    if (!target.supported) continue;
    if (!enabled && !existsSync(target.settingsPath)) continue;
    if (enabled && !existsSync(dirname(target.settingsPath))) continue;

    const settings = readSettings(target.settingsPath);
    if (settings === null) {
      warn('agent-hooks.unreadable', { path: target.settingsPath });
      continue;
    }
    try {
      writeSettings(target.settingsPath, enabled ? withHooks(settings) : withoutHooks(settings));
      info('agent-hooks.changed', { target: target.id, enabled });
    } catch (e: unknown) {
      warn('agent-hooks.write-failed', { path: target.settingsPath, error: safeError(e) });
    }
  }
  return agentHooksStatus(lastEventAt);
}
