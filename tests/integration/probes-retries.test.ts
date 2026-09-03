/**
 * Story 5.4 — the retry semantics, driven end to end through the MERGED probes stage.
 *
 * Every sequence below is PRODUCED rather than asserted over a stubbed attempt array: a
 * real fixture HTTP server on an ephemeral port answers wrong once and right after, the
 * merged `createProbesStage` loop calls the merged `HttpSurfaceExecutor` N times, and the
 * merged `deriveCriterionResult` decides. A test that scripted the attempts would prove
 * the assertions about the derivation and nothing about the wiring — and the wiring is
 * this story's entire subject, because Epic 4 left the mechanism correct and unreachable.
 *
 * WHY HTTP AND NOT BROWSER. The owner's decision, so this story is not serialized behind
 * story 5.2's browser executor. `RetryPolicy` is `(surface: ProbeSurface) => number` — a
 * function of the surface enum, not of any executor — and the flake rule is
 * surface-agnostic by construction, so the browser surface inherits every behaviour proven
 * here with no change on either side. The gap is a decision, not an oversight.
 *
 * HERMETIC AND CONCURRENCY-SAFE (AD-12, harness defect H-8): an ephemeral port, a temp
 * directory per file, localhost only, no provider, no subprocess, and a short injected
 * millisecond timeout so the exec-error case fails fast rather than waiting on a real one.
 * Retry tests multiply wall clock by the attempt count, so there are few of them and each
 * is pointed.
 */
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { createRetryPolicy } from '../../src/cli/verify/probe-dispatch.js';
import type {
  ContractCriterionRef,
  DerivedCriterionResult,
} from '../../src/domain/criterion-result.js';
import type { Evidence } from '../../src/domain/evidence.js';
import type { PlanCriterion, ProbeSpec } from '../../src/domain/plan.js';
import type { Clock } from '../../src/domain/ports.js';
import type { RunEnvironment, RunResult } from '../../src/domain/run-result.js';
import type { RunAccumulator, StageContext } from '../../src/pipeline/stage.js';
import { createProbesStage, type RetryPolicy } from '../../src/pipeline/stages/probes.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { serializeRunResult } from '../../src/schemas/result.js';
import { HttpSurfaceExecutor } from '../../src/surfaces/http.js';

/** A token-shaped string the fixture server echoes, to prove EVERY attempt is redacted. */
const SEEDED_SECRET = 'SUPERSECRET-5-4-abcdef';

const CRITERION: ContractCriterionRef = {
  criterionId: 'E5-01',
  statement: 'the health endpoint answers 200',
  severity: 'critical',
  verifiability: 'automated',
};

let server: Server;
let baseUrl: string;
let scratch: string;

/** How many times each path has been asked for, reset per test. */
let hits = new Map<string, number>();

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'specwitness-5-4-'));

  server = createServer((request, response) => {
    const url = request.url ?? '/';
    const seen = (hits.get(url) ?? 0) + 1;
    hits.set(url, seen);

    // `/fail-then-pass` answers 500 once and 200 after; `/pass-then-fail` the reverse;
    // `/always-fail` never recovers. Real state on a real socket, so a sequence cannot be
    // produced by a mistake in the test double.
    const status =
      url === '/fail-then-pass'
        ? seen === 1
          ? 500
          : 200
        : url === '/pass-then-fail'
          ? seen === 1
            ? 200
            : 500
          : url === '/always-fail'
            ? 500
            : 200;

    response.writeHead(status, { 'content-type': 'application/json' });
    // The body carries a credential-shaped assignment on EVERY attempt, so a second
    // attempt written by a path that skipped redaction would leak where the first did not.
    response.end(JSON.stringify({ authorization: `Bearer ${SEEDED_SECRET}`, attempt: seen }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not bind');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  hits = new Map();
});

afterAll(async () => {
  // Closed here AND self-limiting by construction: the server holds no timers and no
  // sockets of its own, so a test run killed outright — where no afterAll executes at all
  // — leaves nothing behind but the process that was killed.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});

function httpProbe(path: string): ProbeSpec {
  return {
    id: 'probe',
    surface: 'http',
    mechanics: { serviceId: 'svc', method: 'GET', path },
    assertions: [
      {
        description: 'answers 200',
        target: { source: 'status' },
        comparison: 'equals',
        expected: '200',
      },
    ],
  } as ProbeSpec;
}

const ENVIRONMENT: RunEnvironment = {
  nodeVersion: 'v22.12.0',
  platform: 'darwin',
  arch: 'arm64',
  specwitnessVersion: '0.1.0',
  worktreePath: '/tmp/specwitness-worktree-fixture',
  runDirectory: '.specwitness/runs/run-20260903T000000Z-5d4a',
};

/** Monotonic and injected, so an attempt's duration is deterministic and costs no time. */
function tickingClock(): Clock {
  let ms = 0;
  return {
    now: () => {
      ms += 10;
      return new Date(ms);
    },
  };
}

interface Ran {
  readonly criteria: readonly DerivedCriterionResult[];
  readonly evidence: readonly Evidence[];
  /** How many times the fixture server was actually asked. */
  readonly serverHits: number;
  readonly result: RunResult;
}

/**
 * Runs one criterion through the merged probes stage against the fixture server.
 *
 * `dispatch` builds the merged `HttpSurfaceExecutor` per attempt exactly as the CLI edge
 * does, and `recordEvidence` arrives from the stage already bound to the run accumulator —
 * so the evidence assertions below cover the real chain rather than a stub of it.
 */
async function run(path: string, retries: RetryPolicy | undefined): Promise<Ran> {
  const accumulator: RunAccumulator = {
    epic: 'epic-5',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    gates: [],
    criteria: [],
    evidence: [],
    providerUsage: [],
    environment: ENVIRONMENT,
    contractCriteria: [CRITERION],
  };

  const context: StageContext = {
    runId: 'run-20260903T000000Z-5d4a',
    clock: tickingClock(),
    run: accumulator,
    snapshot: (): RunResult => {
      throw new Error('the probes stage must not call snapshot()');
    },
  };

  const criteria: readonly PlanCriterion[] = [
    { criterionId: CRITERION.criterionId, disposition: 'automated', probes: [httpProbe(path)] },
  ];

  const stage = createProbesStage({
    criteria,
    data: { bindings: {}, seed: 'seed' } as never,
    dispatch: ({ probe, attempt, recordEvidence }) => ({
      executor: new HttpSurfaceExecutor({
        clock: context.clock,
        // Writes the evidence file for real, under a temp directory, so the ATTEMPT
        // NUMBER in the file name is exercised rather than assumed.
        writeEvidence: async (name: string, contents: string) => {
          const target = join(scratch, name.replaceAll('/', '__'));
          await writeFile(target, contents, 'utf8');
          return name;
        },
        recordEvidence,
        timeoutMs: 2_000,
      }),
      params: {
        probe,
        // A closed port on localhost for the exec-error case: the kernel REFUSES the
        // connection, so the failure comes from the network stack rather than a fake.
        baseUrl: path === '/refused' ? 'http://127.0.0.1:1' : baseUrl,
        attempt,
      },
    }),
    ...(retries === undefined ? {} : { retries }),
  });

  await stage.run(context);

  const result: RunResult = {
    ...accumulator,
    runId: context.runId,
    startedAt: '2026-09-03T00:00:00.000Z',
    finishedAt: '2026-09-03T00:00:10.000Z',
    outcome: { verdict: 'PASS' },
    stages: [],
    criteria: [...accumulator.criteria],
    gates: [],
    evidence: [...accumulator.evidence],
    providerUsage: [],
  } as unknown as RunResult;

  return {
    criteria: accumulator.criteria,
    evidence: accumulator.evidence,
    serverHits: [...hits.values()].reduce((total, n) => total + n, 0),
    result,
  };
}

/** A policy that gives `count` extra attempts to http and none to anything else. */
const httpRetries = (count: number): RetryPolicy => (surface) =>
  surface === 'http' ? count : 0;

describe('the default: opt-in means EXACTLY ONE attempt (AD-9, Q43)', () => {
  it('asks the server once when no retry policy is wired at all', async () => {
    const ran = await run('/always-fail', undefined);

    expect(ran.serverHits).toBe(1);
    expect(ran.criteria[0]?.status).toBe('fail');
    expect(ran.criteria[0]?.attempts).toBeUndefined();
  });

  it('asks the server once when the project declared no `retries:` block', async () => {
    // Through the real config loader and the real composition root, so this is the
    // shipped default rather than a hand-written zero.
    const root = await mkdtemp(join(tmpdir(), 'specwitness-cfg-'));
    try {
      await mkdir(join(root, '.specwitness'), { recursive: true });
      await writeFile(
        join(root, '.specwitness', 'config.yaml'),
        'version: 1\nproject:\n  baseBranch: master\n',
      );

      const policy = createRetryPolicy(loadConfig(root));
      expect(policy('http')).toBe(0);
      expect(policy('browser')).toBe(0);

      const ran = await run('/always-fail', policy);

      expect(ran.serverHits).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gives a surface the attempts the project DID declare', async () => {
    // The other half of the same wiring: if the policy ignored config, this test and the
    // one above would disagree, which is how the wiring was verified red.
    const root = await mkdtemp(join(tmpdir(), 'specwitness-cfg-'));
    try {
      await mkdir(join(root, '.specwitness'), { recursive: true });
      await writeFile(
        join(root, '.specwitness', 'config.yaml'),
        'version: 1\nproject:\n  baseBranch: master\nretries:\n  http: 2\n',
      );

      const ran = await run('/always-fail', createRetryPolicy(loadConfig(root)));

      expect(ran.serverHits).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AC1 — a probe that fails then passes is a flaky PASS with every attempt recorded', () => {
  it('takes two attempts, passes, and is marked flaky', async () => {
    const ran = await run('/fail-then-pass', httpRetries(1));

    expect(ran.serverHits).toBe(2);
    expect(ran.criteria[0]?.status).toBe('pass');
    expect(ran.criteria[0]?.flaky).toBe(true);
    expect(ran.criteria[0]?.attempts?.map((a) => a.outcome)).toEqual(['fail', 'pass']);
  });

  it("keeps the FAILED attempt's evidence in RunResult.evidence, at its own path", async () => {
    // The assertion the whole story turns on. `deriveCriterionResult` reads only the final
    // attempt, so if nothing else kept attempt 1 the evidence a human needs in order to
    // USE the flake marker would be gone — and `flaky: true` would point at nothing.
    const ran = await run('/fail-then-pass', httpRetries(1));

    // BOTH attempts left a typed evidence member on the run, not only the winning one.
    const members = ran.evidence.filter((member) => member.kind === 'http');
    expect(members).toHaveLength(2);
    expect(members.map((member) => member.response.status)).toEqual([500, 200]);

    // And the criterion names the failed attempt's own file, at a path attempt 2 cannot
    // have overwritten: `evidenceStem` puts the 1-based attempt in the file name.
    const attemptPaths = (ran.criteria[0]?.attempts ?? []).map((record) =>
      (record.evidence ?? []).map((ref) => ref.path),
    );
    expect(attemptPaths).toHaveLength(2);
    expect(attemptPaths[0]?.[0]).toContain('-01');
    expect(attemptPaths[1]?.[0]).toContain('-02');
    expect(attemptPaths[0]?.[0]).not.toBe(attemptPaths[1]?.[0]);
  });

  it('numbers the attempts 1-based and monotonically', async () => {
    const ran = await run('/fail-then-pass', httpRetries(1));

    expect(ran.criteria[0]?.attempts?.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it('redacts the seeded credential in EVERY attempt, not only the first', async () => {
    // Assert ABSENCE rather than the presence of `[REDACTED]` (Epic 3 retro §7): a marker
    // that appears somewhere proves nothing about the copy that did not get one.
    const ran = await run('/fail-then-pass', httpRetries(1));

    expect(JSON.stringify(ran.evidence)).not.toContain(SEEDED_SECRET);
    expect(serializeRunResult(ran.result)).not.toContain(SEEDED_SECRET);
    expect(renderTerminal(ran.result)).not.toContain(SEEDED_SECRET);
  });

  it('surfaces the flake in the terminal report and in the JSON, in agreement', async () => {
    const ran = await run('/fail-then-pass', httpRetries(1));

    const report = renderTerminal(ran.result);
    expect(report).toContain('(flaky)');
    expect(report).toContain('1 flaky');
    expect(report).toContain('attempt 1 of 2: fail');

    const document = JSON.parse(serializeRunResult(ran.result)) as {
      flakiness: { flakyCriteria: number; retriedCriteria: number; extraAttempts: number };
    };
    expect(document.flakiness).toEqual({
      flakyCriteria: 1,
      retriedCriteria: 1,
      extraAttempts: 1,
    });
  });
});

describe('AC2 — retries never change classification, only repetition', () => {
  it('retries exhausted: three attempts, criterion FAILS, nothing is flaky', async () => {
    const ran = await run('/always-fail', httpRetries(2));

    expect(ran.serverHits).toBe(3);
    expect(ran.criteria[0]?.status).toBe('fail');
    expect(ran.criteria[0]?.flaky).toBeUndefined();
    expect(ran.criteria[0]?.attempts).toHaveLength(3);
  });

  it('pass then fail is a FAIL and is NOT flaky — the laundering case', async () => {
    // THE DEFECT THIS STORY MUST NOT SHIP. A retry that turned this into a flaky pass
    // would read as green, be wrong, and nothing downstream could tell.
    const ran = await run('/pass-then-fail', httpRetries(1));

    expect(ran.serverHits).toBe(2);
    expect(ran.criteria[0]?.status).toBe('fail');
    expect(ran.criteria[0]?.flaky).toBeUndefined();
    expect(renderTerminal(ran.result)).not.toContain('(flaky)');
  });

  it('a refused connection retried is still ERROR — never fail, never flaky', async () => {
    // A retry does not convert infrastructure into product. `error` aggregates to exit 3,
    // and the day that becomes exit 1 is the day a flaky environment blocks mergeable
    // branches.
    const ran = await run('/refused', httpRetries(1));

    expect(ran.criteria[0]?.status).toBe('error');
    expect(ran.criteria[0]?.flaky).toBeUndefined();
    expect(ran.criteria[0]?.attempts?.map((a) => a.outcome)).toEqual(['error', 'error']);
  });
});

describe('the policy is per probe class', () => {
  it('gives http its configured attempts and every other surface exactly one', () => {
    const policy = createRetryPolicy({
      retries: { http: 2, browser: 0, observation: 1, shell: 0 },
    } as never);

    expect(policy('http')).toBe(2);
    expect(policy('browser')).toBe(0);
    expect(policy('observation')).toBe(1);
    expect(policy('shell')).toBe(0);
  });
});
