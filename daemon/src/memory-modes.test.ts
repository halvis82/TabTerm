import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import {
  MEMORY_MODES,
  applyMemoryMode,
  frontendSettings,
  isMemoryMode,
  type MemoryMode,
} from './memory-modes.js';
import { decideReap } from './cleanup.js';

const MODES: MemoryMode[] = ['low', 'balanced', 'full'];

describe('memory modes', () => {
  it('orders every memory setting the same way across modes', () => {
    // The modes are only meaningful if each one is uniformly more or less generous. A mode that
    // was smaller in one dimension and larger in another would be a fourth mode, not a dial.
    for (const key of [
      'scrollbackLines',
      'reapIdleShellSeconds',
      'reapAgentOrEditorSeconds',
      'reapDefaultSeconds',
      'rendererUnloadMs',
    ] as const) {
      expect(MEMORY_MODES.low[key]).toBeLessThan(MEMORY_MODES.balanced[key]);
      expect(MEMORY_MODES.balanced[key]).toBeLessThan(MEMORY_MODES.full[key]);
    }
  });

  it('stops redrawing a hidden tab only in the lowest mode', () => {
    expect(MEMORY_MODES.low.faviconWhileHidden).toBe(false);
    expect(MEMORY_MODES.balanced.faviconWhileHidden).toBe(true);
    expect(MEMORY_MODES.full.faviconWhileHidden).toBe(true);
  });

  it('keeps history forever only in full', () => {
    expect(MEMORY_MODES.low.historyRetentionDays).toBeGreaterThan(0);
    expect(MEMORY_MODES.full.historyRetentionDays).toBe(0);
  });

  it('matches the shipped defaults, so the default install is balanced', () => {
    expect(DEFAULTS.memoryMode).toBe('balanced');
    expect(DEFAULTS.scrollbackLines).toBe(MEMORY_MODES.balanced.scrollbackLines);
    expect(DEFAULTS.reapIdleShellSeconds).toBe(MEMORY_MODES.balanced.reapIdleShellSeconds);
    expect(DEFAULTS.reapDefaultSeconds).toBe(MEMORY_MODES.balanced.reapDefaultSeconds);
  });
});

describe('applying a mode', () => {
  it('rewrites the fields it owns', () => {
    const applied = applyMemoryMode(DEFAULTS, 'low');
    expect(applied.scrollbackLines).toBe(MEMORY_MODES.low.scrollbackLines);
    expect(applied.memoryMode).toBe('low');
  });

  it('leaves settings the user chose alone', () => {
    // Switching mode must not silently reset a port, a shell, or an editor.
    const custom: Config = {
      ...DEFAULTS,
      port: 9999,
      shell: '/bin/bash',
      editor: 'helix',
      agentCommand: ['my-agent', '--flag'],
    };
    const applied = applyMemoryMode(custom, 'full');
    expect(applied.port).toBe(9999);
    expect(applied.shell).toBe('/bin/bash');
    expect(applied.editor).toBe('helix');
    expect(applied.agentCommand).toEqual(['my-agent', '--flag']);
  });

  it('round-trips, so switching away and back restores the same numbers', () => {
    const there = applyMemoryMode(DEFAULTS, 'low');
    const back = applyMemoryMode(there, 'balanced');
    expect(back.scrollbackLines).toBe(DEFAULTS.scrollbackLines);
    expect(back.reapIdleShellSeconds).toBe(DEFAULTS.reapIdleShellSeconds);
  });

  it('changes what the reap policy actually decides', () => {
    // The point of a mode is behavior, not a stored number. This is the behavior.
    const idle = {
      pinned: false,
      persistent: false,
      attachedClients: 0,
      hasOpenTab: false,
      inWorkspace: false,
      exited: false,
      hasExplicitCommand: false,
      neverUsed: false,
      keepBackgroundSeconds: null,
    };
    const low = decideReap(idle, applyMemoryMode(DEFAULTS, 'low')).afterSeconds;
    const full = decideReap(idle, applyMemoryMode(DEFAULTS, 'full')).afterSeconds;
    expect(low).toBe(MEMORY_MODES.low.reapIdleShellSeconds);
    expect(full).toBe(MEMORY_MODES.full.reapIdleShellSeconds);
    expect(low).toBeLessThan(full as number);
  });

  it('never makes a protected session reapable, whatever the mode', () => {
    for (const mode of MODES) {
      const config = applyMemoryMode(DEFAULTS, mode);
      const pinned = {
        pinned: true,
        persistent: false,
        attachedClients: 0,
        hasOpenTab: false,
        inWorkspace: false,
        exited: false,
        hasExplicitCommand: false,
        neverUsed: false,
        keepBackgroundSeconds: null,
      };
      expect(decideReap(pinned, config).afterSeconds).toBeNull();
    }
  });
});

describe('the frontend half of a mode', () => {
  it('reports what the daemon cannot enforce', () => {
    for (const mode of MODES) {
      const settings = frontendSettings(mode);
      expect(settings.rendererUnloadMs).toBe(MEMORY_MODES[mode].rendererUnloadMs);
      expect(settings.faviconWhileHidden).toBe(MEMORY_MODES[mode].faviconWhileHidden);
      expect(settings.scrollbackLines).toBe(MEMORY_MODES[mode].scrollbackLines);
    }
  });
});

describe('recognising a mode', () => {
  it('accepts the three modes and nothing else', () => {
    for (const mode of MODES) expect(isMemoryMode(mode)).toBe(true);
    for (const other of ['LOW', 'medium', '', null, undefined, 3, {}]) {
      expect(isMemoryMode(other)).toBe(false);
    }
  });
});
