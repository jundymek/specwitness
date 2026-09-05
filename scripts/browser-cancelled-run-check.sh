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
# ⚠️ WHICH BASELINE, AND WHY IT CAN BE INHERITED.
#
# By default this check takes its own "before" snapshot. But in CI it is handed the JOB-level
# baseline, taken before anything at all ran, and that is what closes a real gap the review
# raised twice.
#
# The gap: the normal-exit step reports a survivor and, being unable to establish run-specific
# ownership, does not reap it (see the P1 that removed path-based ownership). If this check then
# took a FRESH baseline, that survivor would be in it, subtracted, and never mentioned again -
# the job would end quietly carrying a leak that a step had already found. Reported-then-hidden.
#
# Inheriting the job baseline means anything the suites leaked is still outside the baseline here
# and is still reported by the final scan. So the job ends LOUD rather than silent, without this
# script acquiring the authority to kill processes it cannot prove are its own.
baseline="${BASELINE_FILE:-${work}/baseline.txt}"

leak_check_args=(scripts/browser-leak-check.mjs)
if [ -n "${BROWSERS_PATH}" ]; then
  leak_check_args+=(--browsers-path "${BROWSERS_PATH}")
fi
# NOTE: no path-based ownership flag here. A P1 on this branch established that a shared browsers
# registry or workspace path is not run-specific and must not authorise a signal. This check reaps
# only the groups it spared itself, passed explicitly as --owned-pgid below.

echo "==> [1/5] recording what is already running"
if [ -n "${BASELINE_FILE:-}" ] && [ -s "${BASELINE_FILE}" ]; then
  echo "    inheriting the job baseline from ${BASELINE_FILE} - anything the suites leaked stays visible"
else
  node "${leak_check_args[@]}" --write-baseline "${baseline}" --label "before the cancelled run" || {
    echo "ERROR: could not record a baseline; the cancelled-run check cannot interpret anything without one" >&2
    exit 1
  }
fi

echo "==> [2/5] starting ${SUITE} and waiting for a real browser"
# ⚠️ DEFINED BEFORE THE RUNNER LAUNCHES, AND THEREFORE BEFORE THE TRAP IS ARMED.
# Raised as a P2 on this branch: the trap was armed immediately after the runner started but
# this function was defined further down, so a cancellation landing in that window would have
# called an undefined command and reaped nothing - defeating the cancellation safety the trap
# had just been added to provide. A cleanup handler may not depend on code that runs after it
# becomes reachable.
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

pnpm exec vitest run "${SUITE}" >"${work}/run.log" 2>&1 &
runner_pid=$!

# ⚠️ THE ORPHAN THIS SCRIPT DELIBERATELY CREATES MUST NOT OUTLIVE THE SCRIPT.
#
# Raised as a P1 on this branch, and it is the recursive version of the bug this whole check
# exists to find: the workflow sets `cancel-in-progress: true`, so a superseded push CANCELS THIS
# STEP - routinely - and if that lands after the detached group has been spared but before the
# explicit reap at the end, the script leaves behind exactly the browser tree it created on
# purpose. The same holds for an unexpected shell error or a TERM.
#
# So the reap is installed as a trap the moment the runner exists, rather than trusted to
# straight-line execution reaching the bottom of the file. On a normal run it fires after
# everything has already been reaped and finds nothing; being idempotent is the point.
#
# The exit status is captured first and re-raised last, so the trap cannot turn a failing check
# into a passing one - a leak that had to be reaped is still a leak, here as everywhere else.
cleanup() {
  status=$?
  trap - EXIT INT TERM

  if [ -n "${runner_pid:-}" ]; then
    for pid in $(descendants "${runner_pid}" 2>/dev/null); do
      kill -KILL "${pid}" 2>/dev/null
    done
  fi

  # Anything ProcessRunner detached into its own group is out of reach of the tree kill above,
  # which is the whole reason it survives a cancellation. Hand those groups to the scanner, whose
  # ownership guards and refusals apply exactly as they do on the normal path.
  if [ -n "${spared:-}" ]; then
    trap_owned=""
    for entry in ${spared}; do
      trap_pgid="${entry#*:}"
      case "${trap_pgid}" in
        ''|*[!0-9]*) continue ;;
      esac
      trap_owned="${trap_owned} --owned-pgid ${trap_pgid}"
    done
    if [ -n "${trap_owned}" ]; then
      node "${leak_check_args[@]}" --reap ${trap_owned} \
        --label "emergency cleanup as this check exited" >/dev/null 2>&1
    fi
  fi

  rm -rf "${work}" 2>/dev/null
  exit ${status}
}
trap cleanup EXIT INT TERM


# ⚠️ THE LAUNCH PREDICATE, AND WHY IT IS NARROWER THAN IT LOOKS LIKE IT SHOULD BE.
#
# Reported as a P1 on this branch: the first version accepted ANY non-zero exit from the scanner
# as proof that a browser had appeared. Two different things made that wrong, and either one
# alone would have made this whole check able to pass vacuously — which is the single thing it
# exists to prevent.
#
#   1. The scanner deliberately matches the detached Playwright runner (`@playwright/test/cli.js`)
#      because leaking it is a leak. But that process starts BEFORE chromium, so on a slow runner
#      the kill could land after the runner started and before any browser existed.
#   2. The scanner also exits non-zero when it CANNOT LOOK — a `ps` that fails, a missing
#      baseline. A broken `ps` therefore read as a positive detection. (The Codex sandbox, which
#      cannot spawn `ps` at all, produces exactly that.)
#
# So: `--browsers-only` excludes the runner, and the exit code is now discriminated — 1 means
# survivors were FOUND, 3 means the scan could not look, which is the product's own taxonomy
# (ADR-002 / AD-6). Only a 1 counts as a launch; a 3 aborts loudly rather than proceeding.
launched=no
deadline=$((SECONDS + LAUNCH_TIMEOUT_SECONDS))
while [ ${SECONDS} -lt ${deadline} ]; do
  node "${leak_check_args[@]}" --baseline "${baseline}" --browsers-only \
    --label "waiting for a real browser" >/dev/null 2>&1
  probe=$?
  if [ ${probe} -eq 1 ]; then
    launched=yes
    break
  fi
  if [ ${probe} -eq 3 ]; then
    echo "ERROR: the survival scan cannot read a process listing on this machine, so this check cannot observe a launch" >&2
    echo "HINT: 'ps' is unavailable or not permitted here. This check needs a real process table; it will not guess." >&2
    for pid in $(descendants "${runner_pid}"); do
      kill -KILL "${pid}" 2>/dev/null
    done
    exit 3
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
vanished=""
for pid in $(descendants "${runner_pid}"); do
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
  # ⚠️ AN EMPTY PGID MEANS THE PROCESS IS ALREADY GONE, NOT THAT IT WAS DETACHED.
  # The descendant walk and this lookup are separate `ps` calls, so a short-lived child can
  # exit between them. Counting those as SPARED made the orphan evidence wrong in the
  # direction that flatters it - CI run 33913171525 reported eight orphans of which seven
  # "exited on their own after 0s", because seven of them had already exited before the kill.
  # It also emitted `--owned-pgid` with no value, which swallowed the following `--label` and
  # failed the step with exit 64. Both halves came from the same missing branch.
  if [ -z "${pgid}" ]; then
    vanished="${vanished} ${pid}"
    continue
  fi
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
echo "    already gone before the kill (no pgid to read; NOT orphans):${vanished:- none}"
wait "${runner_pid}" 2>/dev/null

# WARNING: A DEAD PID IS NOT A HANDLE, AND KEEPING ONE IS HOW THE TRAP TURNS DESTRUCTIVE.
#
# Raised as a P2 on this branch, and it is the THIRD time pid reuse has bitten this story - after
# the baseline identity and the three-second tolerance. The runner has now been killed and
# reaped, so runner_pid refers to nothing. The orphan wait below can run for up to WAIT_SECONDS,
# and if the OS hands that pid to an unrelated process in the meantime, the EXIT trap would walk
# ITS descendants and SIGKILL a process tree that has nothing to do with this check.
#
# Cleared rather than verified: there is no handle left worth keeping. The trap still reaps the
# detached groups through `spared`, which is what actually needs cleaning up from here on, and
# those are named by pgid with the scanner ownership guards in front of them.
runner_pid=""

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

# The tighter ownership bound: this check KNOWS which groups it spared, so it names them. The
# scanner already refuses to signal anything that did not come out of the browsers registry, but
# an exact list beats a good heuristic when the caller has one - and this script is the one
# documented as runnable locally, where an unowned kill would hit the operator own browser.
owned_args=""
for entry in ${spared}; do
  entry_pgid="${entry#*:}"
  # Defensive: never emit a valueless flag. An empty pgid here would consume the next
  # argument as its value - which is exactly how this step failed with exit 64.
  case "${entry_pgid}" in
    ''|*[!0-9]*) continue ;;
  esac
  owned_args="${owned_args} --owned-pgid ${entry_pgid}"
done

node "${leak_check_args[@]}" \
  --baseline "${baseline}" \
  --wait-seconds "${remaining}" \
  --write-survivors "${survivors}" \
  --reap ${owned_args} \
  --label "after a run killed with SIGKILL (no afterEach ran)"
result=$?

echo "==> [5/5] re-scanning after the reap"
node "${leak_check_args[@]}" --baseline "${baseline}" \
  --label "after reaping whatever this check left behind" || true

# `exit` fires the EXIT trap, which performs the teardown and re-raises this status.
exit ${result}
