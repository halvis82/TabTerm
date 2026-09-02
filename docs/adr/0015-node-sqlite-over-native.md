# ADR-0015 — Use Node's built-in SQLite, and require Node 22 or newer

**Status:** Accepted

## Context

`03-data-model.md` specifies SQLite with indices for history search, and the interim JSON stores
will not scale to a real command history.

The obvious choice was `better-sqlite3`. It does not work here:

```
prebuild-install warn install No prebuilt binaries found
  (target=20.19.5 runtime=node arch=arm64 libc= platform=darwin)
gyp ERR! stack Error: `make` failed with exit code: 2
```

No prebuilt binary for this platform and runtime, and the local compile failed **even on a machine
with Xcode installed**. Shipping it would mean every user needs a working compiler toolchain, and a
second native module to stage beside the daemon along with all the surprises that already came with
the first one (see the spawn-helper permission in `13-packaging.md`).

## Decision

Use `node:sqlite`, built into Node, and raise the runtime requirement to **Node 22 or newer**.

## Consequences

- **Zero native modules for the database.** Nothing to compile, nothing to stage, nothing to lose
  an executable bit in transit.
- Real SQLite: indices, WAL, prepared statements, and paging, which is what the data model asked
  for and what JSON cannot give.
- The runtime requirement rises from Node 20 to Node 22. The installer must select a Node that has
  it rather than whatever `command -v node` returns first.
- **`node:sqlite` is marked experimental** and prints an ExperimentalWarning. The API could
  change between Node versions.

  This is the real cost, and it is bounded by ADR-0006: the daemon ships inside an app bundle with
  its own pinned runtime, so the API is frozen at whatever version we ship. An experimental API
  behind a pinned runtime is a smaller risk than a native module that does not build.

- node-pty was verified working on Node 24 before committing to this, since a runtime bump that
  broke the PTY layer would have been a much worse trade.

## Alternatives rejected

- **`better-sqlite3`.** Does not build on this platform and runtime. Requires a compiler for every
  user. Would be a second native module to stage.
- **`sql.js` (WASM).** No native dependency, but it holds the whole database in memory, which
  directly contradicts the rule in `03-data-model.md` that the database is never mirrored into JS
  memory.
- **Keep the JSON stores.** Fine at today's volumes and genuinely honest, but it defers the same
  decision to the point where history is large enough that the migration is painful rather than
  cheap.
