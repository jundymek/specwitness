import { describe, expect, it } from 'vitest';

import { gateEvidence } from '../../../src/domain/evidence.js';
import { isInfraErrorOutcome, isVerdictOutcome } from '../../../src/domain/run-outcome.js';
import { STAGE_NAMES } from '../../../src/domain/stage.js';
import type {
  ContractSummary,
  ProviderUsage,
  RunEnvironment,
  RunResult,
} from '../../../src/domain/run-result.js';

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: '/tmp/specwitness-abc/worktree',
  runDirectory: '.specwitness/runs/run-20260831T200000Z-a3f9',
};

const CONTRACT: ContractSummary = {
  epic: 'epic-3',
  version: 1,
  fingerprint: 'a'.repeat(64),
  frozenAt: '2026-08-31T19:00:00.000Z',
  amendments: 0,
  criterionCount: 7,
};

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-20260831T200000Z-a3f9',
    epic: 'epic-3',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    startedAt: '2026-08-31T20:00:00.000Z',
    finishedAt: '2026-08-31T20:00:31.000Z',
    outcome: { verdict: 'PASS' },
    stages: STAGE_NAMES.map((stage) => ({ stage, status: 'ok' as const, durationMs: 1 })),
    gates: [],
    criteria: [],
    evidence: [],
    providerUsage: [],
    environment: ENVIRONMENT,
    contract: CONTRACT,
    ...overrides,
  };
}

describe('RunResult — AD-11, one model many renderers', () => {
  it('carries a timeline entry for every stage, including the ones that did not run', () => {
    // A renderer must never have to infer that a stage is missing because it was
    // skipped. `stages.length === STAGE_NAMES.length` is an assertion consumers can make.
    const result = runResult();

    expect(result.stages).toHaveLength(STAGE_NAMES.length);
    expect(result.stages.map((entry) => entry.stage)).toEqual([...STAGE_NAMES]);
  });

  it('inherits the mutually exclusive outcome arms from the merged run-outcome', () => {
    // Asserted rather than assumed: the property lives in `run-outcome.ts` via
    // `infraError?: never`, and this pins that RunResult actually inherits it.
    const passed = runResult();
    const broke = runResult({ outcome: { infraError: 'integrity' }, contract: undefined });

    expect(isVerdictOutcome(passed.outcome)).toBe(true);
    expect(isInfraErrorOutcome(broke.outcome)).toBe(true);

    // @ts-expect-error a run outcome is a verdict OR an infra error, never both.
    const impossible: RunResult = runResult({ outcome: { verdict: 'FAIL', infraError: 'infra' } });
    expect(impossible).toBeDefined();
  });

  it('carries the failing gate id as a string, not a boolean (the merged shape wins over ADR-003 prose)', () => {
    const result = runResult({ outcome: { verdict: 'FAIL', gateFailed: 'build' } });

    expect(result.outcome.gateFailed).toBe('build');
  });

  it('omits `contract` when the run never got past integrity', () => {
    // Presence IS fingerprint validity: the integrity stage fills it only after the
    // merged guard returned. Absent means absent / never-frozen / tampered, which the
    // outcome already names.
    const result = runResult({ outcome: { infraError: 'integrity' }, contract: undefined });

    expect(result.contract).toBeUndefined();
    expect(result.outcome.infraError).toBe('integrity');
  });

  it('holds the evidence UNION, not bare references', () => {
    // With refs only, the redacted bounded content would be discarded at construction
    // and a renderer whose signature is (RunResult) => string could not show it without
    // reading the file — which AD-11 forbids.
    const result = runResult({
      evidence: [
        gateEvidence({
          capturedAt: '2026-08-31T20:00:05.000Z',
          gateId: 'lint',
          status: 'pass',
          exitCode: 0,
          stdout: 'all good',
          stderr: '',
          durationMs: 900,
        }),
      ],
    });

    const [first] = result.evidence;
    expect(first?.kind).toBe('gate');
    expect(first?.kind === 'gate' && first.stdout.text).toBe('all good');
  });

  it('has an empty providerUsage in Epic 3 — verify is AI-free (FR-18, Q66)', () => {
    expect(runResult().providerUsage).toEqual([]);
  });
});

describe('ProviderUsage', () => {
  it('records role, provider, duration and attempts, with provenance honestly null', () => {
    const usage: ProviderUsage = {
      role: 'contract-generate',
      provider: 'claude-code',
      durationMs: 4200,
      attempts: 2,
      model: null,
      providerCliVersion: null,
    };

    // A guessed model string in an audit field is worse than an honest null; wiring the
    // contract-side provenance is story 3.8, and that is a different artifact.
    expect(usage.model).toBeNull();
    expect(usage.attempts).toBe(2);
  });
});

describe('RunEnvironment', () => {
  it('carries everything FR-29 makes a renderer print, so it looks nothing up', () => {
    expect(Object.keys(ENVIRONMENT).sort()).toEqual([
      'arch',
      'nodeVersion',
      'platform',
      'runDirectory',
      'specwitnessVersion',
      'worktreePath',
    ]);
  });

  it('allows a null worktree path for a run that never created one', () => {
    const environment: RunEnvironment = { ...ENVIRONMENT, worktreePath: null };
    expect(environment.worktreePath).toBeNull();
  });
});
