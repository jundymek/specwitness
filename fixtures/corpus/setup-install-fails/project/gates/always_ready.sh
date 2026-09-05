#!/bin/sh
# The Deterministic Gate for the corpus fixture `setup-install-fails`.
#
# ⚠️ IT MUST NEVER RUN, AND IT WOULD PASS IF IT DID. Both halves matter. A gate
# that could fail would give the fixture a second route to a non-PASS outcome,
# and then exit 3 would no longer prove that the INSTALL was what stopped the
# run. A gate that passes and is skipped is the only shape that isolates the
# claim.
#
# The pipeline stops at `setup` (stage 4) and records `gates` (stage 5) as
# `skipped`, so nothing here is spawned. `expected.json` pins that structurally:
# the run's evidence must contain no `gate` kind at all.
set -eu

echo "ready"
