# ADR-0016 — An absent exit code is not a zero, and the tab must be able to say so

**Status:** Accepted

## Context

Exit codes reach TabTerm through OSC 133, which only a shell with the integration sourced emits.
Without it, command boundaries are recovered by watching the shell's foreground child, and the
operating system reports nothing about the outcome of a process that has already exited.

`08-shell-integration.md` already stated the honest position: records are stored **without** an
exit code rather than with a guessed one, because `exit:fail` has to mean something. The code did
not keep that promise. The fallback path called the command-end event with a literal `0`, and
`exitCode` was a required field all the way down the wire. Every consumer that asked "did this
succeed" was told yes on no evidence at all.

That was harmless while nothing rendered it. It stopped being harmless the moment the tab grew a
status the user reads from another window: a green tick asserting success for a command that
returned 1 is worse than no indicator, because a wrong answer is acted on and a missing one is
investigated.

## Decision

**`exitCode` is optional at every layer**, from `command-end` on the wire down to the favicon,
and absent means absent.

The tab state machine gains a state for it. There are now three ways a command can end:

| Observed | State | Icon |
|---|---|---|
| Exited zero | `success` | Green tick |
| Exited non-zero | `failed` | Red cross |
| Nobody could tell | `done` | Grey bar |

A notification for an unobserved outcome says the command finished and how long it took, both of
which are known, and does not say that it worked.

## Consequences

- **The status system is honest without shell integration**, rather than confidently wrong. A tab
  says a command is over and declines to say more.
- **Sourcing the integration now visibly buys something**: the difference between "finished" and
  "succeeded" is on screen, which is a better argument for it than any documentation. It is
  offered as a switch in settings for exactly that reason.
- Three end states instead of two, which is more surface in the state machine and one more icon
  to draw. Worth it: the alternative encodes "unknown" as "fine".
- Anything consuming `exitCode` must handle `undefined`. The type system enforces this, since the
  field is optional under `exactOptionalPropertyTypes`.

## Alternatives rejected

**Keep guessing zero.** Simplest, and what the code did. It makes success the default claim for
every command anyone runs without shell integration, which is most of them on a fresh install.

**Treat unknown as failure.** Symmetrically wrong, and worse in practice: a red tab strip that
means nothing trains people to ignore red.

**Require shell integration and refuse to show status without it.** Rejected in
`08-shell-integration.md` for the whole product, and the reasoning holds here. A terminal that
does nothing until you edit `.zshrc` is a bad answer to a question the operating system can
partly answer by itself.
