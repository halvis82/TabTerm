# ADR-0009 — Agent CLI hooks, never output parsing

**Status:** Accepted

## Context
TabTerm wants to show agent state in the tab: working, waiting, needs approval, done, failed.
The obvious approach is to watch the terminal output. It is also brittle by construction: a TUI
changes with every version, every theme, and every window width, and the failure is silent and
confident.

## Decision
Use the agent CLI's hooks system. Hooks post to a daemon endpoint authenticated with the same token,
correlated to a session by `TABTERM_SESSION`. No code path parses rendered output to make a control
decision, and there is no fallback that does.

## Consequences
- State is structured and exact, including across concurrent agent sessions in different panes.
- Granularity is limited to what hooks expose. "Thinking versus writing a file" is not available and
  is shown as one `working` state rather than guessed.
- Hook installation is opt-in, additive, idempotent, and reversible. It never rewrites unrelated
  settings.
- If the hook format changes, the bridge degrades to no state information. It never crashes and never
  falls back to parsing.
- Rich in-browser approval buttons are deliberately not built, since they would require driving a TUI
  from parsed state.

## Alternatives rejected
- **Regex over rendered output.** Breaks silently, and a confidently wrong favicon is worse than none.
- **A agent CLI fork or wrapper.** Maintenance burden, and breaks on every upstream release.
