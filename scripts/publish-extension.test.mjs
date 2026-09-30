import { describe, expect, it, vi } from 'vitest';
import { submitExtension } from './publish-extension.mjs';

function fixture(responses) {
  const fetchImpl = vi.fn(async () => {
    if (!responses.length) throw new Error('Unexpected API call');
    const value = responses.shift();
    return { ok: true, json: async () => value };
  });
  return {
    fetchImpl,
    options: {
      publisherId: 'publisher',
      itemId: 'llpnnikkigahedhoedecpgjcnmfcgfen',
      version: '1.0.3',
      archive: Buffer.from('fixture'),
      token: 'test-token',
      fetchImpl,
      wait: vi.fn(async () => {}),
      maxPolls: 2,
    },
  };
}

describe('store submission', () => {
  it('waits for async upload success before submitting with review enabled', async () => {
    const { options, fetchImpl } = fixture([
      {},
      { uploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'SUCCEEDED' },
      { state: 'PENDING_REVIEW' },
    ]);
    expect(await submitExtension(options)).toMatchObject({ state: 'PENDING_REVIEW' });
    expect(fetchImpl.mock.calls.map(([url]) => url.split(':').at(-1))).toEqual([
      'fetchStatus',
      'upload',
      'fetchStatus',
      'publish',
    ]);
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toEqual({
      publishType: 'DEFAULT_PUBLISH',
      skipReview: false,
      blockOnWarnings: true,
    });
  });
  it.each(['PENDING_REVIEW', 'STAGED', 'ITEM_STATE_UNSPECIFIED'])(
    'does not disturb existing %s submission',
    async (state) => {
      const { options, fetchImpl } = fixture([{ submittedItemRevisionStatus: { state } }]);
      await expect(submitExtension(options)).rejects.toThrow('existing submission');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['FAILED', 'NOT_FOUND', undefined])(
    'never publishes unsuccessful upload %s',
    async (state) => {
      const { options, fetchImpl } = fixture([{}, { uploadState: state }]);
      await expect(submitExtension(options)).rejects.toThrow('Upload did not finish');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
  it('bounds polling without submitting', async () => {
    const { options, fetchImpl } = fixture([
      {},
      { uploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'IN_PROGRESS' },
    ]);
    await expect(submitExtension(options)).rejects.toThrow('Upload did not finish');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each(['1.0.3', '1.0.4', '1.0.10', '2.0.0'])(
    'rejects duplicate or lower version relative to %s',
    async (version) => {
      const { options, fetchImpl } = fixture([
        { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: version }] } },
      ]);
      await expect(submitExtension(options)).rejects.toThrow('must be higher');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it('does not expose API error bodies', async () => {
    const { options } = fixture([]);
    options.fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ secret: 'private-value' }),
    }));
    await expect(submitExtension(options)).rejects.toThrow('HTTP 403');
  });
  it('rejects missing credentials before any network operation', async () => {
    const { options, fetchImpl } = fixture([]);
    await expect(submitExtension({ ...options, token: '' })).rejects.toThrow('Missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
