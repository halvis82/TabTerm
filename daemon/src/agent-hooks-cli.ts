import { agentHooksStatus, setAgentHooks } from './agent-hooks.js';

/**
 * `agent-hooks <install|remove|status>` from the command line.
 *
 * The same code the settings switch calls, reachable without a browser so the installer,
 * the uninstaller and `doctor` can use it. Two implementations of "edit somebody's agent
 * settings" would be one too many. See docs/09-agent-integration.md.
 */
const action = process.argv[2] ?? 'status';
const status =
  action === 'install'
    ? setAgentHooks(true)
    : action === 'remove'
      ? setAgentHooks(false)
      : agentHooksStatus();

for (const target of status.targets) {
  const state = !target.supported
    ? 'not supported yet'
    : !target.detected
      ? 'not present on this machine'
      : target.installed
        ? 'hooks installed'
        : 'hooks not installed';
  console.log(`  ${target.name}: ${state}`);
}

if (!status.installed && action !== 'remove') {
  console.log('');
  console.log('  Agent turn notifications need these. Turn them on in TabTerm settings,');
  console.log('  or run: node scripts/install-agent-hooks.mjs');
}
