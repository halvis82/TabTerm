import { describe, expect, it } from 'vitest';
import type { AgentHookTarget, AgentHooksStatus } from '@tabterm/shared';
import { describeHooks } from './settings-view.js';

const claude = (over: Partial<AgentHookTarget> = {}): AgentHookTarget => ({
  id: 'claude-code',
  name: 'Claude Code',
  settingsPath: '/Users/someone/.claude/settings.json',
  supported: true,
  detected: true,
  installed: true,
  command: 'claude',
  install: 'npm i -g @anthropic-ai/claude-code',
  ...over,
});

const status = (targets: AgentHookTarget[], over: Partial<AgentHooksStatus> = {}) => ({
  installed: targets.some((t) => t.installed),
  targets,
  ...over,
});

/**
 * This panel is read by somebody who has just installed TabTerm and may have no agent CLI at all.
 *
 * It used to claim hooks were installed for Claude Code on the strength of a directory in the
 * home folder, which survives uninstalling the tool. Claiming something is set up for a tool
 * somebody does not have is worse than saying nothing.
 */
describe('what the agent hooks panel says', () => {
  it('says where the hooks live, because they live in the agent settings and not in ours', () => {
    const sentence = describeHooks(status([claude()], { lastEventAt: Date.now() }));
    expect(sentence).toContain('Claude Code');
    expect(sentence).toContain('~/.claude/settings.json');
    expect(sentence).toContain('last event');
  });

  it('offers a way to get one when nothing is there', () => {
    const sentence = describeHooks(status([claude({ detected: false, installed: false })]));
    expect(sentence).toContain('No agent CLI found');
    expect(sentence).toContain('npm i -g @anthropic-ai/claude-code');
    expect(sentence).not.toContain('Installed');
  });

  it('separates installed from working, since hooks that never fire is the failure worth seeing', () => {
    const sentence = describeHooks(status([claude()]));
    expect(sentence).toContain('no events yet');
  });

  it('names a tool it found but cannot support yet, rather than staying silent about it', () => {
    const codex = claude({ id: 'codex', name: 'Codex', supported: false, command: 'codex' });
    const sentence = describeHooks(status([claude(), codex], { lastEventAt: Date.now() }));
    expect(sentence).toContain('Codex not supported yet');
  });
});
