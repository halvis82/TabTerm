const allowed = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
/** No authorization token, cookie or user data is sent to GitHub. */
export async function download(url, limit, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(60_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      !allowed.has(target.hostname) ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443')
    )
      throw new Error('Untrusted update address');
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'TabTerm-updater', Accept: 'application/octet-stream' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Invalid release redirect');
      url = new URL(location, url).href;
      continue;
    }
    if (response.status === 404) throw new Error('No companion release is published yet.');
    if (!response.ok)
      throw new Error(`Update server returned HTTP ${response.status}. Try again later.`);
    if (Number(response.headers.get('content-length')) > limit)
      throw new Error('Update download exceeds the size limit');
    if (!response.body) throw new Error('Empty update response');
    const chunks = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > limit) {
        await response.body.cancel().catch(() => {});
        throw new Error('Update download exceeds the size limit');
      }
      chunks.push(Buffer.from(part));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many update redirects');
}
