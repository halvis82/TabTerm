# ADR-0008 — OSC 7 and OSC 133 instead of a bespoke shell protocol

**Status:** Accepted

## Context
The daemon sees bytes, not meaning. It needs current directory, prompt boundaries, command start and
end, and exit status. Inventing a reporting protocol for this is the obvious move.

## Decision
Use the existing standards. OSC 7 reports the current directory. OSC 133 marks prompt start, command
start, command output, and command end with exit code. These are what iTerm2, WezTerm, Kitty, and
Ghostty use.

## Consequences
- The command timing model, cross-session history, dynamic titles, and delimited scrollback all fall
  out of one standard rather than a bespoke one.
- Shells already configured for another terminal's integration largely work with ours.
- xterm.js can be taught to consume the same marks, so frontend and daemon agree.
- Known blind spots are inherited rather than invented: commands inside full-screen apps produce no
  records, and SSH requires the remote shell to have integration installed. Documented in
  `08-shell-integration.md` §4.

## Alternatives rejected
- **Custom escape sequences.** Same work, zero interoperability, and a second thing to maintain.
- **Polling `lsof` or `/proc` equivalents for cwd.** Racy, expensive, and violates the no-polling rule.
