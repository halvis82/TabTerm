import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  alteredDefaults,
  defaultsOutOfOrder,
  withDefaultsRestored,
} from './templates.js';

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

  /**
   * Order is part of what is restored, because the first four carry Control and a number.
   *
   * Putting only the missing ones at the front gave `1 + 2` back ahead of `Split in 2`, so the
   * arrangement that had been on Control 1 was now on Control 2. That is the templates back and
   * the keys not, which is the confusing half of a restore.
   */
  /** The first shipped template, which every fixture below is a variation of. */
  const one = DEFAULT_TEMPLATES[0] as (typeof DEFAULT_TEMPLATES)[number];

  it('puts the shipped ones back in the order they ship in', () => {
    const shuffled = [...DEFAULT_TEMPLATES].reverse();
    const restored = withDefaultsRestored(shuffled);
    expect(restored.map((t) => t.id)).toEqual(DEFAULT_TEMPLATES.map((t) => t.id));
  });

  it('and keeps what you made after them, in your order', () => {
    const first = { ...one, id: 'a', name: 'a' };
    const second = { ...one, id: 'b', name: 'b' };
    const restored = withDefaultsRestored([first, DEFAULT_TEMPLATES[2] ?? one, second]);
    expect(restored.map((t) => t.id).slice(0, DEFAULT_TEMPLATES.length)).toEqual(
      DEFAULT_TEMPLATES.map((t) => t.id),
    );
    expect(restored.map((t) => t.id).slice(DEFAULT_TEMPLATES.length)).toEqual(['a', 'b']);
  });

  it('keeps a default you edited rather than reverting it', () => {
    const renamed = { ...one, name: 'my own name' };
    const restored = withDefaultsRestored([renamed]);
    expect(restored[0]?.name).toBe('my own name');
  });

  it('notices when the shipped ones have been shuffled, so restoring is offered', () => {
    expect(defaultsOutOfOrder(DEFAULT_TEMPLATES)).toBe(false);
    expect(defaultsOutOfOrder([...DEFAULT_TEMPLATES].reverse())).toBe(true);
    const mine = { ...one, id: 'mine', name: 'mine' };
    expect(defaultsOutOfOrder([...DEFAULT_TEMPLATES, mine])).toBe(false);
    expect(defaultsOutOfOrder([mine, ...DEFAULT_TEMPLATES])).toBe(true);
  });

  it('counts what has been deleted or edited, so restoring is offered only then', () => {
    expect(alteredDefaults(DEFAULT_TEMPLATES)).toHaveLength(0);
    expect(alteredDefaults([])).toHaveLength(DEFAULT_TEMPLATES.length);
    const edited = DEFAULT_TEMPLATES.map((t, i) => (i === 0 ? { ...t, name: 'renamed' } : t));
    expect(alteredDefaults(edited)).toHaveLength(1);
  });
});
