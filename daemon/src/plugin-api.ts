/**
 * The plugin API.
 *
 * Extracted from seams that proved themselves rather than designed up front, per ADR-0013. The
 * four hooks below are not a guess at what someone might want; each one is the shape of a
 * feature already written as core code:
 *
 * | Hook | Extracted from |
 * |---|---|
 * | `decorateText` | clickable paths (`extension/src/terminal/path-links.ts`) |
 * | `paneStatus` | per-pane status and the tab favicon (`pane-status.ts`) |
 * | `launcherItems` | project templates, agent resume, the server dashboard |
 * | `onSessionEvent` | the agent hook bridge (`agent-bridge.ts`) |
 *
 * **Plugins run in the daemon, not in the page.** Not a preference: Chrome's MV3 forbids
 * executing code that did not ship inside the extension package, so a plugin cannot run in a
 * terminal tab at all. See docs/10-limitations.md. That constraint turns out to enforce half
 * the security model for free — a daemon-side plugin has no access to Chrome tabs, the
 * WebSocket, or the renderer, because those do not exist in its process.
 *
 * What is left to enforce here is the rest: no PTY, no database, no session mutation. Plugins
 * receive **plain data and return plain data**. They are never handed an object with a method
 * that changes anything.
 */

/** What a plugin may ask for. Anything not granted is simply absent from its context. */
export type Capability =
  'read-command-text' | 'read-cwd' | 'read-output' | 'contribute-status' | 'contribute-launcher';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'read-command-text',
  'read-cwd',
  'read-output',
  'contribute-status',
  'contribute-launcher',
];

export interface PluginManifest {
  id: string;
  name: string;
  /** Requested up front, so what a plugin can see is visible without reading its code. */
  capabilities: readonly Capability[];
}

/** A span a plugin wants to make actionable, from the clickable-paths seam. */
export interface Decoration {
  start: number;
  length: number;
  kind: 'link' | 'path' | 'note';
  /** Shown on hover. Never rendered as markup. */
  title: string;
  /** Passed back verbatim if the user activates it. */
  payload?: string;
}

/** From the pane-status seam. Priority ordering stays the host's decision, not the plugin's. */
export interface StatusContribution {
  state: 'idle' | 'running' | 'waiting' | 'failed' | 'approval';
  detail?: string;
}

/** From the launcher seam. */
export interface LauncherItem {
  id: string;
  title: string;
  subtitle?: string;
  /** Staged at the prompt when chosen. Never run, exactly like everything else. */
  insert?: string;
}

/** What a plugin is told about a session. Only fields its capabilities allow are present. */
export interface SessionContext {
  sessionId: string;
  cwd?: string;
  command?: string;
  exitCode?: number;
}

export interface SessionEvent {
  type: 'command-start' | 'command-end' | 'cwd-change';
  session: SessionContext;
}

export interface TabTermPlugin {
  manifest: PluginManifest;
  decorateText?: (line: string, session: SessionContext) => Decoration[] | undefined;
  paneStatus?: (session: SessionContext) => StatusContribution | null | undefined;
  launcherItems?: (context: { cwd?: string }) => LauncherItem[] | undefined;
  onSessionEvent?: (event: SessionEvent) => void;
}

/** Bounds, so one bad plugin cannot make the product unusable. */
const MAX_DECORATIONS = 64;
const MAX_LAUNCHER_ITEMS = 12;
const MAX_TITLE = 200;

export interface PluginFailure {
  pluginId: string;
  hook: string;
  message: string;
}

/**
 * Runs plugins and refuses to let them break anything.
 *
 * Every call is wrapped. A plugin that throws is disabled rather than allowed to throw again on
 * the next keystroke, because the failure mode of a hook on a hot path is not one error, it is
 * one error per line of output forever.
 */
export class PluginHost {
  readonly #plugins: TabTermPlugin[] = [];
  readonly #disabled = new Map<string, string>();
  readonly #failures: PluginFailure[] = [];

  register(plugin: TabTermPlugin): { ok: true } | { ok: false; reason: string } {
    const { manifest } = plugin;
    if (!manifest.id || !/^[\w.-]{1,64}$/.test(manifest.id)) {
      return { ok: false, reason: 'a plugin needs a simple id' };
    }
    if (this.#plugins.some((p) => p.manifest.id === manifest.id)) {
      return { ok: false, reason: `duplicate plugin id ${manifest.id}` };
    }
    const unknown = manifest.capabilities.filter((c) => !ALL_CAPABILITIES.includes(c));
    if (unknown.length > 0) {
      // Refused rather than ignored. A plugin asking for something that does not exist is
      // either out of date or wrong about what it does, and both deserve to be visible.
      return { ok: false, reason: `unknown capability: ${unknown.join(', ')}` };
    }
    this.#plugins.push(plugin);
    return { ok: true };
  }

  get plugins(): readonly PluginManifest[] {
    return this.#plugins.filter((p) => !this.#disabled.has(p.manifest.id)).map((p) => p.manifest);
  }

  get failures(): readonly PluginFailure[] {
    return this.#failures;
  }

  /**
   * The context a plugin is given, filtered to what it may see.
   *
   * Filtering happens here rather than in the plugin, obviously, but also rather than at the
   * call site: one place to get it right means one place to check.
   */
  #contextFor(plugin: TabTermPlugin, session: SessionContext): SessionContext {
    const caps = new Set(plugin.manifest.capabilities);
    return {
      sessionId: session.sessionId,
      ...(caps.has('read-cwd') && session.cwd !== undefined ? { cwd: session.cwd } : {}),
      ...(caps.has('read-command-text') && session.command !== undefined
        ? { command: session.command }
        : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    };
  }

  #run<T>(plugin: TabTermPlugin, hook: string, fn: () => T): T | undefined {
    if (this.#disabled.has(plugin.manifest.id)) return undefined;
    try {
      return fn();
    } catch (e) {
      const message = String((e as Error).message ?? e).slice(0, 300);
      // Disabled on first throw. A hook on a hot path that fails once will fail on every line
      // of output, and a log full of the same error is worse than a missing feature.
      this.#disabled.set(plugin.manifest.id, message);
      this.#failures.push({ pluginId: plugin.manifest.id, hook, message });
      return undefined;
    }
  }

  decorate(line: string, session: SessionContext): Decoration[] {
    const out: Decoration[] = [];
    for (const plugin of this.#plugins) {
      if (!plugin.decorateText || !plugin.manifest.capabilities.includes('read-output')) continue;
      const result = this.#run(plugin, 'decorateText', () =>
        plugin.decorateText?.(line, this.#contextFor(plugin, session)),
      );
      for (const decoration of result ?? []) {
        // A span outside the line would land on someone else's text, so it is dropped rather
        // than clamped: a decoration in the wrong place is worse than none.
        if (
          !Number.isInteger(decoration.start) ||
          !Number.isInteger(decoration.length) ||
          decoration.start < 0 ||
          decoration.length <= 0 ||
          decoration.start + decoration.length > line.length
        ) {
          continue;
        }
        out.push({ ...decoration, title: String(decoration.title).slice(0, MAX_TITLE) });
        if (out.length >= MAX_DECORATIONS) return out;
      }
    }
    return out;
  }

  status(session: SessionContext): StatusContribution | null {
    // The most severe contribution wins, using the host's ordering. A plugin cannot promote
    // itself past another by returning something louder.
    const order: StatusContribution['state'][] = [
      'approval',
      'failed',
      'waiting',
      'running',
      'idle',
    ];
    let best: StatusContribution | null = null;
    for (const plugin of this.#plugins) {
      if (!plugin.paneStatus || !plugin.manifest.capabilities.includes('contribute-status')) {
        continue;
      }
      const result = this.#run(plugin, 'paneStatus', () =>
        plugin.paneStatus?.(this.#contextFor(plugin, session)),
      );
      if (!result || !order.includes(result.state)) continue;
      if (!best || order.indexOf(result.state) < order.indexOf(best.state)) {
        best = {
          state: result.state,
          ...(result.detail ? { detail: String(result.detail).slice(0, MAX_TITLE) } : {}),
        };
      }
    }
    return best;
  }

  launcher(context: { cwd?: string }): LauncherItem[] {
    const out: LauncherItem[] = [];
    for (const plugin of this.#plugins) {
      if (!plugin.launcherItems || !plugin.manifest.capabilities.includes('contribute-launcher')) {
        continue;
      }
      const caps = new Set(plugin.manifest.capabilities);
      const scoped = caps.has('read-cwd') ? context : {};
      const result = this.#run(plugin, 'launcherItems', () => plugin.launcherItems?.(scoped));
      for (const item of result ?? []) {
        if (!item.id || !item.title) continue;
        out.push({
          id: `${plugin.manifest.id}:${String(item.id)}`,
          title: String(item.title).slice(0, MAX_TITLE),
          ...(item.subtitle ? { subtitle: String(item.subtitle).slice(0, MAX_TITLE) } : {}),
          // Newlines removed for the same reason they are everywhere else: what is staged at a
          // prompt must not be able to become two commands.
          ...(item.insert
            ? {
                insert: String(item.insert)
                  .replace(/[\r\n]+/g, ' ')
                  .slice(0, 2000),
              }
            : {}),
        });
        if (out.length >= MAX_LAUNCHER_ITEMS) return out;
      }
    }
    return out;
  }

  notify(event: SessionEvent): void {
    for (const plugin of this.#plugins) {
      if (!plugin.onSessionEvent) continue;
      this.#run(plugin, 'onSessionEvent', () => {
        plugin.onSessionEvent?.({
          type: event.type,
          session: this.#contextFor(plugin, event.session),
        });
      });
    }
  }

  /** Why a plugin stopped running, for the diagnostics that would otherwise be a mystery. */
  disabledReason(pluginId: string): string | undefined {
    return this.#disabled.get(pluginId);
  }
}
