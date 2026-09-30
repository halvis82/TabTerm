import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const API = 'https://chromewebstore.googleapis.com';
const accepted = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

/** The API's upload and review are separate operations. Never publish an unfinished upload. */
export async function submitExtension({
  publisherId,
  itemId,
  version,
  archive,
  token,
  fetchImpl = fetch,
  wait = setTimeout,
  maxPolls = 24,
}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(publisherId ?? ''))
    throw new Error('Missing or invalid publisher ID');
  if (!/^[a-p]{32}$/.test(itemId ?? '')) throw new Error('Missing or invalid extension ID');
  if (!token) throw new Error('Missing Chrome Web Store access token');
  if (!/^\d+(\.\d+){1,3}$/.test(version ?? '')) throw new Error('Invalid release version');
  const resource = `publishers/${publisherId}/items/${itemId}`;
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`${API}/${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
    // Do not echo response bodies: upstream errors may reflect request credentials.
    if (!response.ok)
      throw new Error(
        `Chrome Web Store request failed (HTTP ${response.status}). Check dashboard and workflow configuration.`,
      );
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Chrome Web Store returned an invalid response. Check the dashboard.');
    }
    if (result.error)
      throw new Error('Chrome Web Store returned an API error. Check the dashboard.');
    return result;
  };
  const status = await request(`v2/${resource}:fetchStatus`);
  if (status.takenDown || status.warned)
    throw new Error('Resolve the store policy status in the dashboard first');
  const submitted = status.submittedItemRevisionStatus;
  if (submitted && !['CANCELLED', 'REJECTED'].includes(submitted.state)) {
    throw new Error(
      'An existing submission needs attention in the dashboard. It will not be canceled or replaced.',
    );
  }
  const parts = (value) => value.split('.').map(Number).concat([0, 0, 0, 0]).slice(0, 4);
  const newer = (old) => {
    const a = parts(version),
      b = parts(old);
    for (let i = 0; i < 4; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  };
  for (const revision of [status.publishedItemRevisionStatus, submitted]) {
    for (const channel of revision?.distributionChannels ?? []) {
      if (channel.crxVersion && !newer(channel.crxVersion))
        throw new Error('Release version must be higher than the store version');
    }
  }
  const upload = await request(`upload/v2/${resource}:upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: archive,
  });
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < maxPolls; attempt++) {
    await wait(5000);
    state = (await request(`v2/${resource}:fetchStatus`)).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED')
    throw new Error(
      'Upload did not finish successfully. Nothing was submitted. Check the dashboard before retrying.',
    );
  const result = await request(`v2/${resource}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishType: 'DEFAULT_PUBLISH',
      skipReview: false,
      blockOnWarnings: true,
    }),
  });
  if (!accepted.has(result.state))
    throw new Error('Unexpected submission state. Check the dashboard before retrying.');
  return { version, itemId, state: result.state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const result = await submitExtension({
      publisherId: process.env.CWS_PUBLISHER_ID,
      itemId: pkg.tabterm.publishedExtensionId,
      version: pkg.version,
      archive: readFileSync(`dist/tabterm-extension-${pkg.version}.zip`),
      token: process.env.CWS_ACCESS_TOKEN,
    });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nChrome Web Store ${result.version}: ${result.state}. Submission is not proof of approval or delivery.\n`,
      );
  } catch (error) {
    // Fetch failures can carry request metadata in their causes. Never print a stack or cause.
    console.error(error instanceof Error ? error.message : 'Submission failed');
    process.exitCode = 1;
  }
}
