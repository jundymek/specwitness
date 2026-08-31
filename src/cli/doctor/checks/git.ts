/**
 * Shared git vocabulary for the checks that shell out to it.
 *
 * The failure descriptions live in one place so that "git is not installed",
 * "git hung" and "git said no" stay distinguishable wherever they surface —
 * telling those three apart is most of doctor's value on a broken machine.
 */

import type { RunOutcome } from '../effects.js';

/**
 * A bound on every git call. Doctor must never hang: a repository in a strange
 * state (a stale lock, a network-backed filesystem) is exactly the situation a
 * diagnostic tool is run in, so a timeout is a diagnosis, not an accident.
 */
export const GIT_TIMEOUT_MS = 5_000;

/**
 * Describes an infrastructural git failure, or `undefined` when git ran and
 * answered — including when it answered "no" with a non-zero exit, which is a
 * result for the caller to interpret rather than a failure of git itself.
 */
export function describeGitFailure(outcome: RunOutcome): string | undefined {
  if (outcome.notFound) {
    return 'git not found on PATH; install git and reopen your shell';
  }
  if (outcome.timedOut) {
    return `git timed out after ${GIT_TIMEOUT_MS}ms; check for a stale index.lock or a hung filesystem`;
  }
  return undefined;
}

