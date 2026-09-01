/**
 * Story 4.4, Task 5 — real `ProbeAttempt`s from the http executor, through the ONE merged
 * derivation.
 *
 * This is the file where the product's central promise stops being structural and starts
 * being exercised. Until Epic 4, every criterion in every run was `skipped`: a gates-only
 * verify executes no probes, so `deriveCriterionResult` had only ever been reached with
 * zero attempts. The four paths below — pass, fail, error, flaky — are reached here for the
 * first time with attempts a real executor produced against a real socket.
 *
 * NOTHING IS RE-IMPLEMENTED HERE. `deriveCriterionResult` is merged, tested and proven; the
 * point of these tests is to prove that what THIS executor produces feeds it correctly. If
 * one of them fails, the defect is in the attempt, not in the derivation.
 *
 * The fixtures are inline, built by the test on ephemeral ports. THE GOLDEN VERIFICATION
 * CORPUS IS EPIC 6 — a passing suite here is not corpus coverage and must not be read as
 * any.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveCriterionResult,
  type ContractCriterionRef,
  type ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import type { Assertion, HttpAssertionTarget, HttpProbe } from '../../../src/domain/plan.js';
import { HttpSurfaceExecutor } from '../../../src/surfaces/http.js';

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A fixture whose answer CHANGES between requests, so a retry can legitimately differ from
 * its predecessor. That is what makes the flaky test real rather than staged: two attempts
 * against one server that genuinely behaved differently, not two hand-built attempt objects.
 */
async function sequencedFixture(statuses: readonly number[]): Promise<string> {
  let call = 0;
  const server = createServer((_request, response) => {
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
    call += 1;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ call }));
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not report a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** A port with nothing listening, produced honestly rather than guessed. */
async function closedBaseUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not report a port');
  }
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const CRITERION: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'the orders endpoint answers 200',
  severity: 'critical',
  verifiability: 'automated',
};

function executor(): { run: (baseUrl: string, attempt: number) => Promise<ProbeAttempt> } {
  const recorded: Evidence[] = [];
  const instance = new HttpSurfaceExecutor({
    clock: { now: () => new Date('2026-09-01T12:00:00.000Z') },
    writeEvidence: async (name) => name,
    recordEvidence: (evidence) => {
      recorded.push(evidence);
    },
  });

  const statusIs200: Assertion<HttpAssertionTarget> = {
    description: 'the endpoint answers 200',
    target: { source: 'status' },
    comparison: 'equals',
    expected: '200',
  };
  const probe: HttpProbe = {
    id: 'orders-health',
    surface: 'http',
    mechanics: { serviceId: 'backend', method: 'GET', path: '/orders' },
    assertions: [statusIs200],
  };

  return {
    run: async (baseUrl, attempt) =>
      await instance.execute({
        criterionId: CRITERION.criterionId,
        surface: 'http',
        params: { probe, baseUrl, attempt },
      }),
  };
}

describe('real probe attempts through the single derivation (AC1, AC3)', () => {
  it('PASS: one satisfied attempt', async () => {
    const baseUrl = await sequencedFixture([200]);
    const attempt = await executor().run(baseUrl, 1);

    const derived = deriveCriterionResult(CRITERION, [attempt]);
    expect(derived.status).toBe('pass');
    expect(derived.flaky).toBeUndefined();
    // A pass carries no expected/actual: there is no violation to describe.
    expect(derived.expected).toBeUndefined();
  });

  it('FAIL: one unsatisfied attempt, carrying expected, actual and an evidence ref (FR-28)', async () => {
    const baseUrl = await sequencedFixture([503]);
    const attempt = await executor().run(baseUrl, 1);

    const derived = deriveCriterionResult(CRITERION, [attempt]);
    expect(derived.status).toBe('fail');
    expect(derived.expected).toBe('200');
    expect(derived.actual).toBe('503');
    expect(derived.evidence?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('ERROR: an attempt that could not observe, carrying actual and no invented evidence', async () => {
    const baseUrl = await closedBaseUrl();
    const attempt = await executor().run(baseUrl, 1);

    const derived = deriveCriterionResult(CRITERION, [attempt]);
    expect(derived.status).toBe('error');
    // `actual` comes from the exec error's message, which is the operator's diagnostic.
    expect(derived.actual).toBeTruthy();
    // Nothing was observed, so nothing is referenced. Inventing a ref would be worse than
    // omitting one — the merged derivation says so in as many words.
    expect(derived.evidence).toBeUndefined();
  });

  it('FLAKY: fail then pass is a flaky pass', async () => {
    const baseUrl = await sequencedFixture([503, 200]);
    const { run } = executor();

    const first = await run(baseUrl, 1);
    const second = await run(baseUrl, 2);

    const derived = deriveCriterionResult(CRITERION, [first, second]);
    expect(derived.status).toBe('pass');
    expect(derived.flaky).toBe(true);
  });

  it('NOT FLAKY: pass then fail is a failure, not flake', async () => {
    const baseUrl = await sequencedFixture([200, 503]);
    const { run } = executor();

    const first = await run(baseUrl, 1);
    const second = await run(baseUrl, 2);

    // The FINAL attempt decides. Marking this flaky would soften a real defect into noise.
    const derived = deriveCriterionResult(CRITERION, [first, second]);
    expect(derived.status).toBe('fail');
    expect(derived.flaky).toBeUndefined();
  });

  it('a human-verifiability criterion is NEEDS_HUMAN however the probe came out', async () => {
    const baseUrl = await sequencedFixture([200]);
    const attempt = await executor().run(baseUrl, 1);

    // The probe PASSED. The criterion is still needs_human, because verifiability decides
    // before attempts are looked at — unconditionally. Asserted from this side to prove the
    // executor does not, and cannot, special-case it.
    const derived = deriveCriterionResult(
      { ...CRITERION, verifiability: 'human' },
      [attempt],
    );
    expect(derived.status).toBe('needs_human');
  });
});
