import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginHost } from './plugin-api.js';
import { loadPlugins } from './plugin-loader.js';

const dir = async () => mkdtemp(join(tmpdir(), 'tabterm-plugins-'));

const GOOD = `export default {
  manifest: { id: 'greeter', name: 'Greeter', capabilities: ['contribute-launcher'] },
  launcherItems: () => [{ id: 'hello', title: 'Say hello', insert: 'echo hello' }],
};
`;

describe('loading plugins from the trusted directory', () => {
  it('loads a well-formed plugin', async () => {
    const d = await dir();
    await writeFile(join(d, 'greeter.mjs'), GOOD);
    const host = new PluginHost();
    const result = await loadPlugins(host, d);
    expect(result.loaded).toEqual(['greeter']);
    expect(host.launcher({})[0]?.title).toBe('Say hello');
  });

  it('reports nothing when there is no plugins directory', async () => {
    const host = new PluginHost();
    const result = await loadPlugins(host, '/definitely/not/here');
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('ignores files that are not plugins', async () => {
    const d = await dir();
    await writeFile(join(d, 'README.md'), '# notes');
    await writeFile(join(d, 'helper.ts'), 'export {}');
    await mkdir(join(d, 'node_modules'));
    const result = await loadPlugins(new PluginHost(), d);
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a module with no usable default export', async () => {
    const d = await dir();
    await writeFile(join(d, 'empty.mjs'), 'export const nothing = 1;');
    await writeFile(join(d, 'wrong.mjs'), 'export default { manifest: { id: 5 } };');
    const result = await loadPlugins(new PluginHost(), d);
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });

  it('does not stop the daemon when a plugin throws while loading', async () => {
    // One missing feature is recoverable. A daemon that will not boot because of a file in a
    // config directory is not.
    const d = await dir();
    await writeFile(join(d, 'broken.mjs'), 'throw new Error("bad at import time");');
    await writeFile(join(d, 'fine.mjs'), GOOD);
    const result = await loadPlugins(new PluginHost(), d);
    expect(result.loaded).toEqual(['greeter']);
    expect(result.rejected[0]?.file).toBe('broken.mjs');
  });

  it('refuses a symlink that points outside the plugins directory', async () => {
    // The directory is trusted because you put things in it deliberately. A symlink into it
    // was not necessarily put there by you.
    const d = await dir();
    const elsewhere = await dir();
    await writeFile(join(elsewhere, 'outside.mjs'), GOOD);
    await symlink(join(elsewhere, 'outside.mjs'), join(d, 'linked.mjs'));

    const result = await loadPlugins(new PluginHost(), d);
    expect(result.loaded).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('symlink');
  });

  it('rejects a duplicate id rather than loading it twice', async () => {
    const d = await dir();
    await writeFile(join(d, 'one.mjs'), GOOD);
    await writeFile(join(d, 'two.mjs'), GOOD);
    const result = await loadPlugins(new PluginHost(), d);
    expect(result.loaded).toEqual(['greeter']);
    expect(result.rejected[0]?.reason).toContain('duplicate');
  });

  it('rejects a plugin asking for a capability that does not exist', async () => {
    const d = await dir();
    await writeFile(
      join(d, 'greedy.mjs'),
      `export default { manifest: { id: 'greedy', name: 'g', capabilities: ['read-everything'] } };`,
    );
    const result = await loadPlugins(new PluginHost(), d);
    expect(result.loaded).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('unknown capability');
  });
});
