/**
 * Deterministic `RunResult` fixtures for the renderer suites.
 *
 * Every renderer test builds its input here, so a shape change is one edit
 * rather than twenty. Nothing in this file reads a clock or a random source:
 * the timestamps are literals, which is what makes "the same input renders
 * byte-identically twice" a meaningful assertion rather than a coincidence
 * (AD-9).
 */

import { boundedText, gateEvidence, type Evidence } from '../../../src/domain/evidence.js';
import type { DerivedCriterionResult } from '../../../src/domain/criterion-result.js';
import type { GateResult } from '../../../src/domain/result.js';
import type { RunOutcome } from '../../../src/domain/run-outcome.js';
import type {
  ContractSummary,
  RunEnvironment,
  RunResult,
} from '../../../src/domain/run-result.js';
import { STAGE_NAMES, type StageName, type StageTimelineEntry } from '../../../src/domain/stage.js';

export const RUN_ID = 'run-20260831T142501Z-a3f9';
export const STARTED_AT = '2026-08-31T14:25:01Z';
export const FINISHED_AT = '2026-08-31T14:26:11Z';

export const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: '/var/folders/t3/specwitness-worktree-a3f9',
  runDirectory: `.specwitness/runs/${RUN_ID}`,
};

export const CONTRACT: ContractSummary = {
  epic: 'epic-3',
  version: 2,
  fingerprint: '3f9a1c7e5b2d48a6c1093fe742bd85610f4c39a2e8b7d5610a4c2f983b6d1e07',
  frozenAt: '2026-08-31T14:00:00Z',
  amendments: 1,
  criterionCount: 3,
};

/**
 * All eleven stages, `ok` up to and including `stoppedAfter`, `skipped` beyond
 * it — the shape `runPipeline` produces. Teardown is `ok` even on a stopped
 * run, because teardown always runs.
 */
export function stages(
  stoppedAfter: StageName = 'teardown',
  failed?: {
    readonly stage: StageName;
    readonly status: 'failed' | 'error';
    readonly detail: string;
    /** The recorded remedy. Only an errored stage carries one in practice. */
    readonly hint?: string;
  },
): StageTimelineEntry[] {
  const stopIndex = STAGE_NAMES.indexOf(stoppedAfter);
  return STAGE_NAMES.map((stage, index) => {
    if (failed !== undefined && failed.stage === stage) {
      return {
        stage,
        status: failed.status,
        durationMs: 120,
        detail: failed.detail,
        ...(failed.hint === undefined ? {} : { hint: failed.hint }),
      };
    }
    if (index <= stopIndex || stage === 'teardown') {
      return { stage, status: 'ok' as const, durationMs: index * 10 };
    }
    return { stage, status: 'skipped' as const, durationMs: 0, detail: 'an earlier stage stopped the run' };
  });
}

export function gate(gateId: string, status: GateResult['status'], durationMs = 1200): GateResult {
  return { gateId, status, durationMs };
}

export function criterion(
  criterionId: string,
  status: DerivedCriterionResult['status'],
  overrides: Partial<DerivedCriterionResult> = {},
): DerivedCriterionResult {
  return {
    criterionId,
    status,
    statement: `the ${criterionId} behaviour holds`,
    severity: 'normal',
    ...overrides,
  };
}

/** Gate evidence whose stdout is short enough to survive the cap intact. */
export function shortGateEvidence(gateId: string, status: GateResult['status']): Evidence {
  return gateEvidence({
    capturedAt: '2026-08-31T14:25:30Z',
    gateId,
    // Required since the story 3.3 follow-up: a stored run must name the command that
    // produced the output, not only the gate that failed.
    displayCommand: `pnpm ${gateId}`,
    status,
    exitCode: status === 'pass' ? 0 : 1,
    stdout: `running ${gateId}\n`,
    stderr: '',
    durationMs: 1200,
  });
}

/**
 * Gate evidence whose stdout exceeds the cap, so the report must truncate it
 * and print a marker pointing at the full file. The pointer is relative to the
 * run directory (Q48), which is what keeps it valid after the directory moves.
 */
export function truncatedGateEvidence(gateId: string): Evidence {
  // The two streams name two DIFFERENT files. A single shared pointer is a
  // constructor error now (SHAPE UPDATE 2): two markers claiming their own
  // distinct content lives in one file is worse than no pointer at all,
  // because someone opens it and reads stderr as stdout.
  return gateEvidence({
    capturedAt: '2026-08-31T14:25:30Z',
    gateId,
    // Required since the story 3.3 follow-up: a stored run must name the command that
    // produced the output, not only the gate that failed.
    displayCommand: `pnpm ${gateId}`,
    status: 'fail',
    exitCode: 1,
    stdout: 'x'.repeat(20_000),
    stderr: 'boom\n',
    durationMs: 3400,
    stdoutFullPath: `evidence/gate-${gateId}.stdout.txt`,
    stderrFullPath: `evidence/gate-${gateId}.stderr.txt`,
  });
}

export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: RUN_ID,
    epic: 'epic-3',
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    outcome: { verdict: 'PASS' } satisfies RunOutcome,
    stages: stages(),
    gates: [gate('lint', 'pass'), gate('build', 'pass')],
    criteria: [],
    evidence: [],
    providerUsage: [],
    environment: ENVIRONMENT,
    contract: CONTRACT,
    ...overrides,
  };
}

/** Re-exported so a test can assert a marker without rebuilding one. */
export { boundedText };

/**
 * Gate evidence whose stdout is roughly `bytes` long before capture bounds it.
 *
 * Parameterised on the ORIGINAL size so a test can state NFR-8 as a property:
 * the report is the same size whether the gate emitted 64 KB or 4 MB.
 *
 * The content is REALISTIC multi-line log output, not `'x'.repeat(n)`. That is
 * not cosmetic. Capture-time redaction is linear over ordinary log text (4 MB
 * in ~50 ms) but quadratic over a long unbroken run of identifier characters,
 * so a single-token fixture of this size takes minutes and would have made this
 * suite look hung. The shape of the fixture has to match the shape of the thing
 * being described, or the test measures the fixture instead.
 */
export function hugeGateEvidence(gateId: string, bytes: number): Evidence {
  const line = 'ok 1 - the checkout page rejects an expired card (12ms)\n';
  return gateEvidence({
    capturedAt: '2026-08-31T14:25:30Z',
    gateId,
    // Required since the story 3.3 follow-up: a stored run must name the command that
    // produced the output, not only the gate that failed.
    displayCommand: `pnpm ${gateId}`,
    status: 'fail',
    exitCode: 1,
    stdout: line.repeat(Math.ceil(bytes / line.length)),
    stderr: '',
    durationMs: 3400,
    stdoutFullPath: `evidence/gate-${gateId}.stdout.txt`,
  });
}
