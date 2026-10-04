# Companion updates

TabTerm has two delivery channels. Chrome updates the store extension after review. The companion
is built and installed on the Mac, including the daemon, native messaging host, terminal host and
supporting shell integration files. Source remains the distribution format.

## Settings

The Updates section shows installed extension and companion versions. **Check for updates** asks
the companion to read the latest stable GitHub Release and its `companion-release.json` asset.
A branch push alone is not a companion release. Checks do not download or execute source.

**Update companion** downloads and verifies that release, builds in an isolated staging directory,
then installs it. It does not pull into or modify a development checkout. The extension stays under
Chrome's update control. No remote JavaScript is loaded into the extension.

Both automatic options default to off. Automatic checks run at most once a day, with a persisted
last-attempt timestamp. Manual checks are limited to one attempt per minute. Automatic installation
implies automatic checking. Disabling checks also disables automatic installation. A failed automatic
installation is not retried repeatedly for the same version. Manual check and retry remain possible.
If check state cannot be saved, Settings reports the storage failure before any network request.
A manual check can retry after storage is repaired and the one-minute limit has elapsed.
Reset Settings disables both options. Uninstall removes the updater job and its local state.

The first updater-capable companion needs one ordinary source install. Older companions cannot
update themselves into a feature they do not have. Settings links to the setup guide if the
companion does not answer update messages. Development/test daemons cannot launch installation.

## Release metadata

`companion-release.json` uses schema 1 and names a version, matching `v<version>` tag, exact commit,
source asset URL, compressed byte count, SHA-256 and compatibility requirements. The source artifact
is `tabterm-companion-<version>.tar.gz`, created from the committed git tree, never a working tree.

The updater accepts only the fixed TabTerm repository and release-asset address pattern. HTTPS
redirects are limited to GitHub's API, website and release-asset hosts. Metadata, compressed source
and extracted data have bounded sizes. Archive extraction accepts ordinary files and directories,
not symlinks, hardlinks, devices, absolute paths or traversal. npm dependencies are installed using
the committed lockfile. Workspace packages are compiled before bundling so a fresh source archive
builds without generated files from a checkout. Node/npm and Xcode Command Line Tools remain local prerequisites.

The checksum catches a corrupt or mismatched download. It is not an independent publisher signature.
The trust boundary is HTTPS and control of the GitHub release account and workflow. Publishing a
companion release authorizes code that will run as the user on opted-in installations.

## Compatibility and terminal preservation

Extension wire protocol, terminal-host protocol and storage compatibility have explicit identifiers.
Unknown compatibility requires a manual upgrade. Newer system/runtime prerequisites also require
manual setup. This first updater additionally compares database source hashes and the installed
node-pty version, conservatively requiring manual upgrades when either changes.

An ordinary compatible update keeps the running terminal-host process. It never sends that process
a termination signal. The helper verifies the host instance before and after installation and uses
an authenticated response with the expected daemon version for health, not an open TCP port.
New PTY creation is paused briefly during activation. Existing terminals continue running and
browser views reconnect. The clean daemon shutdown writes the existing terminal-state handoff.

Terminal-host code on disk may be updated, but a running compatible host keeps its loaded code
until it exits normally. A host change that cannot coexist with an old host must increment its
compatibility identifier and use manual setup. The updater never offers to close sessions for you.

The per-user installation requires no sudo. Updates may change the ad-hoc app signature and require
re-granting optional Full Disk Access. The updater cannot grant macOS privacy permissions.

## Staging, activation and recovery

The daemon launches a separate user LaunchAgent, `com.tabterm.updater`, using a copy of the installed
helper under `~/.local/state/tabterm/updates`. It survives the daemon's restart. A filesystem lock
prevents concurrent helper operations. Build and installer children stay in the helper process group,
so launchd reaps them if the helper exits. A 15-minute subprocess timeout exits the helper. Preparation timeouts leave the installation
unchanged. Activation timeouts restart into recovery after child cleanup, rather than rolling back
while an installer might still be running. Downloads and builds finish before installed files change.

The helper backs up the installed executable tree, daemon LaunchAgent, native-host registration and
staged shell-integration file. It records a transaction before running the prepared installer.
The installer skips rebuilding, extension reload and interactive setup in this mode. User dotfiles,
tokens, databases, command history and settings are never restored from a backup or reset.

If activation or authenticated health fails, the helper restores the previous program files and
restarts the previous daemon. It reports a rollback separately from success. If recovery fails,
Settings reports that manual setup is required. Existing terminal-host processes are left alone.
The previous executable backup remains for diagnosis until the next update.

An interrupted activation can recover from the journal and backup. The helper LaunchAgent restarts
after signals or unhandled failures. Handled failures exit cleanly after recording their outcome, and a daemon can launch recovery at startup when it finds an abandoned installation
transaction. If neither daemon nor helper can run, execute the normal installer from a known-good
checkout. No updater can recover from a missing/broken runtime without a working process to do so.

Update preferences, request, transaction, helper lock, status and staging files live in the private
`updates` directory. They contain release/install metadata, not terminal contents. Staging may use
substantial disk space for source and dependencies. Failed preparation leaves the current companion
installed. A failed check does not claim there is no update.

## Publishing

Follow [release automation](15-release-automation.md). The tag workflow checks/builds both artifacts,
creates source metadata, and publishes companion assets in a GitHub Release. Chrome submission is a
separate job and may remain under review while a compatible companion release is available.
No existing tag or release asset is overwritten by a retry. Inspect partial releases before retrying.

Release discovery requests GitHub API JSON. Asset downloads request binary data. The API rejects
the binary media type on the release-listing endpoint, so these request headers differ by host.
