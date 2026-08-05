#!/usr/bin/env node
// Install or remove TabTerm's agent CLI hooks.
//
// Opt in, additive, idempotent, and reversible. It adds only its own entries and leaves
// everything else byte identical, because editing someone's agent configuration without asking
// is not acceptable and silently rewriting unrelated settings is worse.
// See docs/09-agent-integration.md §3.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MARKER = 'tabterm-agent-hook';
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT = join(homedir(), '.local', 'libexec', 'tabterm', 'agent-hook.sh');
const HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
];

const remove = process.argv.includes('--remove');

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    console.error(`Could not parse ${SETTINGS}, refusing to touch it.`);
    console.error(String(e));
    process.exit(1);
  }
}

/** Ours are the only entries carrying the marker, so removal is exact. */
const isOurs = (entry) => JSON.stringify(entry).includes(MARKER);

const settings = readSettings();
settings.hooks ??= {};

if (existsSync(SETTINGS)) {
  // A backup, once, before the first modification. Cheap insurance on a file we did not write.
  const backup = `${SETTINGS}.tabterm-backup`;
  if (!existsSync(backup)) copyFileSync(SETTINGS, backup);
}

let changed = 0;
for (const hook of HOOKS) {
  const existing = Array.isArray(settings.hooks[hook]) ? settings.hooks[hook] : [];
  const withoutOurs = existing.filter((e) => !isOurs(e));

  if (remove) {
    if (withoutOurs.length !== existing.length) changed++;
    if (withoutOurs.length === 0) delete settings.hooks[hook];
    else settings.hooks[hook] = withoutOurs;
    continue;
  }

  withoutOurs.push({
    matcher: '',
    hooks: [{ type: 'command', command: `${HOOK_SCRIPT} ${hook} # ${MARKER}` }],
  });
  settings.hooks[hook] = withoutOurs;
  changed++;
}

if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

mkdirSync(dirname(SETTINGS), { recursive: true });
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

console.log(
  remove
    ? `Removed TabTerm hooks from ${SETTINGS} (${String(changed)} changed).`
    : `Installed ${String(changed)} TabTerm hooks into ${SETTINGS}.`,
);
