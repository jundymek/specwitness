/**
 * Doctor's two renderings and the rules that read a report set (AC1, AC2).
 *
 * Pure functions over the reports: no I/O, no exit codes, no clock. The command
 * decides where the text goes and what the process does about it, which keeps
 * both renderings snapshot-testable without spawning anything.
 *
 * TWO DIFFERENT QUESTIONS, deliberately not conflated:
 *
 *   `overallStatus`     — how did the CHECKS come out? Any fail (required or
 *                         not) makes the run's status `fail`; it is a
 *                         description for a reader or a machine.
 *   `hasRequiredFailure` — should the PROCESS fail? Only a required check
 *                          counts. An occupied dev port must not make an
 *                          automation think the environment is unusable.
 */

import type { CheckStatus, DoctorCheckReport } from './registry.js';

/**
 * Pinned at 1. Consumers (the harness, story 2.7's added checks, later
 * reporting) parse this shape, so evolution is additive: add fields, never
 * rename or remove one without bumping this and saying so.
 */
export const DOCTOR_SCHEMA_VERSION = 1;

const GLYPHS: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' };

export function overallStatus(reports: readonly DoctorCheckReport[]): CheckStatus {
  if (reports.some((report) => report.status === 'fail')) {
    return 'fail';
  }
  if (reports.some((report) => report.status === 'warn')) {
    return 'warn';
  }
  return 'pass';
}

/** The exit rule: doctor exits non-zero if and only if a REQUIRED check failed. */
export function hasRequiredFailure(reports: readonly DoctorCheckReport[]): boolean {
  return reports.some((report) => report.required && report.status === 'fail');
}

export function renderJson(reports: readonly DoctorCheckReport[], timestamp: string): string {
  const payload = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    timestamp,
    status: overallStatus(reports),
    // Field order is fixed here rather than spread from the report so the
    // serialized shape does not drift with an internal refactor.
    checks: reports.map((report) => ({
      id: report.id,
      status: report.status,
      required: report.required,
      detail: report.detail,
    })),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderHuman(reports: readonly DoctorCheckReport[]): string {
  const width = Math.max(0, ...reports.map((report) => report.id.length));

  const lines = reports.map((report) => {
    // Mark an optional check only when it has something to say: a passing line
    // needs no caveat, while a warn or fail line must not be read as the reason
    // a pipeline stopped — an optional check never is.
    const optional = report.required || report.status === 'pass' ? '' : ' (optional)';
    return `${GLYPHS[report.status]} ${report.id.padEnd(width)}  ${report.detail}${optional}`;
  });

  const counts = {
    pass: reports.filter((report) => report.status === 'pass').length,
    warn: reports.filter((report) => report.status === 'warn').length,
    fail: reports.filter((report) => report.status === 'fail').length,
  };

  const summary = `${counts.pass} passed, ${counts.warn} ${
    counts.warn === 1 ? 'warning' : 'warnings'
  }, ${counts.fail} failed`;

  return `${[...lines, '', summary].join('\n')}\n`;
}
