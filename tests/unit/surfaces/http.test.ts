/**
 * Story 4.4 — the http surface executor.
 *
 * Every test here drives a REAL fixture HTTP server on an EPHEMERAL port. There is no
 * mocking library and no `nock`: a real socket is both more honest and cheaper than a
 * dependency the Stack table does not pin, and the classification tests in particular are
 * only meaningful if they PRODUCE the state rather than assert over a mocked outcome value
 * (spec: "AC3's test must produce the state, not mock it").
 *
 * `listen(0)` then read the assigned port, following `tests/integration/services.test.ts`:
 * the auto-review runs `pnpm test` in this worktree concurrently with the agent (H-8), so a
 * hardcoded port fails against a concurrent copy of this same suite.
 *
 * No subprocess is spawned anywhere in this file.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveCriterionResult,
  type ContractCriterionRef,
  type ProbeAttempt,
} from '../../../src/domain/criterion-result.js';
import { InfraError } from '../../../src/domain/errors.js';
import type { Evidence, HttpEvidence } from '../../../src/domain/evidence.js';
import type { Assertion, HttpAssertionTarget, HttpProbe } from '../../../src/domain/plan.js';
import type { Clock } from '../../../src/domain/ports.js';
import {
  HttpSurfaceExecutor,
  HTTP_BODY_READ_CAP_BYTES,
  type HttpExecutorDeps,
} from '../../../src/surfaces/http.js';

/* ── fixtures ───────────────────────────────────────────────────────────────────────── */

const openServers: (Server | SocketServer)[] = [];

afterEach(async () => {
  // A leaked listener holds a port and the next run fails somewhere else entirely.
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A fixture server on an ephemeral port; returns its base URL and what it received. */
async function fixture(handler: Handler): Promise<{
  baseUrl: string;
  received: RecordedRequest[];
}> {
  const received: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(request, response);
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not report a port');
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, received };
}

/** Answers a JSON body with status 200 unless told otherwise. */
async function jsonFixture(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Promise<{ baseUrl: string; received: RecordedRequest[] }> {
  return await fixture((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  });
}

/**
 * A port with NOTHING listening: bind one, read it, close it.
 *
 * This produces connection-refused honestly rather than guessing an unused port — the
 * guess is the version that goes flaky on a busy machine.
 */
async function closedPort(): Promise<number> {
  const server = createSocketServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture listener did not report a port');
  }
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Accepts the socket and never answers. For the timeout test. */
async function blackHole(): Promise<string> {
  const server = createServer(() => {
    // Deliberately no response: the socket is accepted and then held open.
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not report a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

/* ── executor harness ───────────────────────────────────────────────────────────────── */

const FIXED_NOW = new Date('2026-09-01T12:00:00.000Z');

/** Advances a fixed number of ms per call, so `durationMs` is exact rather than a shape. */
function steppingClock(stepMs = 7): Clock {
  let calls = 0;
  return {
    now(): Date {
      const at = new Date(FIXED_NOW.getTime() + calls * stepMs);
      calls += 1;
      return at;
    },
  };
}

interface Harness {
  readonly executor: HttpSurfaceExecutor;
  readonly written: { name: string; contents: string }[];
  readonly recorded: Evidence[];
}

function harness(overrides: Partial<HttpExecutorDeps> = {}): Harness {
  const written: { name: string; contents: string }[] = [];
  const recorded: Evidence[] = [];
  const executor = new HttpSurfaceExecutor({
    clock: steppingClock(),
    writeEvidence: async (name, contents) => {
      written.push({ name, contents });
      return name;
    },
    recordEvidence: (evidence) => {
      recorded.push(evidence);
    },
    ...overrides,
  });
  return { executor, written, recorded };
}

function assertion(
  target: HttpAssertionTarget,
  comparison: Assertion<HttpAssertionTarget>['comparison'],
  expected: string,
  description = 'an expectation',
): Assertion<HttpAssertionTarget> {
  return { description, target, comparison, expected };
}

function probe(
  assertions: readonly Assertion<HttpAssertionTarget>[],
  mechanics: Partial<HttpProbe['mechanics']> = {},
): HttpProbe {
  return {
    id: 'probe-1',
    surface: 'http',
    mechanics: { serviceId: 'backend', method: 'GET', path: '/health', ...mechanics },
    assertions,
  };
}

async function run(
  executor: HttpSurfaceExecutor,
  baseUrl: string,
  spec: HttpProbe,
  attempt?: number,
): Promise<ProbeAttempt> {
  return await executor.execute({
    criterionId: 'E4-01',
    surface: 'http',
    params: attempt === undefined ? { probe: spec, baseUrl } : { probe: spec, baseUrl, attempt },
  });
}

const AUTOMATED: ContractCriterionRef = {
  criterionId: 'E4-01',
  statement: 'the health endpoint reports ready',
  severity: 'critical',
  verifiability: 'automated',
};

/* ── Task 1: the executor shape ─────────────────────────────────────────────────────── */

describe('the executor shape (AC1)', () => {
  it('declares the http surface', () => {
    expect(harness().executor.surface).toBe('http');
  });

  it('returns a ProbeAttempt and nothing resembling a verdict', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(Object.keys(attempt).sort()).toEqual(
      ['assertionEvaluations', 'attempt', 'durationMs', 'evidence', 'observations'].sort(),
    );
    expect(attempt).not.toHaveProperty('status');
    expect(attempt).not.toHaveProperty('flaky');
  });

  it('stamps the 1-based attempt from the request, defaulting to 1', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const spec = probe([assertion({ source: 'status' }, 'equals', '200')]);
    const { executor } = harness();

    expect((await run(executor, baseUrl, spec)).attempt).toBe(1);
    expect((await run(executor, baseUrl, spec, 3)).attempt).toBe(3);
  });

  it('measures durationMs from the injected Clock, as a whole number', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const attempt = await run(
      harness({ clock: steppingClock(11) }).executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    // The stepping clock advances exactly 11ms between the two reads the executor makes.
    expect(attempt.durationMs).toBe(11);
    expect(Number.isInteger(attempt.durationMs)).toBe(true);
  });
});

/* ── Task 1: malformed params are a WIRING defect, not an environment failure ───────── */

describe('malformed params (a wiring defect, never an execError)', () => {
  const cases: { why: string; params: Record<string, unknown> }[] = [
    { why: 'no probe at all', params: { baseUrl: 'http://127.0.0.1:1' } },
    {
      why: 'no baseUrl',
      params: { probe: probe([assertion({ source: 'status' }, 'equals', '200')]) },
    },
    {
      why: 'a probe for another surface',
      params: {
        probe: { id: 'p', surface: 'shell', mechanics: {}, assertions: [] },
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    {
      why: 'an absolute path, which AD-3 forbids a plan from expressing',
      params: {
        probe: probe([assertion({ source: 'status' }, 'equals', '200')], {
          path: 'http://evil.example/x',
        }),
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    {
      why: 'an attempt number below 1',
      params: {
        probe: probe([assertion({ source: 'status' }, 'equals', '200')]),
        baseUrl: 'http://127.0.0.1:1',
        attempt: 0,
      },
    },
  ];

  for (const { why, params } of cases) {
    it(`throws InfraError rather than returning an execError: ${why}`, async () => {
      await expect(
        harness().executor.execute({ criterionId: 'E4-01', surface: 'http', params }),
      ).rejects.toBeInstanceOf(InfraError);
    });
  }

  const malformedAssertions: { why: string; assertions: unknown[] }[] = [
    { why: 'an assertion that is not an object', assertions: [null] },
    {
      why: 'an assertion with no target at all',
      assertions: [{ description: 'd', comparison: 'equals', expected: '200' }],
    },
    {
      why: 'an assertion whose target is not an object',
      assertions: [{ description: 'd', comparison: 'equals', expected: '200', target: 'status' }],
    },
    { why: 'an empty assertion object', assertions: [{}] },
    {
      why: 'a target reading from an unknown source',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 'x', target: { source: 'cookies' } },
      ],
    },
    {
      why: 'a header assertion with no header name',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 'x', target: { source: 'header' } },
      ],
    },
    {
      why: 'a header assertion whose name is an empty string',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 'x', target: { source: 'header', name: '' } },
      ],
    },
    {
      why: 'a header assertion whose name contains a space',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 'x', target: { source: 'header', name: 'bad name' } },
      ],
    },
    {
      why: 'a header assertion whose name contains a newline',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 'x', target: { source: 'header', name: 'a\nb' } },
      ],
    },
    {
      why: 'a jsonPath assertion with no path',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 'x', target: { source: 'jsonPath' } },
      ],
    },
    {
      why: 'an unknown comparison',
      assertions: [
        { description: 'd', comparison: 'matches', expected: 'x', target: { source: 'status' } },
      ],
    },
    {
      why: 'a non-string expected',
      assertions: [
        { description: 'd', comparison: 'equals', expected: 200, target: { source: 'status' } },
      ],
    },
  ];

  for (const { why, assertions } of malformedAssertions) {
    it(`throws InfraError, never a raw TypeError: ${why}`, async () => {
      // `params` is `Readonly<Record<string, unknown>>`, so nothing has type-checked its
      // interior. Dereferencing an assertion's target without a shape check threw a raw
      // TypeError — neither an InfraError nor classified at all, escaping the one contract
      // this validation exists to keep.
      const { baseUrl, received } = await jsonFixture({ ok: true });

      await expect(
        harness().executor.execute({
          criterionId: 'E4-01',
          surface: 'http',
          params: {
            probe: { ...probe([assertion({ source: 'status' }, 'equals', '200')]), assertions },
            baseUrl,
          },
        }),
      ).rejects.toBeInstanceOf(InfraError);

      expect(received).toHaveLength(0);
    });
  }

  const malformedMechanics: { why: string; mechanics: Record<string, unknown> }[] = [
    { why: 'a path containing a space', mechanics: { path: '/admin secret' } },
    { why: 'a path containing a tab', mechanics: { path: '/a\tb' } },
    { why: 'a path containing a control character', mechanics: { path: '/a\u0001b' } },
    { why: 'a path containing a newline', mechanics: { path: '/a\nb' } },
    { why: 'a protocol-relative path', mechanics: { path: '//evil.example/x' } },
    { why: 'a path with a backslash after the slash', mechanics: { path: '/\\evil.example/x' } },
    { why: 'headers that are not an object', mechanics: { headers: null } },
    { why: 'headers given as an array', mechanics: { headers: ['x-a', 'b'] } },
    { why: 'a numeric header value', mechanics: { headers: { 'x-count': 3 } } },
    {
      why: 'a header value carrying CRLF (header injection)',
      mechanics: { headers: { 'x-a': 'b\r\nx-evil: 1' } },
    },
    { why: 'an invalid header field name', mechanics: { headers: { 'bad name': 'v' } } },
    { why: 'a numeric body', mechanics: { method: 'POST', body: 42 } },
  ];

  for (const { why, mechanics } of malformedMechanics) {
    it(`throws InfraError before any I/O: ${why}`, async () => {
      // Unchecked, these reach `fetch`, where they are normalised, coerced or percent-encoded
      // and SENT — producing a request the plan never declared, which is exactly what this
      // executor promises never to issue.
      const { baseUrl, received } = await jsonFixture({ ok: true });

      await expect(
        harness().executor.execute({
          criterionId: 'E4-01',
          surface: 'http',
          params: {
            probe: probe([assertion({ source: 'status' }, 'equals', '200')], mechanics),
            baseUrl,
          },
        }),
      ).rejects.toBeInstanceOf(InfraError);

      expect(received).toHaveLength(0);
    });
  }

  it('still accepts an ordinary path, headers and body', async () => {
    // The other half of a validator: over-refusal is its own defect, and a guard that only
    // proves things are rejected cannot tell a correct rule from one that rejects everything.
    const { baseUrl, received } = await jsonFixture({ ok: true });
    await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        method: 'POST',
        path: '/orders/A-1?dry=1',
        headers: { 'x-trace': 'abc', 'content-type': 'application/json' },
        body: '{"sku":"A-1"}',
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/orders/A-1?dry=1');
  });

  it('never issues a request when the params are malformed', async () => {
    const { baseUrl, received } = await jsonFixture({ ok: true });
    await expect(
      harness().executor.execute({
        criterionId: 'E4-01',
        surface: 'http',
        params: { probe: probe([]), baseUrl },
      }),
    ).rejects.toBeInstanceOf(InfraError);

    expect(received).toHaveLength(0);
  });
});

/* ── Task 2: request construction ───────────────────────────────────────────────────── */

describe('request construction (AC1, AD-3)', () => {
  it('sends the declared method, path, headers and body to the server', async () => {
    const { baseUrl, received } = await jsonFixture({ ok: true });
    await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        method: 'POST',
        path: '/orders?dry=1',
        headers: { 'x-trace': 'abc' },
        body: '{"sku":"A-1"}',
      }),
    );

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/orders?dry=1');
    expect(request?.headers['x-trace']).toBe('abc');
    expect(request?.body).toBe('{"sku":"A-1"}');
  });

  it('joins the caller-resolved base URL with the declared path, base path included', async () => {
    const { baseUrl, received } = await jsonFixture({ ok: true });
    await run(
      harness().executor,
      `${baseUrl}/api/v2`,
      probe([assertion({ source: 'status' }, 'equals', '200')], { path: '/orders' }),
    );

    // A base URL carrying a path prefix keeps it: `/api/v2` + `/orders`. Naive
    // `new URL(path, base)` resolution would discard the prefix and probe `/orders`.
    expect(received[0]?.url).toBe('/api/v2/orders');
  });

  it('never follows a redirect off the declared service', async () => {
    const elsewhere = await fixture((_request, response) => {
      response.writeHead(200);
      response.end('should never be reached');
    });
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(302, { location: `${elsewhere.baseUrl}/stolen` });
      response.end();
    });

    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '302')]),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(elsewhere.received).toHaveLength(0);
  });
});

/* ── Task 2: mechanical assertion evaluation ────────────────────────────────────────── */

describe('mechanical assertion evaluation (AC1)', () => {
  it('records EVERY assertion, satisfied ones included', async () => {
    const { baseUrl } = await jsonFixture({ name: 'widget', count: 3 });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        assertion({ source: 'status' }, 'equals', '200', 'status is 200'),
        assertion({ source: 'jsonPath', path: 'name' }, 'equals', 'widget', 'name is widget'),
        assertion({ source: 'jsonPath', path: 'count' }, 'greaterThan', '1', 'count exceeds 1'),
      ]),
    );

    expect(attempt.assertionEvaluations).toHaveLength(3);
    expect(attempt.assertionEvaluations.every((each) => each.satisfied)).toBe(true);
    expect(attempt.assertionEvaluations.map((each) => each.description)).toEqual([
      'status is 200',
      'name is widget',
      'count exceeds 1',
    ]);
  });

  it('names both values when a status assertion is unsatisfied', async () => {
    const { baseUrl } = await jsonFixture({}, 503);
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.assertionEvaluations[0]).toMatchObject({
      satisfied: false,
      expected: '200',
      actual: '503',
    });
  });

  it('names both values when a JSON-path value is wrong', async () => {
    const { baseUrl } = await jsonFixture({ data: { items: [{ id: 'a-1' }, { id: 'b-2' }] } });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'jsonPath', path: '$.data.items[1].id' }, 'equals', 'z-9')]),
    );

    expect(attempt.assertionEvaluations[0]).toMatchObject({
      satisfied: false,
      expected: 'z-9',
      actual: 'b-2',
    });
  });

  it('evaluates header assertions case-insensitively, both ways', async () => {
    const { baseUrl } = await jsonFixture({}, 200, { 'x-flavour': 'vanilla' });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        assertion({ source: 'header', name: 'X-Flavour' }, 'equals', 'vanilla'),
        assertion({ source: 'header', name: 'x-flavour' }, 'equals', 'chocolate'),
      ]),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(true);
    expect(attempt.assertionEvaluations[1]).toMatchObject({
      satisfied: false,
      expected: 'chocolate',
      actual: 'vanilla',
    });
  });

  it('evaluates a body assertion against the response text', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('service is healthy');
    });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        assertion({ source: 'body' }, 'contains', 'healthy'),
        assertion({ source: 'body' }, 'notContains', 'degraded'),
      ]),
    );

    expect(attempt.assertionEvaluations.every((each) => each.satisfied)).toBe(true);
  });

  it('supports the six merged comparisons', async () => {
    const { baseUrl } = await jsonFixture({ n: 5, s: 'alpha-beta' });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        assertion({ source: 'jsonPath', path: 'n' }, 'equals', '5'),
        assertion({ source: 'jsonPath', path: 'n' }, 'notEquals', '6'),
        assertion({ source: 'jsonPath', path: 's' }, 'contains', 'beta'),
        assertion({ source: 'jsonPath', path: 's' }, 'notContains', 'gamma'),
        assertion({ source: 'jsonPath', path: 'n' }, 'greaterThan', '4'),
        assertion({ source: 'jsonPath', path: 'n' }, 'lessThan', '6'),
      ]),
    );

    expect(attempt.assertionEvaluations.map((each) => each.satisfied)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('leaves a numeric comparison unsatisfied when a side is not a number, without crashing', async () => {
    const { baseUrl } = await jsonFixture({ s: 'not-a-number' });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'jsonPath', path: 's' }, 'greaterThan', '4')]),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toContain('not-a-number');
  });
});

/* ── Task 2: absent values are unsatisfied, never an execError ──────────────────────── */

describe('a value that is not there (AC1)', () => {
  it('treats an unresolved JSON path as unsatisfied, not as an execError', async () => {
    const { baseUrl } = await jsonFixture({ data: {} });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'jsonPath', path: '$.data.missing' }, 'equals', 'x')]),
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toMatch(/did not resolve/i);
  });

  it('treats an absent header as unsatisfied, not as an execError', async () => {
    const { baseUrl } = await jsonFixture({});
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'header', name: 'x-request-id' }, 'equals', 'abc')]),
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(attempt.assertionEvaluations[0]?.actual).toMatch(/no such header/i);
  });

  it('never mints a pass from an absence, even for a negative comparison', async () => {
    const { baseUrl } = await jsonFixture({ data: {} });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        assertion({ source: 'jsonPath', path: '$.data.missing' }, 'notEquals', 'x'),
        assertion({ source: 'header', name: 'x-absent' }, 'notContains', 'y'),
      ]),
    );

    // A value that does not exist cannot satisfy an expectation ABOUT that value. The
    // alternative mints a PASS out of nothing, which is the one direction this product
    // must never fail in.
    expect(attempt.assertionEvaluations.map((each) => each.satisfied)).toEqual([false, false]);
  });

  it('renders a faithful string for a key named __proto__, not the prototype object', async () => {
    // JSON.parse makes `__proto__` an OWN property, so the path resolver reaches it. The
    // redaction helper builds its result with `result[name] = …`, and assigning to
    // `__proto__` hits the prototype setter — silently discarded for a string — so a naive
    // read-back returns `Object.prototype`. That is not a leak, but it is an `actual` that
    // serialises to `{}` and tells a reader nothing about what was seen.
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"__proto__":"polluted-value"}');
    });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'jsonPath', path: '__proto__' }, 'equals', 'something-else')]),
    );

    const [evaluation] = attempt.assertionEvaluations;
    expect(typeof evaluation?.actual).toBe('string');
    expect(evaluation?.actual).toBe('polluted-value');
    expect(evaluation?.satisfied).toBe(false);
  });

  it('treats a non-JSON body under a jsonPath assertion as unsatisfied, naming the content type', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>login</title>');
    });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'jsonPath', path: 'token' }, 'equals', 'x')]),
    );

    expect(attempt.execError).toBeUndefined();
    const [evaluation] = attempt.assertionEvaluations;
    expect(evaluation?.satisfied).toBe(false);
    expect(evaluation?.actual).toContain('text/html');
    expect(evaluation?.actual).toContain('<!doctype html>');
  });
});

/* ── Task 2: an unsupported JSON path is a TOOLING gap, never a product failure ─────── */

describe('JSON-path syntax outside the implemented subset', () => {
  const unsupported = ['$..id', '$.items[*].id', '$.items[?(@.id)]', '$.items[0:2]'];

  for (const path of unsupported) {
    it(`refuses '${path}' before any request is issued`, async () => {
      const { baseUrl, received } = await jsonFixture({ items: [] });
      await expect(
        run(
          harness().executor,
          baseUrl,
          probe([assertion({ source: 'jsonPath', path }, 'equals', 'x')]),
        ),
      ).rejects.toBeInstanceOf(InfraError);

      // Refused at params time, so nothing was observed and nothing can be misread as a
      // product failure. An executor limitation is never evidence about the branch.
      expect(received).toHaveLength(0);
    });
  }
});

/* ── Task 3: the classification split — the story's most important behaviour ────────── */

describe('could not look vs looked and saw wrong (AC3)', () => {
  it('classifies connection refused as an execError with a hint', async () => {
    const port = await closedPort();
    const attempt = await run(
      harness().executor,
      `http://127.0.0.1:${port}`,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.execError?.message).toBeTruthy();
    expect(attempt.execError?.hint).toBeTruthy();
  });

  it('classifies a DNS failure as an execError', async () => {
    const attempt = await run(
      harness().executor,
      'http://specwitness-no-such-host.invalid',
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.execError).toBeDefined();
  });

  it('classifies a socket timeout as an execError, with the timeout injected in ms', async () => {
    const baseUrl = await blackHole();
    const attempt = await run(
      harness({ timeoutMs: 50 }).executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.execError?.message).toMatch(/timed out|timeout/i);
  });

  it('emits NO assertion evaluation on the exec-error path', async () => {
    const port = await closedPort();
    const attempt = await run(
      harness().executor,
      `http://127.0.0.1:${port}`,
      probe([
        assertion({ source: 'status' }, 'equals', '200'),
        assertion({ source: 'jsonPath', path: 'ok' }, 'equals', 'true'),
      ]),
    );

    // Two assertions were declared and NEITHER is reported: they ran against nothing.
    // Emitting them "for completeness" would manufacture product evidence out of an
    // infrastructure failure.
    expect(attempt.assertionEvaluations).toEqual([]);
  });

  it('derives criterion `error`, NOT `fail`, from a refused connection', async () => {
    const port = await closedPort();
    const attempt = await run(
      harness().executor,
      `http://127.0.0.1:${port}`,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    const derived = deriveCriterionResult(AUTOMATED, [attempt]);
    expect(derived.status).toBe('error');
    expect(derived.status).not.toBe('fail');
    expect(derived.actual).toBeTruthy();
  });

  it('derives criterion `error`, NOT `fail`, from a timeout', async () => {
    const baseUrl = await blackHole();
    const attempt = await run(
      harness({ timeoutMs: 50 }).executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('records WHAT WAS ATTEMPTED when no response arrived — a ref, but no member', async () => {
    const port = await closedPort();
    const { executor, written, recorded } = harness();
    const attempt = await run(
      executor,
      `http://127.0.0.1:${port}`,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        method: 'POST',
        path: '/orders',
        body: '{}',
      }),
    );

    // NO MEMBER: the closed union cannot represent "no response", and a fabricated status
    // would manufacture an observation out of an infrastructure failure.
    expect(recorded).toEqual([]);

    // BUT A REFERENCE, because FR-28 wants one on every non-pass and this derives to
    // criterion `error`. The artifact states what was ATTEMPTED — a fact — rather than
    // claiming anything was observed.
    expect(attempt.evidence).toHaveLength(1);
    expect(written).toHaveLength(1);
    const [file] = written;
    expect(file?.name).toBe(attempt.evidence[0]?.path);
    expect(file?.contents).toContain('no response was received');
    expect(file?.contents).toContain('POST');
    expect(file?.contents).toContain('/orders');
    expect(file?.contents).toMatch(/error:/);
  });

  it('keeps the attempted-request record redacted, including caller extra patterns', async () => {
    const opaque = 'wwww-opaque-attempted-wwww';
    const port = await closedPort();
    const { executor, written } = harness({
      redaction: { extraPatterns: [new RegExp(opaque, 'g')] },
    });

    await run(
      executor,
      `http://127.0.0.1:${port}`,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        path: `/x?trace=${opaque}`,
        headers: { authorization: `Bearer ${opaque}`, 'x-note': opaque },
      }),
    );

    for (const file of written) {
      expect(file.contents).not.toContain(opaque);
    }
  });

  it('derives `fail`, not `error`, when the probe DID look and saw the wrong value', async () => {
    const { baseUrl } = await jsonFixture({}, 500);
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.execError).toBeUndefined();
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('fail');
  });
});

/* ── Task 3: the one case where an exec error DID observe something ─────────────────── */

describe('a timeout AFTER the headers arrived (the observed-yet-errored case)', () => {
  it('captures the partial response, sets execError, and still evaluates nothing', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      // Headers and a first chunk land; the body is then never finished.
      response.write('{"partial":');
    });

    const { executor, recorded } = harness({ timeoutMs: 120 });
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    // It could not COMPLETE the observation, so the criterion must be `error`...
    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');

    // ...but a real status, real headers and real bytes WERE observed, and they are the
    // diagnostic. Evidence follows whether an observation exists, not whether the attempt
    // errored (cohort rule, settled at intent-sync with 4.5 and 4.6).
    expect(recorded).toHaveLength(1);
    const [member] = recorded as [HttpEvidence];
    expect(member.response.status).toBe(200);
    expect(member.response.body.text).toContain('"partial"');
    expect(member.explanation).toBeTruthy();
    expect(attempt.evidence.length).toBeGreaterThanOrEqual(1);
  });
});

describe('an incomplete observation may not adjudicate (review findings)', () => {
  it('refuses to evaluate assertions against a body larger than the read cap', async () => {
    // THE FALSE-PASS VECTOR. Assertions used to be evaluated against the first megabyte, so a
    // `notContains` passed while the forbidden string sat in bytes nobody read. Minting a PASS
    // from a partial observation is the worst direction this product can fail in.
    const forbidden = 'FORBIDDEN-MARKER';
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      // Well past the 1 MiB read cap, with the marker only in the tail.
      response.end('a'.repeat(1_100_000) + forbidden);
    });

    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'body' }, 'notContains', forbidden)]),
    );

    expect(attempt.assertionEvaluations).toEqual([]);
    expect(attempt.execError?.message).toMatch(/incomplete/i);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('still captures the partial response as the diagnostic', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('b'.repeat(1_100_000));
    });
    const { executor, recorded } = harness();
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(recorded).toHaveLength(1);
    expect((recorded[0] as HttpEvidence).explanation).toMatch(/read cap/i);
    expect(attempt.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('still adjudicates status and header assertions when the body is capped', async () => {
    // The over-broad first fix reported INFRASTRUCTURE FAILURE for a probe that had observed
    // everything it asserted on: a status and a header are complete the moment the response
    // line and headers arrive, and truncating the body cannot move either. Worse, the hint it
    // printed named a remedy ("assert on a header or status") that the same path refused.
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-flavour': 'vanilla' });
      response.end('d'.repeat(1_100_000));
    });

    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        assertion({ source: 'status' }, 'equals', '200'),
        assertion({ source: 'header', name: 'x-flavour' }, 'equals', 'vanilla'),
      ]),
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations).toHaveLength(2);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });

  it('errors when ANY declared assertion reads the capped body, and evaluates none', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('e'.repeat(1_100_000));
    });

    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([
        // Fully observable on its own — but it is not emitted, because emitting evaluations
        // beside an execError is the mistake this module refuses everywhere else.
        assertion({ source: 'status' }, 'equals', '200'),
        assertion({ source: 'body' }, 'contains', 'anything'),
      ]),
    );

    expect(attempt.execError).toBeDefined();
    expect(attempt.assertionEvaluations).toEqual([]);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('error');
  });

  it('treats a body of EXACTLY the cap as complete, not truncated', async () => {
    // `>=` reported a fully-captured body as truncated, which — now that truncation means
    // "did not observe it" — turned a complete observation into criterion `error` at one
    // exact size.
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('c'.repeat(HTTP_BODY_READ_CAP_BYTES));
    });

    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.execError).toBeUndefined();
    expect(attempt.assertionEvaluations).toHaveLength(1);
    expect(deriveCriterionResult(AUTOMATED, [attempt]).status).toBe('pass');
  });
});

describe('faithful capture of awkward names and methods (review findings)', () => {
  // A RESPONSE HEADER NAMED `__proto__` HAS NO TEST HERE, DELIBERATELY, and the reason is
  // worth more than the test would have been.
  //
  // Node's `fetch` really does surface such a header (verified), and this module's
  // `headerRecord` really did drop it, because a plain `record[name] = value` runs the
  // prototype setter for that key and silently discards a string. That half is FIXED —
  // `headerRecord` now uses `defineProperty`, so the record this module builds is faithful.
  //
  // But the header still does not reach the persisted member, because merged
  // `redactHeaders` rebuilds its result with the same `result[name] = …` pattern and drops
  // it again. That is merged domain code, outside this story, and it fails in the SAFE
  // direction — the header vanishes rather than leaking — so it is reported in the PR body
  // rather than patched from a story branch.
  //
  // A test asserting the header is ABSENT would certify that defect rather than catch it,
  // which is precisely the failure mode `evidence.ts`'s own header warns about. So the fix
  // stays, the limitation is reported, and no test here pretends the gap is a decision.

  it('refuses a GET carrying a body as a malformed plan, not an infra failure', async () => {
    // Node's fetch throws for this, so without the check it surfaced as an execError — an
    // INFRASTRUCTURE verdict for what is actually a bad plan.
    const { baseUrl, received } = await jsonFixture({ ok: true });

    await expect(
      run(
        harness().executor,
        baseUrl,
        probe([assertion({ source: 'status' }, 'equals', '200')], { method: 'GET', body: '{}' }),
      ),
    ).rejects.toBeInstanceOf(InfraError);

    expect(received).toHaveLength(0);
  });

  it('still allows a POST to carry a body', async () => {
    const { baseUrl, received } = await jsonFixture({ ok: true });
    await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        method: 'POST',
        body: '{"sku":"A-1"}',
      }),
    );

    expect(received[0]?.body).toBe('{"sku":"A-1"}');
  });
});

/* ── Task 4: evidence, and the redaction that must happen at capture ────────────────── */

describe('evidence capture (AC2, AD-10)', () => {
  it('records the typed member through the merged constructor and refs a file', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, written, recorded } = harness();
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(recorded).toHaveLength(1);
    const [member] = recorded as [HttpEvidence];
    expect(member.kind).toBe('http');
    expect(member.request.method).toBe('GET');
    expect(member.response.status).toBe(200);
    expect(member.capturedAt).toBe(FIXED_NOW.toISOString());

    // At least one ref on every attempt that observed something (FR-28), pointing at a
    // file that was actually written.
    expect(attempt.evidence.length).toBeGreaterThanOrEqual(1);
    expect(written.map((each) => each.name)).toContain(attempt.evidence[0]?.path);
    expect(attempt.evidence.every((ref) => ref.kind === 'http')).toBe(true);
  });

  it('gives the evidence member the SAME duration as the attempt, never zero', async () => {
    // Found by Codex review: the member carried a hard-coded durationMs of 0 while the
    // attempt carried the measured value, so every stored report claimed slow requests
    // completed instantly. Two numbers for one request is two answers to one question, and
    // the member is the copy a human reads.
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, recorded } = harness({ clock: steppingClock(13) });
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    const [member] = recorded as [HttpEvidence];
    expect(attempt.durationMs).toBe(13);
    expect(member.durationMs).toBe(attempt.durationMs);
  });

  it('gives an exec-error attempt a measured duration too', async () => {
    const port = await closedPort();
    const attempt = await run(
      harness({ clock: steppingClock(13) }).executor,
      `http://127.0.0.1:${port}`,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    expect(attempt.durationMs).toBe(13);
  });

  it('keeps evidence paths relative to the run directory (Q48)', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, written } = harness();
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    for (const ref of attempt.evidence) {
      expect(ref.path.startsWith('/')).toBe(false);
      expect(ref.path).not.toContain('..');
      expect(ref.path).not.toContain('\\');
      expect(ref.path.startsWith('evidence/')).toBe(true);
    }
    expect(written.every((each) => each.name.startsWith('evidence/'))).toBe(true);
  });

  it('keeps each attempt’s evidence separate, so a retry cannot clobber it', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, written } = harness();
    const spec = probe([assertion({ source: 'status' }, 'equals', '200')]);

    await run(executor, baseUrl, spec, 1);
    await run(executor, baseUrl, spec, 2);

    const names = written.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never collides across criteria that reuse a probe id', async () => {
    // `plan.ts` enforces probe-id uniqueness only WITHIN a criterion — its own comment says
    // "Probe ids identify a probe within its criterion" — so two criteria may each hold a
    // probe called `health`. A filename built from the probe id alone would give both the
    // same file, and the first criterion's evidence ref would then point at the second
    // criterion's content: evidence attributed to the wrong criterion, which is worse than
    // no evidence at all.
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, written } = harness();
    const spec = probe([assertion({ source: 'status' }, 'equals', '200')]);

    for (const criterionId of ['E4-01', 'E4-02']) {
      await executor.execute({
        criterionId,
        surface: 'http',
        params: { probe: spec, baseUrl, attempt: 1 },
      });
    }

    const names = written.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never collides between two probe ids that slugify or truncate alike', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, written } = harness();

    // Same criterion, distinct ids sharing a 64-character prefix (`Identifier` allows 128).
    const shared = 'p'.repeat(70);
    for (const id of [`${shared}alpha`, `${shared}beta`]) {
      await executor.execute({
        criterionId: 'E4-01',
        surface: 'http',
        params: {
          probe: { ...probe([assertion({ source: 'status' }, 'equals', '200')]), id },
          baseUrl,
          attempt: 1,
        },
      });
    }

    const names = written.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('derives the same evidence path twice for the same probe, so a re-run does not diff', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const spec = probe([assertion({ source: 'status' }, 'equals', '200')]);

    const first = harness();
    await run(first.executor, baseUrl, spec, 1);
    const second = harness();
    await run(second.executor, baseUrl, spec, 1);

    expect(second.written.map((each) => each.name)).toEqual(first.written.map((each) => each.name));
  });

  it('caps the inline body and points the truncation marker at the full copy', async () => {
    const long = 'x'.repeat(20_000);
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(long);
    });
    const { executor, written, recorded } = harness();
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    const [member] = recorded as [HttpEvidence];
    expect(member.response.body.truncated).toBe(true);
    expect(member.response.body.totalBytes).toBe(20_000);
    expect(member.response.body.text.length).toBeLessThan(20_000);
    expect(member.response.body.fullPath).toBeDefined();

    // The pointer names a file that was actually written, and it carries the WHOLE body.
    const full = written.find((each) => each.name === member.response.body.fullPath);
    expect(full?.contents).toBe(long);
    expect(attempt.evidence.map((ref) => ref.path)).toContain(member.response.body.fullPath);
  });

  it('writes no full copy for an empty body, but still refs the member', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const { executor, written } = harness();
    const attempt = await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')]),
    );

    // An empty file is an artifact implying output that never existed (gates.ts's rule) —
    // but the ATTEMPT still observed a real status, so FR-28's ref is present anyway.
    expect(written).toHaveLength(1);
    expect(attempt.evidence).toHaveLength(1);
  });
});

/* ── Task 4: the seeded-secret proof ────────────────────────────────────────────────── */

describe('seeded secrets never reach a stored artifact (AC2, NFR-3)', () => {
  const SECRET = 'sw-secret-9f2c1ad4e7b6';
  /** A credential a plan put in `expected`. Bare: no assignment syntax to recognise. */
  const SENSITIVE_EXPECTED = 'Bearer plan-side-credential-4b21';
  /** Matches NO built-in rule, so a guard using it cannot pass on the built-ins alone. */
  const OPAQUE = 'qqqq-opaque-nomatch-qqqq';

  it('leaks the secret nowhere: not inline, not in the full copy, not in expected/actual', async () => {
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `session=${SECRET}; HttpOnly`,
        'x-upstream-token': SECRET,
      });
      response.end(JSON.stringify({ api_key: SECRET, note: `token=${SECRET}` }));
    });

    const { executor, written, recorded } = harness();
    const attempt = await run(
      executor,
      baseUrl,
      probe(
        [
          // Deliberately unsatisfied, so `expected`/`actual` are populated and travel into
          // the derived result — the other path a captured credential could take.
          assertion({ source: 'jsonPath', path: 'api_key' }, 'equals', 'expected-value'),
          assertion({ source: 'body' }, 'contains', 'nothing-like-this'),
        ],
        {
          path: `/session?api_key=${SECRET}`,
          headers: { authorization: `Bearer ${SECRET}`, cookie: `sid=${SECRET}` },
        },
      ),
    );

    const derived = deriveCriterionResult(AUTOMATED, [attempt]);

    // ASSERT THE SECRET IS ABSENT, never that a marker is PRESENT: output carrying
    // `[REDACTED]` with the secret still beside it survives review in a way a raw leak
    // does not, and a marker-presence assertion passes green straight over it
    // (Epic 3 retro §7).
    const artifacts = [
      JSON.stringify(recorded),
      JSON.stringify(attempt),
      JSON.stringify(derived),
      ...written.map((each) => each.contents),
      ...written.map((each) => each.name),
    ];

    for (const artifact of artifacts) {
      expect(artifact).not.toContain(SECRET);
    }
  });

  it('redacts the URL, so a query-string token cannot ride beside a redacted header', async () => {
    const { baseUrl } = await jsonFixture({ ok: true });
    const { executor, recorded } = harness();

    await run(
      executor,
      baseUrl,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        path: `/x?api_key=${SECRET}&page=2`,
      }),
    );

    const [member] = recorded as [HttpEvidence];
    expect(member.request.url).not.toContain(SECRET);
    // The non-secret part of the URL survives: over-redaction produces evidence nobody can
    // read, and people respond to unreadable evidence by opening the unredacted file.
    expect(member.request.url).toContain('/x?');
  });

  it('redacts a secret carried in an error message', async () => {
    const port = await closedPort();
    const attempt = await run(
      harness().executor,
      `http://127.0.0.1:${port}`,
      probe([assertion({ source: 'status' }, 'equals', '200')], {
        path: `/x?token=${SECRET}`,
      }),
    );

    expect(JSON.stringify(attempt.execError)).not.toContain(SECRET);
  });

  it('redacts a sensitive EXPECTED value, not only the actual (both sides of one comparison)', async () => {
    // Found by review. A plan asserting `header authorization equals <token>` puts the token
    // in `expected`, where it is a BARE string with no assignment syntax for `redactText` to
    // recognise — and `expected` is persisted to result.json and printed exactly like
    // `actual`. Protecting only `actual` left the two sides of one comparison under different
    // rules, which reads as deliberate and is not.
    const { baseUrl } = await jsonFixture({}, 200, { authorization: 'Bearer server-side' });
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'header', name: 'authorization' }, 'equals', SENSITIVE_EXPECTED)]),
    );

    const [evaluation] = attempt.assertionEvaluations;
    expect(evaluation?.expected).not.toContain(SENSITIVE_EXPECTED);
    expect(JSON.stringify(attempt)).not.toContain(SENSITIVE_EXPECTED);
    expect(JSON.stringify(deriveCriterionResult(AUTOMATED, [attempt]))).not.toContain(
      SENSITIVE_EXPECTED,
    );
  });

  it('protects a sensitive expected value even when the target was ABSENT', async () => {
    // The name is derived from the TARGET rather than from a successful read, so the
    // protection does not evaporate on the branch where there was no value to read.
    const { baseUrl } = await jsonFixture({});
    const attempt = await run(
      harness().executor,
      baseUrl,
      probe([assertion({ source: 'jsonPath', path: 'data.api_key' }, 'equals', SENSITIVE_EXPECTED)]),
    );

    expect(attempt.assertionEvaluations[0]?.satisfied).toBe(false);
    expect(JSON.stringify(attempt)).not.toContain(SENSITIVE_EXPECTED);
  });

  it('applies caller extraPatterns to a REJECTED baseUrl in the thrown error', async () => {
    // `validateParams` quotes the offending value, and its message reaches stderr verbatim
    // through printError. A bare `redactText` there would apply only the BUILT-IN rules, so
    // this token deliberately matches none of them: it has no assignment syntax and no
    // sensitive name beside it, which is exactly the case a project declares extraPatterns
    // for. The guard fails unless extraPatterns is genuinely threaded through.
    const { executor } = harness({ redaction: { extraPatterns: [new RegExp(OPAQUE, 'g')] } });

    await expect(
      executor.execute({
        criterionId: 'E4-01',
        surface: 'http',
        params: {
          probe: probe([assertion({ source: 'status' }, 'equals', '200')]),
          baseUrl: `not-a-url-${OPAQUE}`,
        },
      }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(OPAQUE) as unknown }),
    );
  });

  it('applies caller extraPatterns to a REJECTED path in the thrown error', async () => {
    const { executor } = harness({ redaction: { extraPatterns: [new RegExp(OPAQUE, 'g')] } });

    await expect(
      executor.execute({
        criterionId: 'E4-01',
        surface: 'http',
        params: {
          probe: probe([assertion({ source: 'status' }, 'equals', '200')], {
            path: `https://evil.example/${OPAQUE}`,
          }),
          baseUrl: 'http://127.0.0.1:1',
        },
      }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(OPAQUE) as unknown }),
    );
  });

  it('honours caller-supplied extra patterns for a secret with no assignment shape', async () => {
    const opaque = 'zzzz-opaque-credential-zzzz';
    const { baseUrl } = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`the value is ${opaque} and nothing else`);
    });
    const { executor, recorded, written } = harness({
      redaction: { extraPatterns: [new RegExp(opaque, 'g')] },
    });

    await run(executor, baseUrl, probe([assertion({ source: 'status' }, 'equals', '200')]));

    expect(JSON.stringify(recorded)).not.toContain(opaque);
    for (const file of written) {
      expect(file.contents).not.toContain(opaque);
    }
  });
});
