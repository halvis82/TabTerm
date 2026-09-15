# ADR-0018 — TabTerm is built from source, not shipped as a signed download

**Status:** Accepted

**Relates to:** `13-packaging.md`, `10-limitations.md` tier 2.1

## Context

The macOS side of TabTerm is an app bundle. It exists so the processes that spawn everybody's
shells have a stable identity for macOS to attach privacy grants to, which a bare `node` binary in
a Homebrew path does not.

With no signing identity that bundle is signed **ad hoc**, and an ad-hoc signature is a hash of the
bundle's own contents. That has one real consequence, measured rather than assumed: folder and
app-data grants are keyed by bundle identifier and survive an update, and **Full Disk Access is
recorded against the signature and does not**. Adding an icon on 2026-09-08 moved the identity from
`548ec5d5` to `91eeafc4` and the Full Disk Access row went to denied, while the folder grants came
through untouched. An icon is enough, because an icon is contents.

A Developer ID certificate would fix that, by letting the requirement name the identifier instead
of the hash. It would also be required to distribute a prebuilt `.app` for download, because a
downloaded bundle carries `com.apple.quarantine` and Gatekeeper does assess it.

Both need a paid Apple Developer account.

## Decision

**TabTerm is distributed as source. A person clones the repository and runs the installer.** There
will be no signed, notarized, downloadable `.app`, and no Developer ID certificate.

## Consequences

- **Nothing about the ordinary path changes.** A locally built bundle carries no quarantine
  attribute, so Gatekeeper never assesses it. Verified: `spctl -a` rejects an ad-hoc signature, and
  the daemon starts, serves an authenticated client and spawns PTYs regardless, because that
  assessment is not on the path.
- **Full Disk Access is lost on any change to the bundle's contents**, and that is now permanent
  rather than pending. It is optional: it exists only so an agent probing another application's
  data directory does not produce a prompt in TabTerm's name, and refusing that prompt costs
  nothing but the agent's organization plugins.
- **The installer must keep saying when it happens.** `install.sh` records the signature before it
  writes the bundle and compares afterwards, and `doctor.sh` distinguishes a grant that applies
  from a stale entry that is still listed. Those are not a stopgap until a certificate arrives.
  They are the mechanism.
- The build accepts `--sign` and the notarization commands stay documented, so anybody who does
  have an account can produce a signed bundle for themselves. Nothing here prevents that.

## Alternatives rejected

**Buy a Developer ID.** It solves the grant problem properly and costs a paid account per year for
a project whose install path is already a `git clone`. Rejected as not worth it.

**Drop the app bundle and run `node` directly.** This is what the product did before, and it is
worse: grants key to the versioned Homebrew `node` path, so every Node upgrade silently moves the
identity and every prompt names `node` rather than TabTerm. See tier 2.1.

**Ship unsigned and tell people to right-click Open.** That is for downloads, and there are none.
