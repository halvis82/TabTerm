#!/bin/sh
# A program that keeps redrawing, the way an agent's prompt does while it works.
#
# Two things matter here. The path is placed a word at a time with absolute columns rather than
# written in sequence, which is what a real agent transcript looks like. And the screen never
# stops rendering afterwards: the status line ticks faster than the pause the path scan used to
# wait for, so waiting for the output to settle meant waiting forever.
FILE="$1"
printf '\033[2J'
printf '\033[5;1H\342\217\272'
printf '\033[5;3HSaved\033[9Gto\033[12G%s' "$FILE"
i=0
while [ "$i" -lt 300 ]; do
  printf '\033[8;1H\033[Kworking %s  esc to interrupt' "$i"
  i=$((i + 1))
  sleep 0.1
done
