#!/bin/sh
# The Deterministic Gate for the corpus fixture `setup-install-runs`.
#
# ⚠️ THIS GATE IS THE FIXTURE'S DISCRIMINATOR. It passes only if the setup stage
# already ran `setup.install` in this same worktree. Before story 6.11 the setup
# stage was a placeholder that reported `ok` and executed nothing, so this gate
# would exit 1 — the run would be FAIL at exit 1, not the PASS at exit 0 that
# `expected.json` pins.
#
# That inversion is why the fixture exists: an install that never happened,
# reported as the branch being wrong.
set -eu

if [ ! -f vendor/installed.txt ]; then
  echo "vendor/installed.txt is missing: the setup stage did not run setup.install" >&2
  exit 1
fi

if ! grep -q 'deps-installed 1.0.0' vendor/installed.txt; then
  echo "vendor/installed.txt does not carry the expected marker" >&2
  exit 1
fi

echo "dependency marker present"
