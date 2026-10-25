import { describe, expect, it } from 'vitest';
import type { LayoutNode, Workspace } from '@tabterm/shared';
import { remoteTabs, type TabSession } from './tabs.js';

const term = (sessionId: string, label?: string): LayoutNode => ({
  type: 'terminal',
  paneId: `p-${sessionId}`,
  sessionId,
  ...(label ? { label } : {}),
});
const ws = (id: string, layout: LayoutNode, title?: string): Workspace => ({
  id,
  layout,
  pinned: true,
  createdAt: 0,
  updatedAt: 0,
  ...(title ? { title } : {}),
});
const s = (id: string, extra: Partial<TabSession> = {}): TabSession => ({
  id,
  state: 'attached',
  pid: 10,
  cwd: `/Users/x/${id}`,
  commandRunning: false,
  ...extra,
});

describe('the tabs a remote browser sees', () => {
  it('mirrors the tabs, names first, then what is running, then the folder', () => {
    const split: LayoutNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [term('a', 'server'), term('b')],
    };
    const tabs = remoteTabs(
      [s('a'), s('b', { process: 'claude', agentState: 'approval' })],
      [ws('w', split)],
      () => true,
    );
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.title).toBe('2 terminals in a');
    expect(tabs[0]?.panes.map((p) => [p.title, p.needsYou])).toEqual([
      ['server', false],
      ['claude', true],
    ]);
  });

  it('lists what runs without a tab after the tabs, and leaves out what has ended', () => {
    const tabs = remoteTabs(
      [s('a'), s('b'), s('c', { state: 'exited' })],
      [ws('w', term('a')), ws('w2', term('b'))],
      (id) => id === 'a',
    );
    expect(tabs.map((t) => t.title)).toEqual(['a', 'Running without a tab']);
    expect(tabs[1]?.panes.map((p) => p.sessionId)).toEqual(['b']);
  });

  it('uses a tab title somebody set', () => {
    const tabs = remoteTabs([s('a')], [ws('w', term('a'), 'Deploy')], () => true);
    expect(tabs[0]?.title).toBe('Deploy');
  });
});
