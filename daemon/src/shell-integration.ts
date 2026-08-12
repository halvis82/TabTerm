import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ShellIntegrationStatus } from '@tabterm/shared';
import { info, warn } from './log.js';

/**
 * Sourcing the shell integration, offered rather than assumed.
 *
 * Without it there are no exit codes, because the operating system reports nothing about a
 * process that has already gone. That is not a cosmetic gap: it is the difference between a tab
 * that can say a command failed and one that can only say it ended. See
 * docs/08-shell-integration.md.
 *
 * The line has always been printed at the end of the install for the user to paste, and the
 * result is the same as it was for the agent hooks: it does not get pasted, and then half the
 * status system is inert for reasons nothing on screen explains. So it is a switch, taken on an
 * explicit action, never as a side effect of installing.
 *
 * `.zshrc` is somebody's own file and a bad line in it breaks every shell they open, so this is
 * more careful than it looks: one guarded line, a marker for exact removal, a backup before the
 * first change, and idempotent.
 */

const MARKER = '# tabterm-shell-integration';
const SCRIPT = join(homedir(), '.local', 'share', 'tabterm', 'tabterm-integration.zsh');

/**
 * Guarded, so a shell still starts if TabTerm is uninstalled from under it.
 *
 * This is the one property that matters most. An unguarded source line for a file that no longer
 * exists prints an error on every prompt, in every terminal, forever.
 */
const LINE = `[ -f "${SCRIPT}" ] && source "${SCRIPT}" ${MARKER}`;

/**
 * `sourcedElsewhere` covers someone who pasted the line themselves or sources it from another
 * file. They must not be told it is missing, and must not have a second copy added.
 */
export type { ShellIntegrationStatus };

function profilePath(): string {
  return join(homedir(), '.zshrc');
}

export function shellIntegrationStatus(active = false): ShellIntegrationStatus {
  const path = profilePath();
  let text = '';
  try {
    text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    text = '';
  }
  const installed = text.includes(MARKER);
  return {
    installed,
    scriptStaged: existsSync(SCRIPT),
    profilePath: path,
    // Reported by a live session emitting the marks, which is the only proof that beats reading
    // the file: it says the integration is working, not merely that a line exists.
    sourcedElsewhere: !installed && (active || text.includes('tabterm-integration.zsh')),
  };
}

export function setShellIntegration(enabled: boolean, active = false): ShellIntegrationStatus {
  const path = profilePath();
  let text = '';
  try {
    text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch (e: unknown) {
    warn('shell-integration.unreadable', { error: String(e) });
    return shellIntegrationStatus(active);
  }

  const already = text.includes(MARKER);
  if (enabled === already) return shellIntegrationStatus(active);

  try {
    if (existsSync(path)) {
      const backup = `${path}.tabterm-backup`;
      if (!existsSync(backup)) copyFileSync(path, backup);
    }
    const next = enabled
      ? `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${LINE}\n`
      : // Only lines carrying the marker, so a line somebody wrote themselves is left alone.
        text
          .split('\n')
          .filter((line) => !line.includes(MARKER))
          .join('\n');
    writeFileSync(path, next, { mode: 0o644 });
    info('shell-integration.changed', { enabled });
  } catch (e: unknown) {
    warn('shell-integration.write-failed', { error: String(e) });
  }
  return shellIntegrationStatus(active);
}
