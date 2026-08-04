# TabTerm shell integration.
#
# Emits OSC 7 (current directory) and OSC 133 (command marks). These are the same sequences
# iTerm2, WezTerm, Kitty, and Ghostty use, so nothing here is TabTerm-specific and a shell
# already configured for another terminal largely works. See docs/08-shell-integration.md.
#
# Requirements this file keeps:
#   - never clobbers existing hooks: appends via add-zsh-hook, never assigns over precmd/preexec
#   - no-ops outside TabTerm, so the same .zshrc works in iTerm and over SSH
#   - no subprocess spawns on the prompt path, so it adds no measurable latency
#   - every failure path is silent

[[ -n "$TABTERM_SESSION" ]] || return 0
[[ -o interactive ]] || return 0

autoload -Uz add-zsh-hook 2>/dev/null || return 0

__tabterm_osc7() {
  # OSC 7 reports the working directory as file://<host><path>. The daemon validates it, so a
  # hostile value changes a display field and nothing more.
  printf '\e]7;file://%s%s\e\\' "${HOST}" "${PWD}"
}

__tabterm_preexec() {
  # OSC 133;C marks the start of command output.
  printf '\e]133;C\e\\'
}

__tabterm_precmd() {
  local exit_code=$?
  # OSC 133;D carries the exit status of the command that just finished, then A marks the start
  # of the next prompt.
  printf '\e]133;D;%s\e\\' "$exit_code"
  __tabterm_osc7
  printf '\e]133;A\e\\'
}

add-zsh-hook precmd  __tabterm_precmd
add-zsh-hook preexec __tabterm_preexec
add-zsh-hook chpwd   __tabterm_osc7

# OSC 133;B marks the end of the prompt and the start of typed input. The %{...%} wrapper tells
# zsh the sequence occupies no columns, so it does not corrupt prompt width calculations.
PS1="${PS1}"$'%{\e]133;B\e\\%}'

__tabterm_osc7
