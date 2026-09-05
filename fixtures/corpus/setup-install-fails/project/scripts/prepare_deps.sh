#!/bin/sh
# The declared `setup.install` command for the corpus fixture
# `setup-install-fails`. IT FAILS ON PURPOSE.
#
# It stands in for the ordinary way a real install fails — a lockfile that does
# not match the manifest, a dependency that cannot be satisfied — without doing
# anything a real install does: no network, no package manager, no ecosystem.
# It writes nothing and reads nothing outside the verification worktree.
#
# Exit 7 rather than 1: a distinctive code, so `expected.json` can pin that the
# run reported the child's REAL exit status rather than a normalised one.
set -eu

echo "lockfile does not match the manifest" >&2
exit 7
