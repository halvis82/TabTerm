import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

/**
 * The macOS Choose a Folder window, opened at a folder, for Command Shift G in a folder box.
 *
 * A page cannot open one and learn the path that was chosen: Chrome reports a picked folder as a
 * handle or as paths relative to it, never as where it is. The daemon is an ordinary program on
 * the Mac and can, through `choose folder`, which is the standard window with Go to Folder,
 * favorites and iCloud in it. It opens in front of Chrome, at the folder the box points to, or
 * the nearest one above it that exists.
 *
 * Resolves to the chosen folder, or `null` when the window was cancelled or could not open.
 */
export function chooseFolder(from: string): Promise<string | null> {
  // A test daemon, in a home of its own, answers for itself rather than opening a window.
  const forced = process.env['TABTERM_HOME'] ? process.env['TABTERM_CHOOSE_FOLDER'] : undefined;
  if (forced !== undefined) return Promise.resolve(forced === 'cancel' ? null : forced);
  const start = existingFolder(from);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv',
        '-e',
        // In front of Chrome, which is where the person pressing the keys is looking.
        'tell me to activate',
        '-e',
        'return POSIX path of (choose folder with prompt "Choose a folder for TabTerm" default location (POSIX file (item 1 of argv)))',
        '-e',
        'end run',
        start,
      ],
      { timeout: 10 * 60_000 },
      (error, stdout) => {
        const chosen = stdout.trim().replace(/\/+$/, '') || '/';
        resolve(error || !isAbsolute(chosen) ? null : chosen);
      },
    );
  });
}

/** The folder asked for if it exists, or the nearest one above it that does. */
function existingFolder(path: string): string {
  let at = isAbsolute(path) ? path : homedir();
  for (let i = 0; i < 64; i += 1) {
    try {
      if (existsSync(at) && statSync(at).isDirectory()) return at;
    } catch {
      // Unreadable: keep walking up.
    }
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return homedir();
}
