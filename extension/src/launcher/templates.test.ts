import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, alteredDefaults, withDefaultsRestored } from './templates.js';

/**
 * A default added after somebody has already used the product still has to reach them.
 *
 * The first attempt recorded that seeding had happened rather than what had been seeded, so
 * three arrangements were added to the shipped list and nobody who already had TabTerm ever saw
 * them. The list of offered ids is what makes "new default" and "default you deleted" different
 * questions, and the logic that answers them lives in `loadTemplates`, which needs a browser.
 * What can be checked here is the shape of the shipped list and what restoring does with it.
 */
describe('the templates that ship', () => {
  it('includes the arrangements as well as the agents', () => {
    const names = DEFAULT_TEMPLATES.map((t) => t.name);
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    // The three that were added later and did not arrive.
    expect(names).toContain('Split in 2');
    expect(names).toContain('1 + 2');
    expect(names).toContain('4 panes');
  });

  it('gives every one a distinct id, since offering is remembered by id', () => {
    const ids = DEFAULT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes each one, since the card shows it', () => {
    for (const t of DEFAULT_TEMPLATES) expect(t.description ?? '').not.toBe('');
  });
});

describe('restoring them', () => {
  it('adds back only what is missing, in front, and leaves the rest alone', () => {
    const [first, second] = DEFAULT_TEMPLATES;
    if (!first || !second) throw new Error('the shipped list is empty');
    const custom = { ...first, id: 'mine', name: 'mine' };
    const restored = withDefaultsRestored([second, custom]);
    // Everything that ships is present again.
    for (const t of DEFAULT_TEMPLATES) expect(restored.some((r) => r.id === t.id)).toBe(true);
    // And what was already there is still there, untouched.
    expect(restored.find((r) => r.id === 'mine')?.name).toBe('mine');
  });

  it('changes nothing when none is missing', () => {
    expect(withDefaultsRestored(DEFAULT_TEMPLATES)).toHaveLength(DEFAULT_TEMPLATES.length);
  });

  it('counts what has been deleted or edited, so restoring is offered only then', () => {
    expect(alteredDefaults(DEFAULT_TEMPLATES)).toHaveLength(0);
    expect(alteredDefaults([])).toHaveLength(DEFAULT_TEMPLATES.length);
    const edited = DEFAULT_TEMPLATES.map((t, i) => (i === 0 ? { ...t, name: 'renamed' } : t));
    expect(alteredDefaults(edited)).toHaveLength(1);
  });
});
