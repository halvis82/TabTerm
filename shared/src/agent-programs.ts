/** Agent CLIs by name. Their output is an interface, not a transcript. */
export const AGENT_PROGRAMS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'aider',
  'cursor-agent',
  'gemini',
  'copilot',
]);

/** Runners that start the program named after them, which is then the one that matters. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'exec', 'command', 'nohup', 'time', 'sudo']);

/** Whether a command line starts an agent, looking past `VAR=value` and runners like `npx`. */
export function isAgentCommand(command: string): boolean {
  for (const word of command.trim().split(/\s+/)) {
    if (word === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const name = word.split('/').pop() ?? '';
    if (RUNNERS.has(name)) continue;
    return AGENT_PROGRAMS.has(name.replace(/@.*$/, ''));
  }
  return false;
}
