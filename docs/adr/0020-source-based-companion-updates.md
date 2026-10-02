# ADR-0020: Update the companion from verified release source

**Status:** Accepted

## Context

Chrome can update the extension independently, but rebuilding and installing the companion by hand
makes routine updates harder. A daemon cannot reliably replace itself, and reverting user data after
a failed migration would lose work. Running terminals belong to a separate long-lived host.

## Decision

Keep ADR-0018's source distribution. Offer manual checks and installation in Settings, with optional
automatic checks and compatible automatic installation, both off by default. The daemon checks a
fixed GitHub Release manifest. An independent per-user helper verifies and builds release source,
backs up program files, invokes the prepared installer and verifies authenticated health. Failed
activation restores program files, never live user data. Unknown protocol/storage/runtime changes,
database-code changes and native terminal dependency changes require manual setup.

## Consequences

The user needs the existing build prerequisites once. Routine compatible updates need no sudo or
checkout management. The terminal host stays running. Initial installation of the updater still uses
the source installer. Outbound checks/downloads are disclosed in the privacy policy. GitHub publisher
control and HTTPS remain the distribution trust boundary. Metadata hashes are integrity checks, not
independent publisher signatures. Extension and companion compatibility must survive different
publication schedules. Optional Full Disk Access can need re-granting after a changed app signature.

## Alternatives rejected

- Pulling `main` into the user's checkout would mix unfinished code and local edits with updates.
- Running installation inside the daemon would lose the updater during its own restart.
- Rolling back databases alongside binaries would discard user changes made during the attempt.
- Prebuilt notarized downloads would change the source-only distribution decision and require a
  separate signing and distribution project.
