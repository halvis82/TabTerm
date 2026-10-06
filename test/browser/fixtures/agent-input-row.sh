#!/bin/sh
# The shape of an agent's prompt: a full-width row with an explicit RGB background, redrawn the
# way ink redraws, then a status line that changes every 100 ms for as long as the agent works.
# Claude Code's row is 48;2;55;55;55 with the prompt in 80,80,80 and the text in white.
W=$(tput cols)
box() { printf '\033[48;2;55;55;55m\033[38;2;80;80;80m > \033[38;2;255;255;255m%-*s\033[49m\033[39m\n' "$((W - 3))" "$1"; }
printf 'earlier output\n'
box 'typed prompt text'
printf 'esc to interrupt\n'
sleep 1.5
# Erase the three-line frame and draw it again with four response lines above the box.
printf '\033[2K\033[1A\033[2K\033[1A\033[2K\033[1A\033[2K\r'
printf 'response line 1\nresponse line 2\nresponse line 3\nresponse line 4\n'
box ''
i=0
while [ "$i" -lt 40 ]; do
  printf '\033[2K\rworking %d  esc to interrupt' "$i"
  i=$((i + 1))
  sleep 0.1
done
printf '\n'
