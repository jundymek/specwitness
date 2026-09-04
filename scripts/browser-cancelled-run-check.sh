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
# merely reported would be a browser tree this job left on a shared runner. Step 4 passes
# `--reap` to the scanner, which terminates the surviving process GROUPS after the evidence is
# captured and without changing the exit code, so a leak that had to be reaped still fails the
# step. Step 5 re-scans so the log says what was left afterwards rather than asserting it.
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

  # ⚠️ TEAR DOWN THE WHOLE TREE ON THE WAY OUT. Raised as a P2 by the Codex review of this
  # branch, and it is this story's own defect class for the third time: the early-exit path
  # killed only the background `pnpm` pid, so vitest workers and anything ProcessRunner had
  # already detached survived — precisely when the cleanup check is the thing that is failing,
  # and before any reaping pass could run. Kill every descendant, then let the scanner reap the
  # detached groups by group id.
  for pid in $(descendants "${runner_pid}"); do
    kill -KILL "${pid}" 2>/dev/null
  done
  node "${leak_check_args[@]}" --baseline "${baseline}" --reap \
    --label "after a check that never observed a browser launch" || true
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
# Declared here so step 4 can subtract it from the shared deadline even when nothing was spared.
waited=0
if [ -z "${spared}" ]; then
  echo "    none were spared - nothing was detached into its own group at kill time"
else
  # ⚠️ ONE SHARED DEADLINE, NOT ONE PER ORPHAN. Raised as a P1 by the Codex review of this
  # branch, and correct on both counts. Waiting up to WAIT_SECONDS separately for every pid
  # makes the worst case N * 180s for a chromium tree that can hold many processes — minutes to
  # tens of minutes, approaching the job timeout. And it corrupted the MEASUREMENT, which is
  # what this step exists to produce: the second orphan's "exited after 0s" was counted from
  # after the first orphan's wait had already elapsed, so it had been dying for 180s unobserved.
  # All orphans are now polled together against one clock, and each reported time is measured
  # from the kill.
  pending="$(echo "${spared}" | tr ' ' '\n' | sed 's/:.*//' | grep -v '^$' | tr '\n' ' ')"
  waited=0
  while [ -n "$(echo "${pending}" | tr -d ' ')" ] && [ ${waited} -lt "${WAIT_SECONDS}" ]; do
    still=""
    for orphan in ${pending}; do
      if kill -0 "${orphan}" 2>/dev/null; then
        still="${still} ${orphan}"
      else
        echo "    orphan ${orphan}: exited on its own after ${waited}s"
      fi
    done
    pending="$(echo "${still}" | tr -s ' ' | sed 's/^ //;s/ $//')"
    [ -z "${pending}" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  for orphan in ${pending}; do
    echo "    orphan ${orphan}: STILL ALIVE after ${waited}s"
    ps -o pid=,pgid=,etime=,args= -p "${orphan}" 2>/dev/null | cut -c1-160
  done
fi

echo "==> [4/5] what survived, and reaping it"
# ⚠️ `--reap` IS THE POINT, not a nicety. This script DELIBERATELY CREATES an orphan, so
# detecting one and walking away would leave a browser tree running on a shared runner - the
# exact condition AC4 exists to prevent, caused by the check for it. `browser-fixture.ts`:
# "A leaked browser tree is the worst leak this product can produce, and it lives until reboot."
#
# The reaping lives in browser-leak-check.mjs rather than here, and that is deliberate: it
# signals process GROUPS, so it carries the same refusals `assertSignallableProcessGroup` makes
# (src/infra/process-runner.ts:364-376) - an integer greater than 1, never our own group,
# because `kill -TERM -1` signals every process on the machine. Those refusals are the
# security-critical half of this story and they belong somewhere a test can reach them, which a
# shell loop was not. `tests/integration/browser-leak-check.test.ts` exercises all three.
#
# Reaping runs after the report and does NOT change the exit code: a leak that had to be reaped
# is still a leak, and still fails this check.
survivors="${work}/survivors.txt"

# ⚠️ THE REMAINING BUDGET, NOT A SECOND FULL ONE. Raised as a P2 by the Codex review of this
# branch: step 3b has already polled the orphans for up to WAIT_SECONDS, and passing
# WAIT_SECONDS again here made the worst case 360s with the configured 180 — and, worse, let the
# check report success for a process that had survived well past the threshold it is supposed to
# enforce. One deadline for the whole check, shared across both waits.
remaining=$(( WAIT_SECONDS - waited ))
[ ${remaining} -lt 0 ] && remaining=0
echo "    ${waited}s of the ${WAIT_SECONDS}s budget already spent; ${remaining}s left for this scan"

node "${leak_check_args[@]}" \
  --baseline "${baseline}" \
  --wait-seconds "${remaining}" \
  --write-survivors "${survivors}" \
  --reap \
  --label "after a run killed with SIGKILL (no afterEach ran)"
result=$?

echo "==> [5/5] re-scanning after the reap"
node "${leak_check_args[@]}" --baseline "${baseline}" \
  --label "after reaping whatever this check left behind" || true

rm -rf "${work}"
exit ${result}
