import { afterEach, describe, expect, it, vi } from 'vitest';
import { askWorker, tellWorker } from './worker.js';

/**
 * A worker that is not running rejects with Chrome's own "No SW". That must never surface as
 * an uncaught rejection, which is what chrome://extensions lists as an error.
 */
describe('a message to a worker that is not there', () => {
  const sendMessage = vi.fn(() => Promise.reject(new Error('No SW')));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  afterEach(() => sendMessage.mockClear());

  it('is let go when fired and forgotten', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    tellWorker({ t: 'tabterm:open-local', port: 3000 });
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('answers nothing when an answer was wanted', async () => {
    expect(await askWorker({ t: 'tabterm:count-terminal-tabs' })).toBeUndefined();
  });
});
