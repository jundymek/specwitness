#!/usr/bin/env bash
#
# Story 2.8 AC1 — the reproduction, and then the proof.
#
# The harness runs `pnpm test` from Codex on every push, in the agent's own
# worktree, while the agent is running the suite itself. Two vitest processes
# in one worktree is therefore the normal condition, not an edge case. Before
# this story, `tests/unit/dependency-rules.test.ts` wrote scratch modules with
# fixed names into the real `src/` and cruised the whole tree, so process B saw
# process A's deliberately-violating probe and failed for reasons that had
# nothing to do with the rules.
#
# This script starts two independent OS processes (not two vitest workers —
# `fileParallelism` is a different thing and would not reproduce the defect)
# and fails if either of them fails. It also checks that neither run left
# anything behind under `src/`.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUNS="${RUNS:-1}"
TARGET="${TARGET:-tests/unit/dependency-rules.test.ts}"

# Validate RUNS before it reaches `seq`. `seq` rejects a non-number and prints
# to stderr, but the loop then simply runs zero times and the script reports a
# cheerful PASS having tested nothing — a green that means nothing is worse
# than a red.
case "$RUNS" in
  '' | *[!0-9]*)
    echo "ERROR: RUNS must be a positive integer (got: '$RUNS')" >&2
    exit 64
    ;;
esac
if [ "$RUNS" -lt 1 ]; then
  echo "ERROR: RUNS must be at least 1 (got: '$RUNS')" >&2
  exit 64
fi

if [ ! -e "$TARGET" ]; then
  echo "ERROR: TARGET does not exist: $TARGET" >&2
  exit 64
fi
LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

overall=0

for i in $(seq 1 "$RUNS"); do
  echo "==> iteration $i/$RUNS: two concurrent \`vitest run $TARGET\` in one worktree"

  # What `src/` looked like before these runs; see the AC3 check below.
  before="$(git status --porcelain src/)"

  pnpm vitest run "$TARGET" >"$LOGDIR/a.log" 2>&1 &
  pid_a=$!
  pnpm vitest run "$TARGET" >"$LOGDIR/b.log" 2>&1 &
  pid_b=$!

  wait "$pid_a"; rc_a=$?
  wait "$pid_b"; rc_b=$?

  echo "    run A exit=$rc_a  $(grep -E '^ *Tests +' "$LOGDIR/a.log" | tail -1 | sed 's/^ *//')"
  echo "    run B exit=$rc_b  $(grep -E '^ *Tests +' "$LOGDIR/b.log" | tail -1 | sed 's/^ *//')"

  if [ "$rc_a" -ne 0 ] || [ "$rc_b" -ne 0 ]; then
    overall=1
    echo "    FAILED — output of the failing run(s):"
    # Written as `if` rather than `[ … ] && …`: the short-circuit form yields the
    # test's own exit status, which is a trap waiting for the next person who
    # adds `set -e` or moves the line.
    if [ "$rc_a" -ne 0 ]; then sed 's/^/    A| /' "$LOGDIR/a.log"; fi
    if [ "$rc_b" -ne 0 ]; then sed 's/^/    B| /' "$LOGDIR/b.log"; fi
  fi

  # AC3: no scratch module may survive where real source lives.
  #
  # Compared against a baseline taken before the runs rather than against an
  # empty `git status`. An agent running this script mid-story has legitimate
  # uncommitted work under `src/`, and possibly a stray file from some other
  # process; flagging either would reproduce exactly the defect this story
  # fixes — a red verdict about who else is touching the tree rather than about
  # the rules. What must hold is that the runs ADD nothing.
  after="$(git status --porcelain src/)"
  leftover="$(comm -13 <(printf '%s\n' "$before" | sort) <(printf '%s\n' "$after" | sort))"
  if [ -n "$leftover" ]; then
    overall=1
    echo "    FAILED — the runs added files under src/:"
    echo "$leftover" | sed 's/^/    /'
  fi
done

if [ "$overall" -eq 0 ]; then
  echo "==> PASS: $RUNS iteration(s), both concurrent runs green, no scratch modules left under src/"
else
  echo "==> FAIL: see above"
fi
exit "$overall"
