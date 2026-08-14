import { describe, expect, it } from 'vitest';
import { panesFor, parseTemplates } from './templates.js';

describe('how many commands a template needs', () => {
  it('matches the shape it was saved with', () => {
    expect(panesFor('single')).toBe(1);
    expect(panesFor('columns')).toBe(2);
    expect(panesFor('one-plus-two')).toBe(3);
    expect(panesFor('quad')).toBe(4);
  });
});

describe('reading saved templates', () => {
  it('keeps a complete one', () => {
    const out = parseTemplates([
      { id: 'a', name: 'Work', path: '~/p', shape: 'quad', panes: 4, commands: ['claude', ''] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.commands).toEqual(['claude', '']);
  });

  it('drops an entry missing what identifies it, and keeps the rest', () => {
    // One bad row must not cost somebody every template they have saved.
    const out = parseTemplates([{ name: 'no id' }, { id: 'b', name: 'ok', path: '~' }]);
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('fills in a pane count from the shape when it is missing', () => {
    expect(
      parseTemplates([{ id: 'c', name: 'x', path: '~', shape: 'one-plus-two' }])[0]?.panes,
    ).toBe(3);
  });

  it('survives storage holding something that is not a list', () => {
    expect(parseTemplates(undefined)).toEqual([]);
    expect(parseTemplates('nonsense')).toEqual([]);
    expect(parseTemplates([null, 3, 'x'])).toEqual([]);
  });

  it('coerces commands to strings rather than trusting them', () => {
    const out = parseTemplates([{ id: 'd', name: 'x', path: '~', commands: [1, null] }]);
    expect(out[0]?.commands).toEqual(['1', 'null']);
  });
});
