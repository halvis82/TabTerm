# ADR-0019: Parsed terminal state across clean daemon updates

**Status:** Accepted

**Extends:** [ADR-0017](0017-a-pty-host-that-outlives-the-daemon.md)

## Context

A bounded raw-output ring is not a bounded terminal transcript. A program can redraw the same
line millions of times without adding any history. Those bytes displace the older output from
the host's ring even though the daemon's parsed terminal still retains its scrollback. Rebuilding
from that ring after an update loses history, leaving a correctly rendered screen that cannot
scroll upward or copy older output.

## Decision

During a clean shutdown, stop page connections and disconnect the daemon from the PTY host without
ending any terminal. Drain pending parsing, then save each live terminal's serialized state with
its dimensions, host instance, and host-delivered byte position. Files are private and atomically
renamed under the state directory's `terminal-checkpoints` directory.

On adoption, accept a checkpoint only for the same host and a byte position not beyond the host's
current output. Restore it at its saved dimensions, resize the local emulator to the host's current
dimensions, and replay only subsequent bytes. Seed the delivered watermark so overlapping held
live frames cannot be applied twice. No replayed checkpoint bytes are sent to the running program.

Consume each file once and remove leftovers before serving clients. This is an update handoff,
not a second persistent history store that could resurrect an explicit clear. Serialized files
are capped at 256 MiB, allowing attribute expansion while bounding reads and writes. An absent or
invalid checkpoint falls back to existing ring replay and never prevents process adoption.

## Consequences

Clean updates preserve the scrollback that was still retained in memory, even after redraws
overflow the raw ring. The PTY host remains unchanged. A crash or forced shutdown without a valid
handoff still depends on the bounded ring. Previously discarded history cannot be reconstructed.

## Alternatives rejected

- Increasing the raw ring only postpones the same failure and increases memory use.
- Parsing screen state inside the PTY host adds rendering dependencies to the process that must
  stay running unchanged during updates.
- Keeping stale handoffs after adoption risks restoring text that was subsequently cleared.
