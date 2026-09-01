import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listCodexResumable } from './codex-sessions.js';

/**
 * Written against a fixture shaped like the real store, because the real one is somebody else's
 * undocumented format on a live disk. The shape here was copied from an actual rollout file.
 */
const root = mkdtempSync(join(tmpdir(), 'tabterm-codex-'));
const store = join(root, 'sessions');
const project = join(root, 'a-project');
mkdirSync(project, { recursive: true });

function rollout(day: string, name: string, records: unknown[]): void {
  const dir = join(store, ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join('\n'));
}

const meta = (id: string, cwd: string) => ({
  type: 'session_meta',
  payload: { session_id: id, id, cwd, originator: 'codex-tui' },
});
const said = (text: string) => ({
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

rollout('2026/08/30', 'rollout-2026-08-30T10-00-00-aaaa.jsonl', [
  meta('aaaa-1111', project),
  { payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x' }] } },
  said('<injected-context>ignore me</injected-context>'),
  said('# AGENTS.md instructions'),
  said('make the tests pass'),
]);
rollout('2026/08/31', 'rollout-2026-08-31T09-00-00-bbbb.jsonl', [
  meta('bbbb-2222', project),
  said('the newer one'),
]);
// No meta record, so there is no id to resume and no directory to resume it in.
rollout('2026/08/31', 'rollout-2026-08-31T11-00-00-cccc.jsonl', [said('orphan')]);
// A real meta, but for a directory that does not exist.
rollout('2026/08/31', 'rollout-2026-08-31T12-00-00-dddd.jsonl', [
  meta('dddd-4444', join(root, 'deleted-since')),
  said('gone'),
]);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('reading Codex sessions', () => {
  it('takes the id and the directory from the meta record, rather than guessing', async () => {
    // Codex states the directory, unlike the Claude store which encodes it into a folder name
    // lossily. Nothing here has to be reversed.
    const found = await listCodexResumable({ store });
    const one = found.find((s) => s.sessionId === 'aaaa-1111');
    expect(one?.cwd).toBe(project);
  });

  it('labels a session with the first thing a person actually typed', async () => {
    const found = await listCodexResumable({ store });
    // Not the developer turn, not injected context, not the AGENTS.md preamble.
    expect(found.find((s) => s.sessionId === 'aaaa-1111')?.summary).toBe('make the tests pass');
  });

  it('offers the newest first', async () => {
    const found = await listCodexResumable({ store });
    expect(found[0]?.sessionId).toBe('dddd-4444');
  });

  it('leaves out a rollout with no meta record, which cannot be resumed', async () => {
    const found = await listCodexResumable({ store });
    expect(found.some((s) => s.summary === 'orphan')).toBe(false);
  });

  it('can be asked for one directory only', async () => {
    const found = await listCodexResumable({ store, cwd: project });
    expect(found.map((s) => s.sessionId).sort()).toEqual(['aaaa-1111', 'bbbb-2222']);
  });

  it('offers nothing rather than failing when the store is not there', async () => {
    await expect(listCodexResumable({ store: join(root, 'no-such-store') })).resolves.toEqual([]);
  });
});
