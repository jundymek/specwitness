#!/bin/sh
# The declared command the plan's shell probe would run, for the corpus fixture
# `setup-install-fails`.
#
# It reads a file that is COMMITTED rather than produced, so it would succeed on
# any tree. Like the gate beside it, it must never run: an infrastructure error
# at `setup` stops the pipeline long before the probes stage, and every criterion
# is therefore reported by the aggregate stage never running at all.
set -eu

cat manifest.txt
