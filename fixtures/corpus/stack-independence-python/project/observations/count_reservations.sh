#!/bin/sh
# The OBSERVATION command: a POSIX shell script that reads persisted project
# state and prints one JSON object to stdout.
#
# ===========================================================================
# THIS IS THE HIGHEST-PRIVILEGE THING STORY 6.4 ADDS, AND IT IS FIVE LINES.
# ===========================================================================
# It is deliberately short, deliberately readable, and it READS state rather
# than changing it. It touches exactly one path -- the state file named on
# its command line -- and it reaches no network, spawns nothing, and reads
# no environment variable.
#
# WHY THE OBSERVATION SURFACE IS THE INTERESTING ONE HERE. An http probe
# asks "did the endpoint answer correctly?"; an observation asks "and what
# did that do to the world?" (brief section 35). It is the surface that reads
# PROJECT STATE, which makes it the one most likely to hide an assumption
# about what a project looks like. `src/surfaces/observation.ts:16-18` names
# stack neutrality as its design constraint -- SpecWitness names no database,
# no ORM and no query language; the project declares a command, it emits JSON
# on stdout, and SpecWitness asserts over the JSON. That is the entire
# abstraction, and this script is the first evidence that it holds for a
# project that is not a Node project.
#
# THE CONTRACT THIS SCRIPT MUST MEET (Q35, enforced by the executor): exit 0
# AND print a JSON OBJECT to stdout. Violating either is classified as an
# `execError` -- the environment being broken -- rather than as a failure of
# the branch under verification. So a missing state file is reported as zero
# reservations, NOT as an error: before anything has been reserved, "no file"
# is the honest answer and the before-snapshot legitimately sees it.
#
# ASCII only, and no dependency on a locale, for the reason given in
# app/inventory_service.py.

set -eu

STATE_PATH="$1"

if [ -f "$STATE_PATH" ]; then
  # `wc -l` pads its output with spaces on some platforms (notably macOS), so
  # the count is stripped through `tr` before it is interpolated into JSON.
  # An unstripped value would emit `{"reservedCount":        1}`, which is
  # still valid JSON -- but relying on that would be relying on a coincidence,
  # and this fixture runs on two platforms.
  COUNT=$(wc -l < "$STATE_PATH" | tr -d ' \t')
else
  COUNT=0
fi

printf '{"reservedCount": %s}\n' "$COUNT"
