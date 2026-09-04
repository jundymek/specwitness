#!/usr/bin/env bash
#
# What survives a browser run that is KILLED OUTRIGHT? (story 6.9, AC4.)
#
# ⚠️ WHY THIS EXISTS, AND WHY THE NORMAL RUN'S SCAN IS NOT ENOUGH.
#
# Epic 4's retrospective (§2 observation 8) records the fact this check is built on: **when a
# test run is killed outright, no `afterEach` executes at all.** Every clean-up in
# `tests/integration/surfaces/helpers/browser-fixture.ts` is therefore irrelevant in exactly
# the case that matters most — and that file's own header names the stake: *"A leaked browser
# tree is the worst leak this product can produce, and it lives until reboot."*
#
# A CI job is cancelled routinely: the workflow's `concurrency` block has
# `cancel-in-progress: true`, so every superseded push kills a browser run mid-flight on a
# SHARED runner. So this measures it: start a browser suite, wait until a real browser is up,
# kill the runner and every worker it forked with SIGKILL, and then watch what is left.
#
# ⚠️ IT MUST NOT BE ABLE TO PASS VACUOUSLY. If no browser process ever appears, this script
# FAILS instead of reporting a clean kill: "we killed a run that had not started a browser" is
# not evidence about browser leaks, and a check that quietly passes when its premise did not
# hold is the shape of defect this whole story exists to remove.
#
# ⚠️ AND IT CLEANS UP AFTER ITSELF. Because it deliberately creates an orphan, a survivor it
# merely reported would be a browser tree this job left on a shared runner. Step 5 reaps what
# step 4 found — after the evidence is captured, and without changing the exit code, so a leak
# that had to be reaped still fails the step.
#
# ⚠️ WHAT IS DELIBERATELY *NOT* KILLED, AND WHY THE FIRST VERSION OF THIS SCRIPT WAS WRONG.
#
# `src/infra/process-runner.ts` spawns `detached: true` (line ~523), so Playwright and the
# browser it launches live in their OWN process group — while remaining, in the ppid chain,
# descendants of the runner. The first version of this script killed the whole DESCENDANT
# CLOSURE, which killed Playwright too and reported "no survivors" in 0.1s. That is a harsher
# kill than anything a cancellation performs, and it measured the wrong thing: it proved that
# killing the browser kills the browser.
#
# A CI cancellation kills the step's PROCESS GROUP. A detached child is in a different group,
# so it SURVIVES — orphaned, with the parent that would have enforced `ProcessRunner`'s timeout
# and torn the group down now gone, and only Playwright's own bounds left. That is the state
# that can leak, so that is the state this reproduces: every descendant sharing the runner's
# process group is killed, and anything `detached` into its own group is deliberately left to
# fend for itself.
#
# ⚠️ THIS IS A CI CHECK, AND ON A DEVELOPER MACHINE IT WILL BE NOISY. The final scan reports
# any browser process that appeared since the baseline, and on a laptop that includes whatever
# renderer the operator's own browser started while the check was waiting. A CI runner starts
# no browsers of its own, which is what makes the diff conclusive there and only indicative
# here. Run it locally to exercise the mechanics; believe its verdict on the runner.
#
# Usage: scripts/browser-cancelled-run-check.sh
#   BROWSERS_PATH   the browser registry to match on (optional; patterns still apply)
#   SUITE           the suite to kill (default: the largest browser suite)
#   WAIT_SECONDS    how long to wait for orphans to go away (default 180)

set -uo pipefail

SUITE="${SUITE:-tests/integration/surfaces/browser.test.ts}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"
BROWSERS_PATH="${BROWSERS_PATH:-}"
# How long to wait for a browser to come up before declaring the premise unmet.
LAUNCH_TIMEOUT_SECONDS=180

work="$(mktemp -d)"
baseline="${work}/baseline.txt"

leak_check_args=(scripts/browser-leak-check.mjs)
if [ -n "${BROWSERS_PATH}" ]; then
  leak_check_args+=(--browsers-path "${BROWSERS_PATH}")
fi

echo "==> [1/5] recording what is already running"
node "${leak_check_args[@]}" --write-baseline "${baseline}" --label "before the cancelled run" || {
  echo "ERROR: could not record a baseline; the cancelled-run check cannot interpret anything without one" >&2
  exit 1
}

echo "==> [2/5] starting ${SUITE} and waiting for a real browser"
pnpm exec vitest run "${SUITE}" >"${work}/run.log" 2>&1 &
runner_pid=$!

# Every descendant of the runner, breadth-first, as a space-separated list.
#
# `pkill -P` only reaches DIRECT children and vitest runs its tests in a forked worker pool, so
# the closure has to be walked or the workers — the processes actually holding the browser's
# parent handle — would survive the "kill".
#
# Written with plain strings rather than arrays and `mapfile`: macOS ships bash 3.2, which has
# neither, and this script has to be runnable by the author before it is trusted on a runner.
descendants() {
  frontier="$1"
  found=""
  while [ -n "${frontier}" ]; do
    next=""
    for pid in ${frontier}; do
      found="${found} ${pid}"
      children="$(ps -eo pid=,ppid= | awk -v parent="${pid}" '$2 == parent { print $1 }' | tr '\n' ' ')"
      next="${next} ${children}"
    done
    frontier="$(echo "${next}" | tr -s ' ' | sed 's/^ //;s/ $//')"
  done
  echo "${found}" | tr -s ' ' | sed 's/^ //;s/ $//'
}

launched=no
deadline=$((SECONDS + LAUNCH_TIMEOUT_SECONDS))
while [ ${SECONDS} -lt ${deadline} ]; do
  if ! node "${leak_check_args[@]}" --baseline "${baseline}" --label "waiting for launch" \
      >/dev/null 2>&1; then
    launched=yes
    break
  fi
  if ! kill -0 "${runner_pid}" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "${launched}" != yes ]; then
  echo "ERROR: no browser process ever appeared, so there is nothing to say about what a cancelled run leaks" >&2
  echo "HINT: this check refuses to report a clean kill it did not observe. Look at ${work}/run.log — the suite may have skipped, or failed before its first launch." >&2
  tail -40 "${work}/run.log" >&2
  kill -KILL "${runner_pid}" 2>/dev/null
  exit 1
fi

echo "==> [3/5] a browser is up; SIGKILLing the runner's process GROUP"
# SIGKILL, not SIGTERM: a cancelled run must execute NO cleanup at all — that is Epic 4 retro
# §2 observation 8's fact, and the whole premise of this check.
runner_pgid="$(ps -o pgid= -p "${runner_pid}" | tr -d ' ')"
killed=""
spared=""
for pid in $(descendants "${runner_pid}"); do
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
  if [ "${pgid}" = "${runner_pgid}" ]; then
    killed="${killed} ${pid}"
    kill -KILL "${pid}" 2>/dev/null
  else
    # Detached into its own group by ProcessRunner. A group kill would not reach it, so
    # neither does this — leaving exactly the orphan a cancelled CI job leaves behind.
    #
    # Encoded WITHOUT spaces (`pid:pgid`): this list is walked with word splitting, and a
    # "1234 (pgid 1234)" form split into two tokens and reported the same orphan twice.
    spared="${spared} ${pid}:${pgid}"
  fi
done
echo "    killed (same group, pgid ${runner_pgid}):${killed:- none}"
echo "    SPARED, as pid:pgid (detached into their own group, as a real cancellation would):${spared:- none}"
wait "${runner_pid}" 2>/dev/null

# What actually became of each orphan, measured rather than inferred. This is the number the
# PR body has to carry: "how long does a cancelled browser run leak for?" A spared process that
# exits on its own says the detached tree is self-limiting after all; one that is still there
# says it is not, and names what has to be reaped.
echo "==> [3b/5] the fate of each spared orphan"
if [ -z "${spared}" ]; then
  echo "    none were spared - nothing was detached into its own group at kill time"
else
  for entry in ${spared}; do
    orphan="${entry%%:*}"
    waited=0
    while kill -0 "${orphan}" 2>/dev/null && [ ${waited} -lt "${WAIT_SECONDS}" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "${orphan}" 2>/dev/null; then
      echo "    orphan ${orphan}: STILL ALIVE after ${waited}s"
      ps -o pid=,pgid=,etime=,args= -p "${orphan}" 2>/dev/null | cut -c1-160
    else
      echo "    orphan ${orphan}: exited on its own after ${waited}s"
    fi
  done
fi

echo "==> [4/5] what survived?"
survivors="${work}/survivors.txt"
node "${leak_check_args[@]}" \
  --baseline "${baseline}" \
  --wait-seconds "${WAIT_SECONDS}" \
  --write-survivors "${survivors}" \
  --label "after a run killed with SIGKILL (no afterEach ran)"
result=$?

# ⚠️ REAP WHAT WE FOUND — raised as a P1 by the Codex review of this branch, and correct.
#
# This script DELIBERATELY CREATES an orphan. Detecting one and walking away would leave a
# browser tree running on a shared runner — the exact condition AC4 exists to prevent, caused
# by the check for it. `browser-fixture.ts`: "A leaked browser tree is the worst leak this
# product can produce, and it lives until reboot."
#
# Ordered AFTER the scan on purpose: the evidence is printed and written first, so reaping can
# never erase the finding. The exit code is captured before this runs and is NOT changed by it —
# a leak that had to be reaped is still a leak, and still fails the step.
#
# SIGTERM to the GROUP, a grace period, then SIGKILL to the GROUP: the same shape as
# `terminateProcessGroup` in src/infra/process-runner.ts, and to the group rather than the pid
# because a browser is a tree.
echo "==> [5/5] reaping anything that survived"
if [ ! -s "${survivors}" ]; then
  echo "    nothing to reap"
else
  own_pgid="$(ps -o pgid= -p $$ | tr -d ' ')"
  reaped=""
  while read -r pid pgid; do
    [ -z "${pid:-}" ] && continue
    # Never signal our own group: `kill -<own pgid>` would kill this script mid-reap.
    if [ "${pgid}" = "${own_pgid}" ]; then
      echo "    refusing to signal process group ${pgid}: it is this script's own"
      continue
    fi
    case " ${reaped} " in *" ${pgid} "*) continue ;; esac
    reaped="${reaped} ${pgid}"
    echo "    kill -TERM -${pgid}"
    kill -TERM "-${pgid}" 2>/dev/null
  done < "${survivors}"

  sleep 2

  for pgid in ${reaped}; do
    if kill -0 "-${pgid}" 2>/dev/null; then
      echo "    still there; kill -KILL -${pgid}"
      kill -KILL "-${pgid}" 2>/dev/null
    fi
  done

  echo "    re-scanning after the reap"
  node "${leak_check_args[@]}" --baseline "${baseline}" \
    --label "after reaping the leak this check created" || true
fi

rm -rf "${work}"
exit ${result}
