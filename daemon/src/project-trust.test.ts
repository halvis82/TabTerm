import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { ProjectTrust, trustAction, type TrustState } from './project-trust.js';
import type { LoadedProjectConfig } from './project-config.js';

const cfg = (hash: string, path = '/repo/.tabterm.json'): LoadedProjectConfig => ({
  path,
  contentHash: hash,
  template: { name: 'x', layout: null, commands: [] },
});

const fresh = () => new ProjectTrust(new Database(':memory:'));

describe('project trust', () => {
  it('asks about a config it has never seen', () => {
    expect(fresh().evaluate(cfg('a')).status).toBe('unknown');
  });

  it('remembers approval for exactly the approved content', () => {
    const t = fresh();
    t.record(cfg('a'), 'trusted');
    expect(t.evaluate(cfg('a')).status).toBe('trusted');
  });

  it('asks again once the file changes under an approval', () => {
    // The supply-chain case: a repository is trusted, then a pull rewrites the config.
    const t = fresh();
    t.record(cfg('a'), 'trusted');
    const state = t.evaluate(cfg('b'));
    expect(state.status).toBe('changed');
    expect(state.previousDecision).toBe('trusted');
    expect(trustAction(state)).toBe('ask');
  });

  it('remembers a denial so the repository cannot keep asking', () => {
    const t = fresh();
    t.record(cfg('a'), 'denied');
    expect(trustAction(t.evaluate(cfg('a')))).toBe('ignore');
  });

  it('lets a changed config be reconsidered after a denial', () => {
    // A denial is not a permanent blacklist of the path: the content it denied is gone.
    const t = fresh();
    t.record(cfg('a'), 'denied');
    expect(t.evaluate(cfg('b')).status).toBe('changed');
    t.record(cfg('b'), 'trusted');
    expect(t.evaluate(cfg('b')).status).toBe('trusted');
  });

  it('keeps decisions per path, so one project cannot speak for another', () => {
    const t = fresh();
    t.record(cfg('a', '/one/.tabterm.json'), 'trusted');
    expect(t.evaluate(cfg('a', '/two/.tabterm.json')).status).toBe('unknown');
  });

  it('forgets a decision on request', () => {
    const t = fresh();
    t.record(cfg('a'), 'trusted');
    t.forget('/repo/.tabterm.json');
    expect(t.evaluate(cfg('a')).status).toBe('unknown');
  });

  it('lists decisions for review', () => {
    const t = fresh();
    t.record(cfg('a', '/one/.tabterm.json'), 'trusted');
    t.record(cfg('b', '/two/.tabterm.json'), 'denied');
    const list = t.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.decision).sort()).toEqual(['denied', 'trusted']);
  });

  it('never offers anything that was not explicitly trusted', () => {
    const states: TrustState[] = [
      { status: 'unknown' },
      { status: 'denied' },
      { status: 'changed', previousDecision: 'trusted' },
    ];
    for (const s of states) expect(trustAction(s)).not.toBe('offer');
  });
});
