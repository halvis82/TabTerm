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
/** A second directory, for the rows that must not move when this one's conversation is resumed. */
const elsewhere = join(root, 'another-project');
mkdirSync(elsewhere, { recursive: true });

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
/*
 * And what resuming `aaaa-1111` leaves behind: another rollout recording the same conversation.
 *
 * Seen on a real store as the same row offered twice a few minutes apart, each one resuming the
 * same thing. The other agent's store had it too, and it is the same fault in both.
 */
rollout('2026/09/01', 'rollout-2026-09-01T08-00-00-cccc.jsonl', [
  meta('aaaa-1111', project),
  said('picked up again'),
]);
// The same shape as the first one, in another directory, so what a label is made of can be
// checked on a conversation nothing has resumed.
rollout('2026/08/29', 'rollout-2026-08-29T10-00-00-eeee.jsonl', [
  meta('eeee-5555', elsewhere),
  { payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x' }] } },
  said('<injected-context>ignore me</injected-context>'),
  said('# AGENTS.md instructions'),
  said('make the tests pass'),
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
    const found = await listCodexResumable({ store, cwd: elsewhere });
    // Not the developer turn, not injected context, not the AGENTS.md preamble.
    expect(found.find((s) => s.sessionId === 'eeee-5555')?.summary).toBe('make the tests pass');
  });

  /*
   * A conversation that has been picked up again is one row, from its newest rollout.
   *
   * Resuming writes a new rollout recording the same conversation id, so it was offered twice
   * over, both rows resuming the same thing. The newest wins, which is also where its most recent
   * words are, so the label describes the conversation as it stands rather than as it began.
   */
  it('offers a conversation once, however many times it has been resumed', async () => {
    const found = await listCodexResumable({ store });
    const mine = found.filter((s) => s.sessionId === 'aaaa-1111');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.summary).toBe('picked up again');
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
