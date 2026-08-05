import type { Config } from './config.js';

/**
 * Memory modes.
 *
 * One dial instead of six. The settings that actually govern memory — scrollback, how long a
 * detached session survives, how eagerly a renderer is released, how much archive is kept —
 * only make sense together, and asking someone to tune them individually is asking them to get
 * it wrong. See docs/11-performance.md.
 *
 * A mode is a *derivation*, not a stored copy: applying one rewrites the fields it owns and
 * leaves everything else alone, so a user's port, shell and editor survive a mode change.
 */

export type MemoryMode = 'low' | 'balanced' | 'full';

export interface MemorySettings {
  /** Lines of scrollback kept per session, server-side. 3.6 MB per session at 10000. */
  scrollbackLines: number;
  reapIdleShellSeconds: number;
  reapAgentOrEditorSeconds: number;
  reapDefaultSeconds: number;
  /** How long a hidden tab waits before releasing its WebGL context, milliseconds. */
  rendererUnloadMs: number;
  /**
   * Whether a hidden tab keeps updating its favicon.
   *
   * In `low` it does not: redrawing an icon nobody is looking at is pure cost. The favicon is
   * brought up to date when the tab is looked at again, so nothing is lost, only deferred.
   */
  faviconWhileHidden: boolean;
  /** Days of command history kept. Zero means forever. */
  historyRetentionDays: number;
}

/**
 * The three modes.
 *
 * `low` is for a machine under memory pressure and gives up durability first, because a
 * shorter grace period is annoying and a lost scrollback is not recoverable. `full` assumes
 * memory is available and keeps everything a person might scroll back to.
 */
export const MEMORY_MODES: Readonly<Record<MemoryMode, MemorySettings>> = {
  low: {
    scrollbackLines: 2_000,
    reapIdleShellSeconds: 60,
    reapAgentOrEditorSeconds: 300,
    reapDefaultSeconds: 120,
    rendererUnloadMs: 15_000,
    faviconWhileHidden: false,
    historyRetentionDays: 30,
  },
  balanced: {
    scrollbackLines: 10_000,
    reapIdleShellSeconds: 180,
    reapAgentOrEditorSeconds: 600,
    reapDefaultSeconds: 300,
    rendererUnloadMs: 120_000,
    faviconWhileHidden: true,
    historyRetentionDays: 180,
  },
  full: {
    scrollbackLines: 50_000,
    reapIdleShellSeconds: 600,
    reapAgentOrEditorSeconds: 3_600,
    reapDefaultSeconds: 1_800,
    rendererUnloadMs: 600_000,
    faviconWhileHidden: true,
    historyRetentionDays: 0,
  },
};

export function isMemoryMode(value: unknown): value is MemoryMode {
  return value === 'low' || value === 'balanced' || value === 'full';
}

/**
 * Apply a mode over a config.
 *
 * Only the fields a mode owns are rewritten. Everything else is carried through untouched,
 * which is what lets a mode be switched without a user losing settings they chose deliberately.
 */
export function applyMemoryMode(config: Config, mode: MemoryMode): Config {
  const settings = MEMORY_MODES[mode];
  return {
    ...config,
    memoryMode: mode,
    scrollbackLines: settings.scrollbackLines,
    reapIdleShellSeconds: settings.reapIdleShellSeconds,
    reapAgentOrEditorSeconds: settings.reapAgentOrEditorSeconds,
    reapDefaultSeconds: settings.reapDefaultSeconds,
  };
}

/** What the frontend needs, which is the part of a mode the daemon cannot enforce. */
export function frontendSettings(mode: MemoryMode): {
  rendererUnloadMs: number;
  faviconWhileHidden: boolean;
  scrollbackLines: number;
} {
  const settings = MEMORY_MODES[mode];
  return {
    rendererUnloadMs: settings.rendererUnloadMs,
    faviconWhileHidden: settings.faviconWhileHidden,
    scrollbackLines: settings.scrollbackLines,
  };
}
