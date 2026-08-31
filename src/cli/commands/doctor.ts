import type { Command } from 'commander';

import { InfraError } from '../../domain/errors.js';
import { BUILTIN_CHECKS } from '../doctor/checks/index.js';
import { createDoctorContext } from '../doctor/context.js';
import { createRegistry, type DoctorCheck, type DoctorCheckReport } from '../doctor/registry.js';
import { hasRequiredFailure, renderHuman, renderJson } from '../doctor/render.js';

/**
 * `specwitness doctor` — runtime and project diagnostics (FR-3, UJ-4).
 *
 * Doctor exists so that an environment problem is never mistaken for a product
 * failure. It reports every check as pass/warn/fail and exits 3 — the
 * environment/SpecWitness class (ADR-002) — when a REQUIRED check fails. Never
 * 1: that is a product FAIL and would tell an automation the code is broken when
 * the machine is. Never 2: that is NEEDS_HUMAN, a verification outcome doctor
 * does not produce.
 *
 * EVERY CHECK ALWAYS RUNS, and the full report is printed BEFORE the failure is
 * thrown. Stopping at the first failure would hand back one problem at a time,
 * which is the slowest way to fix an environment.
 *
 * The exit code is produced by throwing, not by writing one: `cli/exit.ts` is
 * the only module in the repository permitted to set a process exit code, and
 * story 1.1's scan test enforces that mechanically.
 *
 * STREAM DISCIPLINE (AC2). In `--json` mode stdout carries the JSON document and
 * nothing else, so `specwitness doctor --json | jq` works with no filtering; the
 * human rendering goes to stderr, where the `ERROR:`/`HINT:` pair also lands.
 *
 * @param checks the checks to run. Defaults to the built-ins; story 2.7 passes
 *   its provider checks here — the production extension point, so that adding a
 *   check requires editing neither this command nor any existing check.
 */
export function register(program: Command, checks: readonly DoctorCheck[] = BUILTIN_CHECKS): void {
  program
    .command('doctor')
    .description('check the runtime and project configuration')
    .option('--json', 'emit a machine-readable report on stdout (stable schema)')
    .action(async (options: { json?: boolean }) => {
      const ctx = createDoctorContext({ projectRoot: process.cwd() });
      const registry = createRegistry(checks);
      const reports = await registry.runAll(ctx);

      // Doctor is not a run: it produces no run record and no run id, so it
      // takes the wall clock directly rather than story 1.6's Clock port, which
      // exists to make run identifiers deterministic in tests.
      const timestamp = new Date().toISOString();

      if (options.json === true) {
        process.stdout.write(renderJson(reports, timestamp));
        process.stderr.write(renderHuman(reports));
      } else {
        process.stdout.write(renderHuman(reports));
      }

      if (hasRequiredFailure(reports)) {
        throw new InfraError(summarizeFailures(reports), 'fix the failing checks and run doctor again');
      }
    });
}

function summarizeFailures(reports: readonly DoctorCheckReport[]): string {
  const failed = reports
    .filter((report) => report.required && report.status === 'fail')
    .map((report) => report.id);

  return `${failed.length} required ${failed.length === 1 ? 'check' : 'checks'} failed: ${failed.join(', ')}`;
}
