/**
 * A fully-populated `RunResult`, built deterministically.
 *
 * Story 3.5 AC3's snapshot pins the persisted JSON shape, and **a snapshot over a
 * half-empty document pins nothing** — an optional field absent from the fixture is a
 * field the snapshot cannot notice changing. So this carries every field, every arm of
 * every closed enum, and every member of the evidence union, including the three kinds
 * Epic 3 does not yet produce (`http`, `browser`, `observation`). Those are declared now
 * and produced in Epics 4/5; pinning them here means that when they arrive, they arrive
 * in a shape somebody already reviewed.
 *
 * DETERMINISTIC BY CONSTRUCTION. Fixed instants, fixed SHAs, fixed durations, no clock and
 * no randomness — a snapshot that changes per run is a snapshot nobody keeps, and the
 * first person to watch it fail spuriously deletes it.
 *
 * THE SEEDED CREDENTIAL IS THE POINT OF THE `stdout` BELOW. Evidence is redacted at
 * capture (AD-10) by the constructors in `src/domain/evidence.ts`, never by the
 * persistence layer. Feeding a credential-shaped string through the real constructor and
 * then asserting the serialized document does not contain it proves the property this
 * story is responsible for: not "redaction works" — that is pamela's test — but "nothing
 * on the way to disk puts it back".
 *
 * The seeded value deliberately does NOT use a real vendor key prefix. A repository-wide
 * secret scanner cannot tell a fake key from a real one (correctly — that is what makes it
 * useful), so a realistic prefix would be rejected before it could ever be committed. The
 * two forms below are what actually matters: an assignment whose NAME ends in `_KEY`, and
 * a header line carrying a log prefix — the second being the one an anchored header
 * pattern misses, and gate output is exactly where it occurs.
 */

import {
  browserEvidence,
  commandEvidence,
  gateEvidence,
  httpEvidence,
  observationEvidence,
  providerEvidence,
  type Evidence,
} from '../../src/domain/evidence.js';
import type { RunResult } from '../../src/domain/run-result.js';
import { STAGE_NAMES } from '../../src/domain/stage.js';

/**
 * A credential-shaped string fed to a redacting constructor.
 *
 * Assert on this constant rather than on a literal, so a test cannot silently start
 * checking for a different string than the one that was actually seeded.
 */
export const SEEDED_SECRET = 'NOTAREALKEY-0123456789abcdefghij';

const AT = '2026-08-30T14:25:01.123Z';

/** Every member of the closed AD-10 union, in a fixed order. */
function everyEvidenceKind(): Evidence[] {
  return [
    gateEvidence({
      capturedAt: AT,
      gateId: 'lint',
      // Added when `displayCommand` became required (story 3.3 follow-up): without it a
      // stored run says which gate failed but not what actually ran.
      //
      // It carries a credential DELIBERATELY. The document now proves redaction on two
      // paths rather than one, and this is the likelier of the two in practice: a gate is
      // far more likely to be a `curl -H "Authorization: Bearer ..."` smoke check than to
      // print a key to stdout. Since this fixture is the document everyone reads to learn
      // the shape, carrying a secret in both places also teaches which fields are
      // dangerous. (Story 3.5's agent asked for this; taken here because the field lands
      // in the same PR, so the weaker fixture never exists on the epic branch.)
      displayCommand: `curl -H "Authorization: Bearer ${SEEDED_SECRET}" http://localhost:3000/health`,
      status: 'fail',
      exitCode: 1,
      stdout: `ANTHROPIC_API_KEY=${SEEDED_SECRET}\n> Authorization: Bearer ${SEEDED_SECRET}\n`,
      stderr: 'lint found 3 problems\n',
      durationMs: 1200,
    }),
    commandEvidence({
      capturedAt: AT,
      commandId: 'install',
      displayCommand: 'pnpm install --frozen-lockfile',
      exitCode: 0,
      stdout: 'Lockfile is up to date\n',
      stderr: '',
      durationMs: 4300,
    }),
    providerEvidence({
      capturedAt: AT,
      role: 'contract-author',
      provider: 'claude-code',
      attempts: 1,
      rawResponse: '{"criteria":[]}',
      durationMs: 8800,
      explanation: 'non-authoritative model prose, read by nothing mechanical',
    }),
    httpEvidence({
      capturedAt: AT,
      method: 'GET',
      url: 'http://localhost:3000/health',
      requestHeaders: { accept: 'application/json' },
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      durationMs: 12,
    }),
    observationEvidence({
      capturedAt: AT,
      observationId: 'db-rows-after',
      snapshot: 'users=3',
      durationMs: 7,
    }),
    browserEvidence({
      capturedAt: AT,
      url: 'http://localhost:3000/login',
      trace: 'evidence/browser/login-trace.zip',
      screenshot: 'evidence/browser/login.png',
      durationMs: 950,
    }),
  ];
}

/**
 * The whole model, populated.
 *
 * The outcome is `FAIL` carrying `gateFailed`, which is the richest arm: it is the only
 * one that exercises the gate marker, and ADR-003's prose still describes that marker as a
 * boolean while the merged `run-outcome.ts` implements it as the failing gate's ID string.
 * Pinning the string here makes the divergence visible if anyone ever "corrects" the code
 * to match the prose.
 */
export function fullyPopulatedRunResult(): RunResult {
  return {
    runId: 'run-20260830T142501Z-a3f9',
    epic: 'epic-7',
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    startedAt: '2026-08-30T14:25:01.000Z',
    finishedAt: '2026-08-30T14:26:44.500Z',
    outcome: { verdict: 'FAIL', gateFailed: 'lint' },
    // All eleven, always — a renderer never infers that a stage is missing because it did
    // not run. The statuses below cover all four values of the closed vocabulary.
    stages: STAGE_NAMES.map((stage, index) => ({
      stage,
      status:
        stage === 'gates'
          ? ('failed' as const)
          : stage === 'services'
            ? ('error' as const)
            : index < 5
              ? ('ok' as const)
              : ('skipped' as const),
      durationMs: index < 5 || stage === 'services' ? (index + 1) * 100 : 0,
      ...(stage === 'gates' ? { detail: "gate 'lint' failed" } : {}),
      // The `services` stage carries BOTH halves of the house style, so the persisted
      // document proves a stored run can round-trip an ERROR/HINT pair. Without the hint
      // mirrored into the strict schema, such a run serialized but could not be parsed
      // back - i.e. exactly the error runs whose remedy had just been preserved.
      ...(stage === 'services'
        ? {
            detail: 'infra: the service never became ready',
            hint: 'check the readiness url and raise the timeout in .specwitness/config.yaml',
          }
        : {}),
    })),
    // One gate of each GateStatus.
    gates: [
      { gateId: 'install', status: 'pass', durationMs: 4300 },
      { gateId: 'lint', status: 'fail', durationMs: 1200 },
      { gateId: 'build', status: 'skipped' },
    ],
    // One criterion of each CriterionStatus, plus a flaky pass — FR-32's whole point is
    // that a retry-pass is recorded rather than silently rendered as a clean one.
    criteria: [
      {
        criterionId: 'E7-01',
        status: 'pass',
        statement: 'The report lists every failing gate with its command output.',
        severity: 'critical',
      },
      {
        criterionId: 'E7-02',
        status: 'pass',
        flaky: true,
        statement: 'The health endpoint responds within the configured timeout.',
        severity: 'normal',
        // Story 5.4. The flaky pass carries its ATTEMPTS, because a `pass` result has no
        // expected, no actual and no evidence of its own — so this is the only place the
        // attempt it was flaky about survives, and a snapshot of a document without it
        // could not notice the field changing. Note attempt 1's evidence path differs from
        // attempt 2's: a retry that overwrote the failed attempt's artifact would leave
        // `flaky: true` pointing at a file showing a pass.
        attempts: [
          {
            attempt: 1,
            outcome: 'fail',
            durationMs: 5100,
            expected: 'status 200 within 2000ms',
            actual: 'status 503',
            evidence: [{ kind: 'http', path: 'probes/http-e7-02-01.response.txt' }],
          },
          {
            attempt: 2,
            outcome: 'pass',
            durationMs: 380,
            evidence: [{ kind: 'http', path: 'probes/http-e7-02-02.response.txt' }],
          },
        ],
      },
      {
        criterionId: 'E7-03',
        status: 'fail',
        statement: 'An unknown flag exits 64.',
        severity: 'critical',
        expected: 'exit code 64',
        actual: 'exit code 1',
        evidence: [{ kind: 'command', path: 'evidence/cmd-unknown-flag.txt' }],
      },
      {
        criterionId: 'E7-04',
        status: 'needs_human',
        statement: 'The error message reads clearly to a first-time user.',
        severity: 'normal',
      },
      {
        criterionId: 'E7-05',
        status: 'skipped',
        statement: 'The browser flow completes without a console error.',
        severity: 'normal',
      },
      {
        criterionId: 'E7-06',
        status: 'error',
        statement: 'The migration is reversible.',
        severity: 'critical',
        expected: 'a reversible migration',
        actual: 'the probe could not observe',
        evidence: [{ kind: 'observation', path: 'evidence/obs-migration.txt' }],
      },
    ],
    evidence: everyEvidenceKind(),
    // Epic 3 always produces an empty array — verify is AI-free (FR-18, Q66). One entry is
    // pinned anyway, so the shape is reviewed before Epic 4 becomes the first to fill it.
    providerUsage: [
      {
        role: 'contract-author',
        provider: 'claude-code',
        durationMs: 8800,
        attempts: 1,
        model: null,
        providerCliVersion: null,
      },
    ],
    environment: {
      nodeVersion: 'v22.12.0',
      platform: 'darwin',
      arch: 'arm64',
      specwitnessVersion: '0.1.0',
      // Absolute BY DESIGN: provenance, not a pointer. See the note in schemas/result.ts.
      worktreePath: '/tmp/specwitness-worktree-abc123/head',
      // Relative to the PROJECT root — a different relativity from evidence paths.
      runDirectory: '.specwitness/runs/run-20260830T142501Z-a3f9',
    },
    contract: {
      epic: 'epic-7',
      version: 2,
      fingerprint: 'a'.repeat(64),
      frozenAt: '2026-08-29T09:00:00.000Z',
      amendments: 1,
      criterionCount: 6,
    },
  };
}
