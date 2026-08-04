# ADR-0006 — Daemon ships as a signed app bundle

**Status:** Accepted

## Context
Processes spawned by the daemon inherit the *daemon's* macOS TCC privacy identity, not Terminal.app's.
With a bare `node` daemon, `ls ~/Desktop` can fail, Full Disk Access granted to iTerm does not
transfer, prompts read "node wants access," and grants can be invalidated by a Node upgrade or a
Homebrew path change.

## Decision
Ship the daemon inside a signed app bundle with a stable `CFBundleIdentifier`. The LaunchAgent points
at the bundle executable, never at a Homebrew `node`.

## Consequences
- TCC grants attach to a durable identity and survive runtime upgrades.
- Codesigning, and notarization if distributed, become part of the build.
- Retrofitting later forces every user to re-grant every permission, which is why the TCC spike validates it
  in Phase 0 rather than at packaging time.

## Alternatives rejected
- **Bare node LaunchAgent.** Simplest, and produces the failure mode above.
- **Ask users to grant Full Disk Access to node.** Fragile, alarming, and breaks on upgrade.
