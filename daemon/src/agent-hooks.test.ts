import { describe, expect, it } from 'vitest';
import { hooksPresent, withHooks, withoutHooks } from './agent-hooks.js';

describe('agent hook installation', () => {
  it('leaves unrelated settings byte identical', () => {
    const before = { model: 'opus', env: { FOO: '1' }, permissions: { allow: ['Bash'] } };
    const after = { ...withHooks(before) };
    delete after['hooks'];
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('is idempotent', () => {
    const once = withHooks({});
    const twice = withHooks(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('keeps somebody else s hooks on the same event', () => {
    const theirs = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/bin/say done' }] }],
      },
    };
    const after = withHooks(theirs);
    const stop = (after['hooks'] as Record<string, unknown[]>)['Stop'] ?? [];
    expect(stop).toHaveLength(2);
    expect(JSON.stringify(stop[0])).toContain('/usr/bin/say done');
  });

  it('removes exactly what it added', () => {
    const before = {
      model: 'opus',
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/bin/say done' }] }],
      },
    };
    const after = withoutHooks(withHooks(before));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('drops the hooks key entirely when nothing else lives there', () => {
    expect(withoutHooks(withHooks({ model: 'opus' }))).toEqual({ model: 'opus' });
  });

  it('reports a partial install as not installed', () => {
    const full = withHooks({});
    expect(hooksPresent(full)).toBe(true);
    delete (full['hooks'] as Record<string, unknown>)['Stop'];
    // Stop is what ends a turn. Without it a turn never completes and nothing ever notifies,
    // which must not read as installed.
    expect(hooksPresent(full)).toBe(false);
  });

  it('recognises nothing in an empty settings file', () => {
    expect(hooksPresent({})).toBe(false);
  });

  it('binds a turn with the pair that measures it', () => {
    const hooks = withHooks({})['hooks'] as Record<string, unknown>;
    expect(Object.keys(hooks)).toContain('UserPromptSubmit');
    expect(Object.keys(hooks)).toContain('Stop');
  });
});
