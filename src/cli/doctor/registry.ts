/**
 * The doctor check registry (FR-3, AC3).
 *
 * This is the extension seam Epic 2 story 2.7 plugs provider checks into —
 * binary discovery, non-interactive mode, auth readiness, billing-risk env
 * vars — without editing a single check written here. That story registers its
 * checks the same way the built-ins are registered, and gets ordering,
 * isolation and reporting for free.
 *
 * Three properties make it safe to extend:
 *
 * 1. ORDER IS REGISTRATION ORDER. Checks run sequentially and results come back
 *    in the order they were registered, never in completion order, so the
 *    `--json` shape is stable enough to snapshot (AC2).
 * 2. CHECKS ARE ISOLATED. A check that throws reports `fail` with the error's
 *    detail; every other check still runs. Doctor's whole job is diagnosing a
 *    broken environment, so one broken probe must not hide the other six.
 * 3. IDS ARE UNIQUE. Registering a duplicate id throws rather than shadowing,
 *    so a mis-plugged provider check fails loudly at wiring time.
 *
 * There is no module-level registry instance: a registry is created per
 * invocation and passed around (spine Consistency Conventions, "no global
 * mutable state").
 */

import type { DoctorContext } from './context.js';

/** How a single check came out. `warn` never affects the exit code. */
export type CheckStatus = 'pass' | 'warn' | 'fail';

/** What a check returns. The registry adds `id` and `required`. */
export interface CheckResult {
  readonly status: CheckStatus;
  readonly detail: string;
}

/**
 * One diagnostic.
 *
 * `required: true` means a `fail` makes doctor exit 3. Optional checks report
 * `warn` and leave the exit code alone — that is what keeps a missing agent CLI
 * (Epic 2) or an unprovisioned Playwright (Epic 5) from being fatal to a
 * diagnostic command.
 */
export interface DoctorCheck {
  readonly id: string;
  readonly required: boolean;
  run(ctx: DoctorContext): Promise<CheckResult>;
}

/** A check result with the identity the registry knows about. */
export interface DoctorCheckReport extends CheckResult {
  readonly id: string;
  readonly required: boolean;
}

export interface DoctorRegistry {
  /** Appends a check. Throws on a duplicate id. */
  register(check: DoctorCheck): void;
  /** Runs every registered check, in registration order. Never throws. */
  runAll(ctx: DoctorContext): Promise<DoctorCheckReport[]>;
}

/**
 * Describe a thrown value for a check's `detail`.
 *
 * Accepts `unknown` because a check may throw anything; a diagnostic tool that
 * crashes while diagnosing is worse than one that reports the crash.
 */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message;
  }
  if (typeof thrown === 'string') {
    return thrown;
  }
  try {
    return JSON.stringify(thrown) ?? String(thrown);
  } catch {
    return String(thrown);
  }
}

export function createRegistry(initial: readonly DoctorCheck[] = []): DoctorRegistry {
  const checks: DoctorCheck[] = [];
  const ids = new Set<string>();

  function register(check: DoctorCheck): void {
    if (ids.has(check.id)) {
      throw new Error(
        `duplicate doctor check id "${check.id}": ids identify checks in --json output and must be unique`,
      );
    }
    ids.add(check.id);
    checks.push(check);
  }

  for (const check of initial) {
    register(check);
  }

  return {
    register,
    async runAll(ctx: DoctorContext): Promise<DoctorCheckReport[]> {
      const reports: DoctorCheckReport[] = [];

      // Sequential on purpose. The checks are cheap, and running them in order
      // keeps output deterministic and avoids a burst of concurrent subprocess
      // spawns and port binds on a machine that may already be unhealthy.
      for (const check of checks) {
        try {
          const result = await check.run(ctx);
          reports.push({ id: check.id, required: check.required, ...result });
        } catch (error) {
          reports.push({
            id: check.id,
            required: check.required,
            status: 'fail',
            detail: `check failed to run: ${describeThrown(error)}`,
          });
        }
      }

      return reports;
    },
  };
}
