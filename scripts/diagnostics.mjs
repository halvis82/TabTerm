#!/usr/bin/env node
// Produce a diagnostic bundle that is safe to send to someone else.
//
// The default is redacted, and the redaction is the point: a bundle nobody dares share is a
// bundle nobody sends. Everything included is either a fact about the installation or a log
// line that has already been through the daemon's own redaction, and this pass runs over it
// again rather than trusting that.
//
// Nothing from a terminal is ever included. No scrollback, no command text, no environment.
//
//   node scripts/diagnostics.mjs              -> ~/Desktop/tabterm-diagnostics-<stamp>.txt
//   node scripts/diagnostics.mjs --stdout     -> print instead of writing
//   node scripts/diagnostics.mjs --raw        -> skip redaction. Deliberate, and warned about.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, release, arch } from 'node:os';
import { join } from 'node:path';

const STATE = join(homedir(), '.local', 'state', 'tabterm');
const LOGS = join(STATE, 'logs');
const HOME = homedir();

const args = new Set(process.argv.slice(2));
const redact = !args.has('--raw');
const toStdout = args.has('--stdout');

/**
 * Redaction lives in `daemon/src/redact.ts` and is tested there.
 *
 * One implementation, not two. A second copy in a script is exactly how "we redact secrets"
 * quietly stops being true. The built module is preferred; the fallback below exists so a
 * bundle can still be produced from a checkout that has not been built, and it says so.
 */
let redactFn = null;
for (const candidate of ['../daemon/dist/redact.js', '../redact.js']) {
  try {
    ({ redact: redactFn } = await import(new URL(candidate, import.meta.url).href));
    break;
  } catch {
    // The second path is for a staged install, where the script sits beside the daemon.
  }
}

const context = { home: HOME, hostname: hostname() };

function clean(text) {
  if (!redact) return text;
  if (!redactFn) {
    // Refusing is the only safe answer. Producing a bundle that claims to be redacted while
    // silently not being redacted would be worse than producing none.
    process.stderr.write(
      'Cannot load the redaction module. Run `npm run build`, or pass --raw deliberately.\n',
    );
    process.exit(2);
  }
  return redactFn(text, context);
}

function run(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, { encoding: 'utf8', timeout: 8000 }).trim();
  } catch (e) {
    return `(failed: ${String(e.message ?? e).slice(0, 200)})`;
  }
}

const sections = [];
const add = (title, body) => sections.push(`===== ${title} =====\n${body}\n`);

add(
  'environment',
  [
    `generated     ${new Date().toISOString()}`,
    `redacted      ${String(redact)}`,
    `macos         ${release()} ${arch()}`,
    `node          ${process.version}`,
    `chrome        ${run('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version'])}`,
  ].join('\n'),
);

add('doctor', run('/bin/bash', [join(import.meta.dirname, 'doctor.sh')]));
add('health probe', run(process.execPath, [join(import.meta.dirname, 'health-probe.mjs')]));

// File listings, not contents. Sizes and permissions answer most installation questions and
// disclose nothing about what anyone ran.
add(
  'state directory',
  (() => {
    try {
      return readdirSync(STATE)
        .map((name) => {
          const info = statSync(join(STATE, name));
          const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
          return `${mode}  ${String(info.size).padStart(10)}  ${name}`;
        })
        .join('\n');
    } catch (e) {
      return `(unreadable: ${String(e.message ?? e)})`;
    }
  })(),
);

/**
 * Log tails.
 *
 * The daemon already drops command text and environment values, per docs/05-security.md §9.
 * This re-redacts anyway: a diagnostic bundle is the one artifact that leaves the machine, and
 * trusting an upstream guarantee is not worth the one time it is wrong.
 */
add(
  'logs (last 200 lines each)',
  (() => {
    try {
      return readdirSync(LOGS)
        .filter((name) => name.endsWith('.log'))
        .map((name) => {
          const body = readFileSync(join(LOGS, name), 'utf8').split('\n').slice(-200).join('\n');
          return `--- ${name} ---\n${body}`;
        })
        .join('\n\n');
    } catch (e) {
      return `(no logs: ${String(e.message ?? e)})`;
    }
  })(),
);

const bundle = clean(sections.join('\n'));

if (toStdout) {
  process.stdout.write(`${bundle}\n`);
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(HOME, 'Desktop', `tabterm-diagnostics-${stamp}.txt`);
  writeFileSync(target, bundle, { mode: 0o600 });
  process.stdout.write(`Wrote ${target}\n`);
  if (!redact) {
    process.stdout.write('WARNING: --raw was given. This bundle is NOT redacted.\n');
  } else {
    process.stdout.write('Redacted: paths, hostname, emails, tokens and long hex strings.\n');
    process.stdout.write('It contains no scrollback, command text, or environment values.\n');
  }
}
