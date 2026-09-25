import { describe, expect, it } from 'vitest';
import { RepeatedAnswers } from './repeated-answers.js';

/**
 * The rule underneath "the start screen stops rebuilding itself to say what it already said".
 *
 * Checked here rather than in a browser because a full run shares one daemon between suites, so
 * the state genuinely changes while a check is watching: another suite starting a session really
 * is news, and a screen that redrew for it was right to. What must never happen is a drawing for
 * an answer identical to the last one, which is a claim about this and nothing else.
 */
describe('recognising an answer that has already been given', () => {
  it('calls the first one news', () => {
    const seen = new RepeatedAnswers();
    expect(seen.isNews('state', { folders: ['~'] })).toBe(true);
  });

  it('and the same one again nothing', () => {
    const seen = new RepeatedAnswers();
    seen.isNews('state', { folders: ['~'] });
    expect(seen.isNews('state', { folders: ['~'] })).toBe(false);
  });

  it('notices a change anywhere inside it', () => {
    const seen = new RepeatedAnswers();
    seen.isNews('live', [{ id: 'a', memory: 1 }]);
    expect(seen.isNews('live', [{ id: 'a', memory: 2 }])).toBe(true);
  });

  it('counts a different order as different, because it would be drawn differently', () => {
    const seen = new RepeatedAnswers();
    seen.isNews('resumable', ['a', 'b']);
    expect(seen.isNews('resumable', ['b', 'a'])).toBe(true);
  });

  it('keeps each part apart from the others', () => {
    // Otherwise one part going quiet would silence another that had something to say.
    const seen = new RepeatedAnswers();
    seen.isNews('state', 1);
    expect(seen.isNews('servers', 1)).toBe(true);
  });

  it('treats an empty list and nothing at all as different answers', () => {
    const seen = new RepeatedAnswers();
    expect(seen.isNews('restorable', [])).toBe(true);
    expect(seen.isNews('restorable', undefined)).toBe(true);
  });

  it('starts again when told to', () => {
    const seen = new RepeatedAnswers();
    seen.isNews('state', 'x');
    seen.reset();
    expect(seen.isNews('state', 'x')).toBe(true);
  });
});
