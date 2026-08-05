import { readdir, realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { paths } from './config.js';
import { info, warn } from './log.js';
import type { PluginHost, TabTermPlugin } from './plugin-api.js';

/**
 * Loading plugins from `~/.config/tabterm/plugins/`.
 *
 * **That directory is trusted; a project directory never is.** The asymmetry is the whole
 * model: you put a file in your own config directory deliberately, and a cloned repository
 * arrives without you reading it. Project-local configuration stays declarative JSON with no
 * executable entry point at all, and `daemon/src/project-config.ts` refuses one outright rather
 * than prompting. See docs/05-security.md §5.
 *
 * Nothing here makes a project plugin possible. There is no path from a repository to this
 * loader, and that is deliberate rather than incidental.
 */

/** Only top-level `.mjs` files. No nesting, no `node_modules`, no surprises. */
const PLUGIN_PATTERN = /^[\w.-]+\.mjs$/;

export interface LoadResult {
  loaded: string[];
  rejected: { file: string; reason: string }[];
}

export async function loadPlugins(host: PluginHost, directory?: string): Promise<LoadResult> {
  const dir = directory ?? join(paths.config, 'plugins');
  const result: LoadResult = { loaded: [], rejected: [] };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No plugins directory is the normal case, not a problem worth reporting.
    return result;
  }

  // Resolved once so a symlink out of the directory can be recognised. A plugin directory is
  // trusted; a symlink pointing somewhere else was not necessarily put there deliberately.
  const root = await realpath(dir).catch(() => dir);

  for (const entry of entries.sort()) {
    if (!PLUGIN_PATTERN.test(entry)) continue;
    const file = join(dir, entry);

    try {
      const info_ = await stat(file);
      if (!info_.isFile()) {
        result.rejected.push({ file: entry, reason: 'not a file' });
        continue;
      }
      const real = await realpath(file);
      if (!real.startsWith(`${root}/`)) {
        result.rejected.push({ file: entry, reason: 'symlink leaves the plugins directory' });
        continue;
      }

      const module: unknown = await import(pathToFileURL(real).href);
      const plugin = extractPlugin(module);
      if (!plugin) {
        result.rejected.push({ file: entry, reason: 'no default export with a manifest' });
        continue;
      }

      const registered = host.register(plugin);
      if (registered.ok) {
        result.loaded.push(plugin.manifest.id);
      } else {
        result.rejected.push({ file: entry, reason: registered.reason });
      }
    } catch (e) {
      // A plugin that fails to load must not stop the daemon starting. One missing feature is
      // recoverable; a daemon that will not boot because of a file in a config directory is not.
      result.rejected.push({
        file: entry,
        reason: String((e as Error).message ?? e).slice(0, 200),
      });
    }
  }

  if (result.loaded.length > 0) info('plugins.loaded', { plugins: result.loaded });
  for (const rejection of result.rejected) warn('plugins.rejected', rejection);
  return result;
}

/** Shape-checked rather than trusted: a default export could be anything. */
function extractPlugin(module: unknown): TabTermPlugin | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = (module as { default?: unknown }).default;
  if (typeof candidate !== 'object' || candidate === null) return null;

  const manifest = (candidate as { manifest?: unknown }).manifest;
  if (typeof manifest !== 'object' || manifest === null) return null;

  const { id, name, capabilities } = manifest as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(capabilities)) {
    return null;
  }
  if (!capabilities.every((c) => typeof c === 'string')) return null;

  return candidate as TabTermPlugin;
}
