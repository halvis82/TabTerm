import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { info, warn } from '../log.js';

/** How long the person at the Mac has to answer. */
export const APPROVE_SECONDS = 90;

/**
 * Asks the person at this Mac whether a new device may in, with Touch ID or the login password.
 *
 * A pairing code shown on the screen is enough to start pairing, and a screen can be seen from
 * across a room or in a screen share. So a device is trusted only once somebody at this Mac says
 * yes, in a dialog macOS draws and no other program can click. The device shows the same short code
 * the dialog names, so a second device racing the first cannot be approved by mistake.
 *
 * The helper is built from native-host/approve-device.swift by the install script and lives beside
 * the daemon. Without it, as on a Mac with no Swift compiler, a plain dialog asks instead.
 */
export function approveOnThisMac(name: string, code: string): Promise<boolean> {
  // A test daemon, in a home of its own, answers for itself rather than asking the real person.
  const forced = process.env['TABTERM_HOME'] ? process.env['TABTERM_REMOTE_APPROVE'] : undefined;
  if (forced === 'allow' || forced === 'deny') return Promise.resolve(forced === 'allow');
  // Only what reads as a name: no control characters, and no quotes to break out of the sentence.
  const clean =
    [...name]
      .filter((ch) => ch >= ' ' && ch !== '\x7f' && !'"“”'.includes(ch))
      .join('')
      .slice(0, 60) || 'a device';
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'approve-device');
  return new Promise((resolve) => {
    if (existsSync(helper)) {
      execFile(
        helper,
        [
          `let “${clean}” use your terminals from anywhere. That device shows the code ${code}`,
          String(APPROVE_SECONDS),
        ],
        { timeout: (APPROVE_SECONDS + 10) * 1000 },
        (error) => {
          const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          info('remote.approve', { status });
          // Approved, refused or not answered. Anything else means it could not ask, so the plain
          // dialog asks instead, rather than turning a device away nobody was asked about.
          if (status === 0 || status === 1 || status === 2) resolve(status === 0);
          else resolve(askPlainly(clean, code));
        },
      );
      return;
    }
    resolve(askPlainly(clean, code));
  });
}

/** The same question without Touch ID: a dialog with Allow and Don't Allow. */
function askPlainly(name: string, code: string): Promise<boolean> {
  const text = `Let “${name}” use your terminals from anywhere?\n\nThat device shows the code ${code}. Allow only if it matches.`;
  const script = `display dialog ${JSON.stringify(text)} with title "TabTerm" buttons {"Don't Allow", "Allow"} default button "Don't Allow" giving up after ${APPROVE_SECONDS}`;
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], (error, stdout) => {
      if (error) warn('remote.approve.dialog', { message: error.message.slice(0, 80) });
      resolve(!error && /button returned:Allow/.test(stdout) && !/gave up:true/.test(stdout));
    });
  });
}
