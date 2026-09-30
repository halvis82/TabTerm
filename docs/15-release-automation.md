# Extension release automation

The GitHub Actions workflow in `.github/workflows/extension.yml` builds and checks the project
on pushes to `main`, pull requests to `main`, and version tags. A manual workflow run performs
checks only. The workflow stores the verified extension ZIP as an artifact.

Only a pushed annotated `v<version>` tag submits an update to the Chrome Web Store. The tag must
match the package version and its commit must already be included in `main`. Each store upload
requires a higher version. Ordinary source pushes do not create store releases.

The submission job uses the Chrome Web Store v2 API. It uploads the checked artifact, waits for
upload processing, then submits for review with automatic publication after approval. It does
not skip review, alter listing text or images, cancel another submission, or update the installed
macOS companion. Store-installed extensions receive updates through Chrome after publication.
Unpacked developer extensions still use the local build and reload workflow.

## One-time connection

1. Create or choose a Google Cloud project and enable the Chrome Web Store API, IAM API,
   IAM Service Account Credentials API and Security Token Service API.
2. Create a service account for publishing. No project-wide owner/editor role is required.
   Add its email in the Chrome Web Store Developer Dashboard's Account section.
3. Create a Workload Identity Pool and GitHub OIDC provider with issuer
   `https://token.actions.githubusercontent.com`.
4. Map `google.subject=assertion.sub`, `attribute.repository_id=assertion.repository_id`,
   and `attribute.repository_owner_id=assertion.repository_owner_id`.
5. Restrict the provider attribute condition to this repository and owner, release tags and
   the publishing environment:

   ```text
   assertion.repository_id == '1332430488' &&
   assertion.repository_owner_id == '62351640' &&
   assertion.ref.startsWith('refs/tags/v') &&
   assertion.sub == 'repo:halvis82/TabTerm:environment:chrome-web-store'
   ```

6. Grant `roles/iam.workloadIdentityUser` on the publishing service account to the pool's
   repository identity:

   ```text
   principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository_id/1332430488
   ```

7. Create the GitHub environment `chrome-web-store`. Restrict its deployment rules to tags
   matching `v*`. Configure these environment variables under repository Settings,
   Environments, chrome-web-store:

   | Variable | Value |
   |---|---|
   | `CWS_PUBLISHER_ID` | Publisher ID from Chrome Web Store Publisher > Settings |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID` |
   | `GCP_SERVICE_ACCOUNT` | Publishing service account email |

   These are identifiers, not credentials. The workflow obtains a short-lived access token
   through OIDC with the `https://www.googleapis.com/auth/chromewebstore` scope. Do not generate
   or commit a service account private key. Credentials files are disabled in the auth action.

The store item ID is `tabterm.publishedExtensionId` in `package.json`. The companion installer
registers this alongside the unpacked extension ID. Existing companion installations need the
installer run again after receiving this configuration. That is separate from a store update.

## Releasing

1. Update versions together in the root package, lockfile, extension manifest and shared VERSION.
2. Follow the [packaging release checklist](13-packaging.md#release-checklist), including the
   full local browser gate and credentials audit. Hosted checks currently run `npm run verify`,
   not the browser harness. A green workflow does not replace that release gate.
3. Integrate the release into `main`, push the commit, and push an annotated matching version tag.
   Never move a published tag. Do not reuse an already uploaded store version.
4. Check the workflow's archive verification output and store submission state. A successful
   submission means review was requested, not that the extension is approved or installed.
5. Confirm approval and publication in the Chrome Web Store dashboard. Verify a real store
   installation can connect to the companion.

Only the submission job can obtain Google credentials. Pull requests and build jobs have read-only
repository access. Actions are pinned to commit hashes. Builds happen before authentication and
only the extension ZIP is uploaded as an artifact. The submission job installs no npm dependencies.
Submissions are serialized. Avoid pushing multiple release tags while review is pending.

## Failure and retry

An active or staged submission stops the workflow before upload. Resolve that state in the
dashboard. The workflow never cancels review. Duplicate or lower published versions are rejected.
Failed, unknown or timed-out uploads stop before publish. HTTP failures are reported without
printing response bodies or access tokens.

If upload succeeded but submission failed, inspect the dashboard and submit that uploaded draft
manually after resolving the error. Do not blindly rerun upload or move the tag. The workflow does
not automatically recover a partially completed release because the uploaded draft may have been
changed independently in the dashboard.

Cloud configuration, a pushed workflow and a real hosted run are required before this automation
can be considered operational. The first existing manual submission can remain under review while
the workflow is configured for later versions.

## References

- [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
- [Service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Google GitHub authentication](https://github.com/google-github-actions/auth)
