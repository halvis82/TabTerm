import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTranscript } from './agent-transcript.js';

let dir = '';
const write = async (name: string, records: unknown[]): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-transcript-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Reading a stored conversation to tell one resumable session from another.
 *
 * The alternative that suggests itself, starting the agent and asking it, is not one: resuming a
 * session to find out whether you want to resume it changes the thing being inspected. So this
 * reads the agent's own file and starts no process.
 *
 * The format is nobody's promise, which is why every one of these checks is also a check that an
 * unfamiliar record costs a turn and nothing more.
 */
describe('reading a stored agent conversation', () => {
  it('reads both sides of a Claude Code session, oldest first', async () => {
    const path = await write('claude.jsonl', [
      { type: 'user', message: { content: 'first thing' }, timestamp: '2026-09-04T10:00:00Z' },
      { type: 'assistant', message: { content: [{ text: 'first answer' }] } },
      { type: 'user', message: { content: [{ text: 'second thing' }] } },
    ]);
    const turns = await readTranscript(path);
    expect(turns.map((t) => `${t.role}: ${t.text}`)).toEqual([
      'you: first thing',
      'agent: first answer',
      'you: second thing',
    ]);
    expect(turns[0]?.at).toBe(Date.parse('2026-09-04T10:00:00Z'));
  });

  it('reads a Codex session, whose records wrap the message in a payload', async () => {
    const path = await write('codex.jsonl', [
      { payload: { type: 'message', role: 'user', content: [{ text: 'hello there' }] } },
      { payload: { type: 'message', role: 'assistant', content: [{ text: 'hello back' }] } },
    ]);
    expect((await readTranscript(path)).map((t) => t.role)).toEqual(['you', 'agent']);
  });

  it('leaves out everything that is not conversation', async () => {
    // Tool calls, tool results, hook output and session metadata share the file. A card full of
    // those says less than an empty one.
    const path = await write('noise.jsonl', [
      { type: 'summary', summary: 'a title' },
      { type: 'system', message: { content: 'hook fired' } },
      { type: 'user', message: { content: 'the only real turn' } },
      { type: 'tool_result', message: { content: 'ok' } },
    ]);
    const turns = await readTranscript(path);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('the only real turn');
  });

  it('survives a half written line, which a live session always has', async () => {
    const path = join(dir, 'partial.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({ type: 'user', message: { content: 'complete' } })}\n{"type":"assist`,
    );
    expect((await readTranscript(path)).map((t) => t.text)).toEqual(['complete']);
  });

  it('takes the last turns rather than the first', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      type: 'user',
      message: { content: `turn ${String(i)}` },
    }));
    const path = await write('many.jsonl', many);
    const turns = await readTranscript(path, 5);
    expect(turns).toHaveLength(5);
    expect(turns[4]?.text).toBe('turn 39');
  });

  it('shortens a turn that is really tool output rather than talk', async () => {
    const path = await write('long.jsonl', [
      { type: 'assistant', message: { content: 'x'.repeat(5000) } },
    ]);
    const turns = await readTranscript(path);
    expect(turns[0]?.text.length).toBeLessThan(700);
    expect(turns[0]?.text.endsWith('…')).toBe(true);
  });

  it('returns nothing for a file that is not there, rather than failing', async () => {
    expect(await readTranscript(join(dir, 'no-such-file.jsonl'))).toEqual([]);
  });

  it('flattens newlines, because a card shows a line and not a document', async () => {
    const path = await write('multiline.jsonl', [
      { type: 'user', message: { content: 'one\n\ntwo   three' } },
    ]);
    expect((await readTranscript(path))[0]?.text).toBe('one two three');
  });
});
