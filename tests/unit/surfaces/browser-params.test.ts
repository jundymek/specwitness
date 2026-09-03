/**
 * The browser executor's PRE-I/O contract — story 5.2, tasks 1, 2 and 4.
 *
 * Everything here asserts something that must be settled BEFORE a browser is launched, so
 * every test in this file runs with a `ProcessRunner` that THROWS if it is called. That is
 * the assertion, not a convenience: `http.ts:52-59` states the rule all four surfaces
 * follow — a malformed probe is a WIRING OR TOOLING DEFECT, SpecWitness being wrong, and it
 * throws `InfraError` before any I/O rather than surfacing as an `execError`, because both
 * routes end at exit 3 and only one is honest about whose fault it is. A spawning runner
 * would let a refusal that fired too late pass unnoticed.
 *
 * ⚠️ A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS. Nothing in this file
 * skips, but the sentence belongs in every browser test file: the PRODUCTION code has no
 * skip path at all, and conflating the two is Epic 4 retro §2 observation 2 arriving a
 * third time.
 */

import { describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import type { Evidence } from '../../../src/domain/evidence.js';
import type { BrowserProbeMechanics } from '../../../src/domain/plan.js';
import {
  BrowserSurfaceExecutor,
  type BrowserExecutorDeps,
  type BrowserRuntimeEnvironment,
} from '../../../src/surfaces/browser.js';

const READY: BrowserRuntimeEnvironment = {
  ready: true,
  packageDir: '/opt/playwright',
  cliPath: '/opt/playwright/cli.js',
  browsersPath: '/opt/browsers',
};

/** Deps whose every side effect FAILS LOUDLY, so a refusal that fires late cannot hide. */
function deps(overrides: Partial<BrowserExecutorDeps> = {}): BrowserExecutorDeps {
  return {
    clock: { now: () => new Date('2026-09-03T00:00:00.000Z') },
    runner: {
      run: async () => {
        throw new Error('the executor spawned a process it should have refused before');
      },
    },
    cwd: '/workspace',
    environment: READY,
    writeEvidence: async () => {
      throw new Error('the executor wrote evidence it should have refused before');
    },
    writeEvidenceBytes: async () => {
      throw new Error('the executor wrote evidence it should have refused before');
    },
    resolveRunPath: (path) => `/run/${path}`,
    recordEvidence: (_evidence: Evidence) => {
      throw new Error('the executor recorded evidence it should have refused before');
    },
    ...overrides,
  };
}

const ASSERTION = {
  description: 'the heading says Orders',
  target: { source: 'text', selector: 'h1' },
  comparison: 'equals',
  expected: 'Orders',
};

function probe(mechanics: Partial<Record<string, unknown>> = {}, rest: Record<string, unknown> = {}) {
  return {
    id: 'orders-page',
    surface: 'browser',
    mechanics: {
      serviceId: 'web',
      path: '/orders',
      scenario: 'click "#refresh"',
      ...mechanics,
    },
    assertions: [ASSERTION],
    ...rest,
  };
}

async function refusal(params: Record<string, unknown>, surface = 'browser'): Promise<InfraError> {
  const error = await new BrowserSurfaceExecutor(deps())
    .execute({ criterionId: 'E5-01', surface: surface as 'browser', params })
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

  expect(error, 'the executor accepted params it should have refused').toBeInstanceOf(InfraError);
  return error as InfraError;
}

const OK = { probe: probe(), baseUrl: 'http://127.0.0.1:4000' };

describe('a malformed browser probe is InfraError BEFORE any I/O, never an execError', () => {
  it('refuses params with no probe', async () => {
    const error = await refusal({ baseUrl: 'http://127.0.0.1:4000' });

    expect(error.message).toContain("no 'probe' was passed");
  });

  it('refuses a request routed to another surface — a DISPATCHER defect, made visible', async () => {
    // Executing it anyway because the nested probe happened to say `browser` would mask
    // exactly the wiring bug the routing contract exists to surface.
    const error = await refusal(OK, 'http');

    expect(error.message).toContain("not 'browser'");
  });

  it('refuses a probe declaring another surface', async () => {
    const error = await refusal({ ...OK, probe: probe({}, { surface: 'http' }) });

    expect(error.message).toContain("not 'browser'");
  });

  it('refuses a probe with no id — it is part of every evidence filename', async () => {
    const error = await refusal({ ...OK, probe: probe({}, { id: '   ' }) });

    expect(error.message).toContain("no string 'id'");
  });

  it('refuses a probe naming no declared service (AD-3)', async () => {
    const error = await refusal({ ...OK, probe: probe({ serviceId: '' }) });

    expect(error.message).toContain('mechanics.serviceId');
  });

  it('refuses a probe with no scenario', async () => {
    const error = await refusal({ ...OK, probe: probe({ scenario: '   ' }) });

    expect(error.message).toContain('mechanics.scenario');
  });

  it('refuses a probe that adjudicates nothing — it cannot mint a PASS', async () => {
    const error = await refusal({ ...OK, probe: probe({}, { assertions: [] }) });

    expect(error.message).toContain('no assertions');
  });

  it('refuses an assertion target outside the closed union', async () => {
    const error = await refusal({
      ...OK,
      probe: probe({}, { assertions: [{ ...ASSERTION, target: { source: 'cookie' } }] }),
    });

    expect(error.hint).toContain('BrowserAssertionTarget is a closed union');
  });

  it('refuses a comparison outside ASSERTION_COMPARISONS', async () => {
    const error = await refusal({
      ...OK,
      probe: probe({}, { assertions: [{ ...ASSERTION, comparison: 'matchesRegex' }] }),
    });

    expect(error.hint).toContain('ASSERTION_COMPARISONS is closed');
  });

  it('refuses a text/visible assertion with no selector, BEFORE the browser launches', async () => {
    // Left to the driver, this becomes a `page.locator()` throw AFTER a browser has been
    // launched and a page navigated — past the point this validator promised to catch it,
    // leaving a run that really did open a browser with an unclassified failure.
    const error = await refusal({
      ...OK,
      probe: probe({}, { assertions: [{ ...ASSERTION, target: { source: 'visible' } }] }),
    });

    expect(error.message).toContain('with no selector');
  });

  it('refuses an assertion that is not even an object', async () => {
    const error = await refusal({ ...OK, probe: probe({}, { assertions: [null] }) });

    expect(error.message).toContain('is not an object');
  });

  it('refuses a missing baseUrl, naming why the CALLER resolves it', async () => {
    const error = await refusal({ probe: probe() });

    expect(error.message).toContain("no 'baseUrl' was passed");
    expect(error.hint).toContain('src/config');
  });

  it('refuses an attempt that is not a positive integer', async () => {
    const error = await refusal({ ...OK, attempt: 0 });

    expect(error.message).toContain('not a positive integer');
  });
});

describe('AD-3: a browser probe can only ever be driven at the resolved service origin', () => {
  it.each([
    ['an absolute https URL', 'https://evil.example.com/steal'],
    ['a protocol-relative URL — the version that LOOKS like a path', '//evil.example.com/steal'],
    ['a backslash-separated path', '/orders\\..\\admin'],
    ['a path carrying whitespace', '/orders admin'],
  ])('refuses %s as a probe path', async (_label, path) => {
    const error = await refusal({ ...OK, probe: probe({ path }) });

    expect(error.message).toContain('is not service-relative');
  });

  it.each([
    ['an absolute https URL', 'goto "https://evil.example.com/steal"'],
    ['a protocol-relative URL', 'goto "//evil.example.com/steal"'],
    ['a file URL', 'goto "file:///etc/passwd"'],
  ])('refuses %s inside a scenario goto — the only place a plan could name a host', async (_l, scenario) => {
    // `BrowserProbeMechanics` has NO url field, so a hostile plan's only remaining move is
    // to write one into the scenario prose. This is where that is closed.
    const error = await refusal({ ...OK, probe: probe({ scenario }) });

    expect(error.message).toContain('not service-relative');
    expect(error.hint).toContain('AD-3');
  });

  it('the plan CANNOT express a URL at all — asserted on the type, so a widening breaks this', () => {
    // The absence of a url field IS the AD-3 property (`plan.ts:230-266`), and 5.6 depends
    // on the mechanics/assertions split staying exactly as it is. A future story that adds
    // one turns this into a compile error rather than a quiet loss of the guarantee.
    type MechanicsKeys = keyof BrowserProbeMechanics;
    const urlLike: Extract<MechanicsKeys, 'url' | 'href' | 'origin' | 'baseUrl'> extends never
      ? true
      : false = true;

    expect(urlLike).toBe(true);
    // And the runtime half, so the assertion is legible to a reader who does not read types.
    const mechanics: BrowserProbeMechanics = {
      serviceId: 'web',
      path: '/orders',
      scenario: 'click "#refresh"',
    };
    expect(Object.keys(mechanics).sort()).toEqual(['path', 'scenario', 'serviceId']);
  });
});

describe('the scenario grammar refuses rather than ignores', () => {
  it('refuses free prose — the green-for-nothing route this story exists to close', async () => {
    // ⚠️ THE LOAD-BEARING TEST OF THIS FILE. Ignoring an unparseable line and navigating
    // anyway would report a UI criterion as verified WITHOUT the interaction that makes the
    // assertion mean anything. There is no AI at execution time and there must never be one.
    const error = await refusal({
      ...OK,
      probe: probe({ scenario: 'Log in as alice and then click the Submit button.' }),
    });

    expect(error.message).toContain('is not a directive this executor can perform');
    expect(error.hint).toContain('refused rather than ignored');
  });

  it('refuses an unknown verb', async () => {
    const error = await refusal({ ...OK, probe: probe({ scenario: 'evaluate "alert(1)"' }) });

    expect(error.message).toContain('not a directive');
  });

  it('refuses unquoted arguments rather than splitting them on whitespace', async () => {
    // A selector may legitimately contain spaces, so guessing would run a directive nobody
    // wrote.
    const error = await refusal({ ...OK, probe: probe({ scenario: 'click #submit' }) });

    expect(error.message).toContain('not a sequence of quoted strings');
  });

  it('refuses an unterminated quote', async () => {
    const error = await refusal({ ...OK, probe: probe({ scenario: 'click "#submit' }) });

    expect(error.message).toContain('not a sequence of quoted strings');
  });

  it.each([
    ['click with two arguments', 'click "#a" "#b"'],
    ['fill with one argument', 'fill "#email"'],
    ['goto with two arguments', 'goto "/a" "/b"'],
  ])('refuses %s — wrong arity is not guessed at', async (_label, scenario) => {
    await refusal({ ...OK, probe: probe({ scenario }) });
  });

  it('names the offending LINE, so an author can fix it without bisecting', async () => {
    const error = await refusal({
      ...OK,
      probe: probe({ scenario: '# a comment\nclick "#one"\n\nthen do the needful' }),
    });

    expect(error.message).toContain('line 4');
  });
});

describe('an unprovisioned Playwright is InfraError — NEVER a skip', () => {
  it("refuses with 5.1's own reason, verbatim rather than paraphrased", async () => {
    // The row of the classification table the standing green-for-nothing hazard would
    // otherwise reach: a criterion the plan mapped to a browser check reporting PASS
    // because no probe ran. `resolvePlaywrightEnvironment` computed this sentence and it
    // names the path it rejected, so it is quoted rather than restated.
    const reason = '@playwright/test resolved from /elsewhere, outside the project';
    const executor = new BrowserSurfaceExecutor(
      deps({ environment: { ready: false, browsersPath: '/x', reason } }),
    );

    const error = await executor
      .execute({ criterionId: 'E5-01', surface: 'browser', params: OK })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain(reason);
    expect((error as InfraError).hint).toContain('never skipped');
  });

  it('refuses a "ready" environment that carries no CLI path — checked, not trusted', async () => {
    const executor = new BrowserSurfaceExecutor(
      deps({ environment: { ready: true, packageDir: '/opt/pw', browsersPath: '/x' } }),
    );

    const error = await executor
      .execute({ criterionId: 'E5-01', surface: 'browser', params: OK })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain('no CLI entry point');
  });
});
