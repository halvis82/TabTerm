import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayoutNode } from '@tabterm/shared';
import { warn } from './log.js';

/**
 * Project-local configuration.
 *
 * A cloned repository is untrusted input. This is the highest-severity surface in the product,
 * because the whole point of the file is to describe commands to run.
 *
 * The rule that makes it safe: **declarative JSON never executes anything by itself.** It
 * describes a layout whose commands run only when a person deliberately opens that workspace,
 * and every command is argv, so nothing in the file can smuggle shell syntax. Anything
 * genuinely executable is refused outright rather than gated behind a prompt, because there is
 * no version of "run this repository's script" that is safe by default.
 * See docs/05-security.md §5.
 */

export const CONFIG_NAMES = ['.tabterm.json', join('.tabterm', 'workspace.json')] as const;

export interface ProjectTemplate {
  name: string;
  cwd?: string;
  layout: LayoutNode | null;
  /** One command per pane, in pane order. Always argv. */
  commands: readonly (readonly string[])[];
  group?: { title: string; color: string };
}

export interface LoadedProjectConfig {
  path: string;
  /** Hash of the exact bytes read, so a changed file invalidates any trust decision. */
  contentHash: string;
  template: ProjectTemplate;
}

const MAX_BYTES = 64 * 1024;
const MAX_PANES = 8;

/** Chrome accepts only these. See docs/10-limitations.md tier 1.5. */
const GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

export class ProjectConfigError extends Error {}

export async function findProjectConfig(root: string): Promise<LoadedProjectConfig | null> {
  for (const name of CONFIG_NAMES) {
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const raw = await readFile(path, 'utf8');
      return {
        path,
        contentHash: createHash('sha256').update(raw).digest('hex'),
        template: parseProjectConfig(raw),
      };
    } catch (e) {
      if (e instanceof ProjectConfigError) {
        warn('project-config.rejected', { path, reason: e.message });
        return null;
      }
      // Absent or unreadable is the normal case, not an error worth reporting.
    }
  }
  return null;
}

/**
 * Parse and validate, rejecting anything that could execute on its own.
 *
 * Every failure is a refusal rather than a repair. A config that is almost valid is still a
 * config nobody reviewed, and quietly fixing it would hide what it actually said.
 */
export function parseProjectConfig(raw: string): ProjectTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProjectConfigError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectConfigError('not an object');
  }

  const obj = parsed as Record<string, unknown>;

  // An executable entry point is refused outright. There is no prompt that makes running a
  // cloned repository's script a reasonable default.
  for (const forbidden of ['plugin', 'script', 'exec', 'setup', 'preLaunch', 'postLaunch']) {
    if (forbidden in obj) {
      throw new ProjectConfigError(`executable field '${forbidden}' is never supported`);
    }
  }

  const name = typeof obj['name'] === 'string' ? obj['name'].slice(0, 120) : 'Project workspace';
  const cwd = typeof obj['cwd'] === 'string' ? obj['cwd'] : undefined;

  const commands: string[][] = [];
  const layout = obj['layout'] === undefined ? null : readLayout(obj['layout'], commands);
  if (commands.length > MAX_PANES) {
    throw new ProjectConfigError(`more than ${String(MAX_PANES)} panes`);
  }

  let group: { title: string; color: string } | undefined;
  const rawGroup = obj['group'];
  if (typeof rawGroup === 'object' && rawGroup !== null) {
    const g = rawGroup as Record<string, unknown>;
    const title = typeof g['title'] === 'string' ? g['title'].slice(0, 60) : '';
    const color = typeof g['color'] === 'string' ? g['color'] : 'blue';
    if (title) group = { title, color: GROUP_COLORS.has(color) ? color : 'blue' };
  }

  return {
    name,
    ...(cwd ? { cwd } : {}),
    layout,
    commands,
    ...(group ? { group } : {}),
  };
}

/** Recursively read a layout, collecting each pane's argv in pane order. */
function readLayout(node: unknown, commands: string[][], depth = 0): LayoutNode {
  if (depth > 8) throw new ProjectConfigError('layout nested too deeply');
  if (typeof node !== 'object' || node === null) throw new ProjectConfigError('bad layout node');

  const obj = node as Record<string, unknown>;

  if ('terminal' in obj) {
    const terminal = obj['terminal'];
    const spec =
      typeof terminal === 'object' && terminal !== null
        ? (terminal as Record<string, unknown>)
        : {};
    commands.push(readCommand(spec['command']));
    // paneId and sessionId are assigned by the daemon; a config cannot name them.
    return { type: 'terminal', paneId: `p${String(commands.length)}`, sessionId: '' };
  }

  if ('children' in obj) {
    const children = obj['children'];
    if (!Array.isArray(children) || children.length !== 2) {
      throw new ProjectConfigError('a split needs exactly two children');
    }
    const direction = obj['direction'] === 'vertical' ? 'vertical' : 'horizontal';
    const ratio =
      typeof obj['ratio'] === 'number' && Number.isFinite(obj['ratio']) ? obj['ratio'] : 0.5;
    return {
      type: 'split',
      direction,
      ratio: Math.min(0.95, Math.max(0.05, ratio)),
      children: [
        readLayout(children[0], commands, depth + 1),
        readLayout(children[1], commands, depth + 1),
      ],
    };
  }

  throw new ProjectConfigError('layout node is neither a terminal nor a split');
}

/**
 * A command must be argv.
 *
 * A string form is refused rather than split, because splitting is exactly where shell
 * metacharacters would sneak back in. Requiring an array makes the file unable to express
 * anything a shell would reinterpret.
 */
function readCommand(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') {
    throw new ProjectConfigError('command must be an array of arguments, not a string');
  }
  if (!Array.isArray(value)) throw new ProjectConfigError('command must be an array');
  if (value.length === 0) return [];
  if (value.length > 32) throw new ProjectConfigError('command has too many arguments');

  const argv = value.map((v) => {
    if (typeof v !== 'string') throw new ProjectConfigError('command arguments must be strings');
    if (v.length > 2000) throw new ProjectConfigError('command argument is too long');
    if (v.includes('\0')) throw new ProjectConfigError('command argument contains a null byte');
    return v;
  });
  return argv;
}

/**
 * Which declared command belongs to a pane.
 *
 * The parser numbers panes `p1..pN` in the same depth-first order it collects commands, so the
 * mapping is positional and needs no side table. Anything unrecognized gets no command rather
 * than someone else's.
 */
export function templateCommandIndex(paneId: string): number {
  const n = /^p(\d+)$/.exec(paneId);
  return n?.[1] ? Number(n[1]) - 1 : -1;
}

/** The pane a subtree occupies first, which is the one an in-place split leaves in position. */
export function leftmostTemplatePane(node: LayoutNode): string {
  return node.type === 'terminal' ? node.paneId : leftmostTemplatePane(node.children[0]);
}
