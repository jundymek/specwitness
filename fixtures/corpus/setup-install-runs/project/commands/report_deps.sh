#!/bin/sh
# The declared command the plan's shell probe runs, for the corpus fixture
# `setup-install-runs`.
#
# It reads back what the install wrote. The gate already proved the marker
# exists; this proves the PROBES stage, four stages later, still sees the tree
# the install prepared — a gate and a probe run in the same worktree, and a
# fixture that only checked the gate would not have said so.
set -eu

cat vendor/installed.txt
