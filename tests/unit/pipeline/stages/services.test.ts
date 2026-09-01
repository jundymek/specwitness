import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../../src/config/index.js';
import { ConfigError } from '../../../../src/domain/errors.js';
import {
  createServiceGroupRegistry,
  createServicesStage,
  resolveServiceBaseUrl,
  READINESS_POLL_INTERVAL_MS,
  type ServicesStageDeps,
} from '../../../../src/pipeline/stages/services.js';

// The seeded credential is ASSEMBLED AT RUNTIME, never written as a literal —
// the harness's secret scanner correctly refuses a source file containing an
// `sk-…`-shaped string, and this project's rule is that nothing
// credential-shaped exists in the repository at all. Reused from story 3.4's
// fixture rather than duplicated: a second seeded-secret constant is a second
// thing to keep in step with the redactor.
import { SEEDED_API_KEY } from './gates.secrets.js';
import {
  declaredServices,
  infraErrorFrom,
  instantSleep,
  portProbe,
  processResult,
  recordingRegistry,
  recordingRunner,
  refusingRunner,
  servicesYaml,
  stageContext,
  SteppingClock,
  WORKTREE,
  type ServiceFixture,
} from './services.helpers.js';

/**
 * Story 4.1 — the services stage, unit level. Zero subprocesses; every port is a
 * fake. Real spawning, process groups and teardown live in
 * `tests/integration/services.test.ts`.
 */

/** An HTTP readiness probe replaying scripted statuses, recording every call. */
function httpProbe(
  ...statuses: readonly (number | 'unreachable')[]
): NonNullable<ServicesStageDeps['httpProbe']> & { readonly asked: string[] } {
  const asked: string[] = [];
  let index = 0;
  const probe = async (url: string): Promise<{ status: number | null }> => {
    asked.push(url);
    // The LAST scripted status repeats, so a test scripting "always 503" writes
    // one value rather than guessing how many polls the deadline allows.
    const scripted = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return { status: scripted === 'unreachable' ? null : (scripted ?? null) };
  };
  return Object.assign(probe, { asked });
}

function deps(overrides: Partial<ServicesStageDeps> = {}): ServicesStageDeps {
  return {
    services: {},
    runner: recordingRunner(),
    registry: recordingRegistry(),
    probePort: portProbe(),
    sleep: instantSleep(),
    // The hang guard is a REAL timer by design (it must survive an instant
    // injected `sleep`), so it is driven down rather than disabled. Tests whose
    // held spawn never settles hit it; every other test wins the race in a
    // microtask and never waits at all.
    settleGraceMs: 5,
    ...overrides,
  };
}

const READY_URL: ServiceFixture['ready'] = { url: 'http://127.0.0.1:4501/health' };

/** A clock stepping 400ms per read — past a 1s deadline within a few polls. */
const fastClock = (): SteppingClock => new SteppingClock('2026-09-01T00:00:00.000Z', 400);

describe('AC1 — the services stage starts declared services in the worktree', () => {
  it('returns ok and spawns nothing when no services are declared', async () => {
    const runner = refusingRunner();
    const stage = createServicesStage(deps({ services: {}, runner }));

    const result = await stage.run(stageContext());

    expect(result).toEqual({ status: 'ok', detail: 'no services declared' });
    expect(runner.calls).toEqual([]);
  });

  it('is the frozen stage name, wired or not', () => {
    expect(createServicesStage(deps()).name).toBe('services');
    expect(createServicesStage().name).toBe('services');
  });

  it('starts services in YAML DECLARATION ORDER, loaded through the real loader', async () => {
    // The point of the fixture: `services` is a `z.record`, so declaration order
    // is an emergent property of yaml + zod preserving object insertion order,
    // not something the schema guarantees. A hand-built object literal would
    // prove nothing about the real load path — this is what pins it, and the ids
    // are deliberately in an order that neither sorts nor reverse-sorts.
    const services = declaredServices([
      { id: 'zeta', run: 'node zeta.js', ready: READY_URL },
      { id: 'alpha', run: 'node alpha.js', ready: READY_URL },
      { id: 'mid', run: 'node mid.js', ready: READY_URL },
    ]);

    const runner = recordingRunner('pending', 'pending', 'pending');
    const stage = createServicesStage(deps({ services, runner, httpProbe: httpProbe(200) }));

    const result = await stage.run(stageContext());

    expect(result.status).toBe('ok');
    expect(runner.calls.map((call) => call.args.at(0))).toEqual(['zeta.js', 'alpha.js', 'mid.js']);
  });

  it('spawns in the WORKTREE, not the source repository', async () => {
    const services = declaredServices([{ id: 'api', run: 'node api.js', ready: READY_URL }]);
    const runner = recordingRunner('pending');

    await createServicesStage(deps({ services, runner, httpProbe: httpProbe(200) })).run(
      stageContext(),
    );

    expect(runner.calls.at(0)?.cwd).toBe(WORKTREE);
  });

  it("passes the service's declared env as {inherit: true, set}, withholding nothing", async () => {
    // Q16: config-declared `env` merged over a pass-through base. `withhold` is
    // for provider invocations (AD-4/FR-15), never for a project starting its
    // own services — withholding here would break a service that needs PATH.
    const services = declaredServices([
      { id: 'api', run: 'node api.js', env: { NODE_ENV: 'test', PORT: '4501' }, ready: READY_URL },
    ]);
    const runner = recordingRunner('pending');

    await createServicesStage(deps({ services, runner, httpProbe: httpProbe(200) })).run(
      stageContext(),
    );

    expect(runner.calls.at(0)?.env).toEqual({
      inherit: true,
      set: { NODE_ENV: 'test', PORT: '4501' },
    });
    expect(runner.calls.at(0)?.env.withhold).toBeUndefined();
  });

  it('passes {inherit: true} with no `set` when the service declares no env', async () => {
    const services = declaredServices([{ id: 'api', run: 'node api.js', ready: READY_URL }]);
    const runner = recordingRunner('pending');

    await createServicesStage(deps({ services, runner, httpProbe: httpProbe(200) })).run(
      stageContext(),
    );

    expect(runner.calls.at(0)?.env).toEqual({ inherit: true });
  });

  it('throws InfraError when services are declared but no worktree was created', async () => {
    // Exactly what `createGatesStage` does at the same point, and for the same
    // reason: falling back to the project root would start the operator's
    // services against the wrong tree and could write into their working
    // directory (AD-8, FR-19).
    const services = declaredServices([{ id: 'api', run: 'node api.js', ready: READY_URL }]);
    const runner = refusingRunner();

    const error = await infraErrorFrom(
      createServicesStage(deps({ services, runner })).run(stageContext({ worktreePath: null })),
    );

    expect(error.message).toContain('no verification worktree');
    expect(error.hint).toBeDefined();
    expect(runner.calls).toEqual([]);
  });

  it('returns ok WITHOUT a worktree when nothing is declared', async () => {
    // The refusal is about starting services in the wrong tree. With none
    // declared there is nothing to start, so demanding a worktree would fail a
    // legitimate configuration.
    const result = await createServicesStage(deps()).run(stageContext({ worktreePath: null }));

    expect(result.status).toBe('ok');
  });
});

describe('AC1 — readiness, both probe kinds, polled with a deadline', () => {
  it('polls a URL until 2xx: 503, 503, then 200 becomes ready on the third poll', async () => {
    // Proves POLLING rather than a single shot. A single-shot check passes on a
    // fast machine and fails on a loaded one, which is the flakiest possible
    // failure mode for this stage.
    const services = declaredServices([
      { id: 'api', run: 'node api.js', ready: { url: 'http://127.0.0.1:4501/health' } },
    ]);
    const probe = httpProbe(503, 503, 200);
    const sleep = instantSleep();

    const result = await createServicesStage(
      deps({ services, runner: recordingRunner('pending'), httpProbe: probe, sleep }),
    ).run(stageContext());

    expect(result.status).toBe('ok');
    expect(probe.asked).toEqual([
      'http://127.0.0.1:4501/health',
      'http://127.0.0.1:4501/health',
      'http://127.0.0.1:4501/health',
    ]);
    // Two waits, not three: the third poll answered 200, so nothing waits after it.
    expect(sleep.waits).toEqual([READINESS_POLL_INTERVAL_MS, READINESS_POLL_INTERVAL_MS]);
  });

  it('treats a connection refusal as NOT READY YET, not as an error', async () => {
    const services = declaredServices([
      { id: 'api', run: 'node api.js', ready: { url: 'http://127.0.0.1:4501/health' } },
    ]);

    const result = await createServicesStage(
      deps({
        services,
        runner: recordingRunner('pending'),
        httpProbe: httpProbe('unreachable', 'unreachable', 204),
        sleep: instantSleep(),
      }),
    ).run(stageContext());

    expect(result.status).toBe('ok');
  });

  it('accepts any 2xx and keeps polling on 3xx, 4xx and 5xx', async () => {
    const services = declaredServices([
      { id: 'api', run: 'node api.js', ready: { url: 'http://127.0.0.1:4501/health' } },
    ]);
    const probe = httpProbe(302, 404, 500, 299);

    const result = await createServicesStage(
      deps({
        services,
        runner: recordingRunner('pending'),
        httpProbe: probe,
        sleep: instantSleep(),
      }),
    ).run(stageContext());

    expect(result.status).toBe('ok');
    expect(probe.asked).toHaveLength(4);
  });

  it('polls a readiness COMMAND until it exits 0: 1, 1, then 0', async () => {
    const services = declaredServices([
      { id: 'api', run: 'node api.js', ready: { command: 'node probe.js' } },
    ]);
    // Call 1 is the service (pending); calls 2..4 are the readiness probe.
    const runner = recordingRunner(
      'pending',
      processResult({ exitCode: 1 }),
      processResult({ exitCode: 1 }),
      processResult({ exitCode: 0 }),
    );

    const result = await createServicesStage(deps({ services, runner, sleep: instantSleep() })).run(
      stageContext(),
    );

    expect(result.status).toBe('ok');
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls.slice(1).every((call) => call.args.at(0) === 'probe.js')).toBe(true);
    // The probe runs in the worktree too — it commonly curls the service.
    expect(runner.calls.at(1)?.cwd).toBe(WORKTREE);
  });

  it('classifies a MISSING readiness binary as an InfraError naming it, without burning the timeout', async () => {
    // A `not-found` probe binary is an environment defect, not a slow service.
    // Polling it until the deadline would waste `timeoutSec` and then report the
    // wrong cause entirely.
    const services = declaredServices([
      { id: 'api', run: 'node api.js', ready: { command: 'curl-that-is-missing --fail' } },
    ]);
    const runner = recordingRunner(
      'pending',
      processResult({ outcome: 'not-found', exitCode: null }),
    );

    const error = await infraErrorFrom(
      createServicesStage(deps({ services, runner, sleep: instantSleep() })).run(stageContext()),
    );

    expect(error.message).toContain('curl-that-is-missing');
    expect(error.message).toContain('api');
    // Exactly one probe attempt: it did not keep polling a binary that is absent.
    expect(runner.calls).toHaveLength(2);
  });
});

describe('AC2 — a service that never becomes ready is INFRASTRUCTURE, never FAIL', () => {
  const neverReady = declaredServices([
    {
      id: 'backend',
      run: 'node server.js',
      ready: { url: 'http://127.0.0.1:4501/health', timeoutSec: 1 },
    },
  ]);

  it('throws InfraError and records NO gate and NO criterion failure', async () => {
    // THE test of this story. Exit 1 tells a harness the branch has defects; the
    // branch may be perfect. Exit 3 says SpecWitness could not reach a
    // conclusion, which is what actually happened.
    const context = stageContext({ clock: fastClock() });

    const error = await infraErrorFrom(
      createServicesStage(
        deps({
          services: neverReady,
          runner: recordingRunner('pending'),
          httpProbe: httpProbe(503),
          sleep: instantSleep(),
        }),
      ).run(context),
    );

    expect(error.message).toContain('backend');
    expect(error.message).toContain('ready');
    expect(error.hint).toBeDefined();

    // The two things that must NOT have happened.
    expect(context.run.gates).toEqual([]);
    expect(context.run.criteria).toEqual([]);
  });

  it("attaches the service's captured output as `command` evidence before throwing", async () => {
    // Q29. The accumulator survives a thrown stage, so this is what reaches the
    // report — an operator told "backend never became ready" with no output from
    // the service has been told nothing.
    //
    // The settle is driven BY THE RELEASE, which is the real causality: a held
    // spawn publishes nothing until its group is torn down, and tearing it down
    // is what makes `run()` settle with the bytes the service printed.
    const context = stageContext({ clock: fastClock() });
    const runner = recordingRunner('pending');
    const registry = recordingRegistry(() =>
      runner.settle(
        0,
        processResult({
          outcome: 'completed',
          exitCode: 1,
          stdout: 'listening on 4501\n',
          stderr: 'FATAL: could not connect to database\n',
        }),
      ),
    );

    await infraErrorFrom(
      createServicesStage(
        deps({
          services: neverReady,
          runner,
          registry,
          httpProbe: httpProbe(503),
          sleep: instantSleep(),
        }),
      ).run(context),
    );

    // The failed service was torn down by the stage, not left for teardown.
    expect(registry.released.map((entry) => entry.serviceId)).toEqual(['backend']);

    const evidence = context.run.evidence.at(0);
    expect(evidence?.kind).toBe('command');
    expect(evidence).toMatchObject({ commandId: 'backend', displayCommand: 'node server.js' });
    expect(JSON.stringify(evidence)).toContain('could not connect to database');
  });

  it('does not leak a seeded secret from service output into evidence or the error', async () => {
    // Capture output is UNTRUSTED text and is redacted UNDECLARED — the
    // fail-closed default. `{shellCommand: true}` is reserved for declared
    // commands, i.e. text the project owner wrote (Epic 3 retro §6).
    const context = stageContext({ clock: fastClock() });
    const runner = recordingRunner('pending');
    const registry = recordingRegistry(() =>
      runner.settle(
        0,
        processResult({
          outcome: 'completed',
          exitCode: 1,
          stdout: `boot: ANTHROPIC_API_KEY=${SEEDED_API_KEY}\n`,
          // The header-prefixed form, not just the assignment form: `curl -v`
          // writes request headers this way and every logger prepends a level,
          // and a redaction anchored to the start of a line misses both.
          stderr: `> Authorization: Bearer ${SEEDED_API_KEY}\n`,
        }),
      ),
    );

    const error = await infraErrorFrom(
      createServicesStage(
        deps({
          services: neverReady,
          runner,
          registry,
          httpProbe: httpProbe(503),
          sleep: instantSleep(),
        }),
      ).run(context),
    );

    expect(JSON.stringify(context.run.evidence)).not.toContain(SEEDED_API_KEY);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain(SEEDED_API_KEY);
  });

  it('diagnoses a service that EXITS before becoming ready, without waiting out the deadline', async () => {
    // A crashed service is the case an operator hits most, and burning the full
    // `timeoutSec` before saying so reports the wrong cause slowly.
    const context = stageContext();
    const runner = recordingRunner(
      processResult({ outcome: 'completed', exitCode: 1, stderr: 'EADDRINUSE\n' }),
    );

    const error = await infraErrorFrom(
      createServicesStage(
        deps({ services: neverReady, runner, httpProbe: httpProbe(503), sleep: instantSleep() }),
      ).run(context),
    );

    expect(error.message).toContain('backend');
    expect(error.message).toContain('exited');
    expect(JSON.stringify(context.run.evidence)).toContain('EADDRINUSE');
  });
});

describe('AC1/Q27 — an occupied declared port is an InfraError naming the port', () => {
  it('refuses BEFORE spawning anything', async () => {
    const services = declaredServices([
      { id: 'web', run: 'node web.js', port: 4599, ready: READY_URL },
    ]);
    const runner = refusingRunner();

    const error = await infraErrorFrom(
      createServicesStage(
        deps({ services, runner, probePort: portProbe({ 4599: 'EADDRINUSE' }) }),
      ).run(stageContext()),
    );

    expect(error.message).toContain('4599');
    expect(error.message).toContain('web');
    expect(error.hint).toBeDefined();
    expect(runner.calls).toEqual([]);
  });

  it('skips the check for a service that declares no port', async () => {
    const services = declaredServices([{ id: 'api', run: 'node api.js', ready: READY_URL }]);
    const probe = portProbe();

    await createServicesStage(
      deps({
        services,
        runner: recordingRunner('pending'),
        probePort: probe,
        httpProbe: httpProbe(200),
      }),
    ).run(stageContext());

    expect(probe.asked).toEqual([]);
  });
});

describe('AC3 — every service process group is registered for teardown', () => {
  it('registers each pgid, keyed by service id', async () => {
    const services = declaredServices([
      { id: 'api', run: 'node api.js', ready: READY_URL },
      { id: 'worker', run: 'node worker.js', ready: READY_URL },
    ]);
    const registry = recordingRegistry();

    await createServicesStage(
      deps({
        services,
        runner: recordingRunner('pending', 'pending'),
        registry,
        httpProbe: httpProbe(200),
      }),
    ).run(stageContext());

    expect(registry.registered.map((entry) => entry.serviceId)).toEqual(['api', 'worker']);
    expect(registry.registered.every((entry) => entry.pgid > 0)).toBe(true);
  });

  it('registers the pgid of a service that then FAILS readiness', async () => {
    // The most important teardown case: a service that started but never
    // answered is precisely the process most likely to be left running.
    const services = declaredServices([
      { id: 'backend', run: 'node server.js', ready: { url: 'http://x/health', timeoutSec: 1 } },
    ]);
    const registry = recordingRegistry();

    await infraErrorFrom(
      createServicesStage(
        deps({
          services,
          runner: recordingRunner('pending'),
          registry,
          httpProbe: httpProbe(503),
          sleep: instantSleep(),
        }),
      ).run(stageContext({ clock: fastClock() })),
    );

    // The append-only log, not the live set: the stage tears the failed service
    // down on its way out, which correctly drains it from the live set.
    expect(registry.registrations.map((entry) => entry.serviceId)).toEqual(['backend']);
    expect(registry.released.map((entry) => entry.serviceId)).toEqual(['backend']);
  });

  it("forwards the caller's onProcessGroup so the pgid is recorded durably", async () => {
    const services = declaredServices([{ id: 'api', run: 'node api.js', ready: READY_URL }]);
    const recorded: number[] = [];

    await createServicesStage(
      deps({
        services,
        runner: recordingRunner('pending'),
        httpProbe: httpProbe(200),
        onProcessGroup: (pgid) => {
          recorded.push(pgid);
        },
      }),
    ).run(stageContext());

    expect(recorded).toHaveLength(1);
    expect(recorded.at(0)).toBeGreaterThan(0);
  });
});

describe('createServiceGroupRegistry — the seam story 4.7 binds into teardown', () => {
  /** A terminate that records, and fails for the pgids it is told to fail on. */
  function terminator(...failing: readonly number[]) {
    const signalled: number[] = [];
    const terminate = async (pgid: number): Promise<void> => {
      signalled.push(pgid);
      if (failing.includes(pgid)) {
        throw new Error(`pgid ${pgid} survived SIGKILL`);
      }
    };
    return Object.assign(terminate, { signalled });
  }

  it('terminates every registered group', async () => {
    const terminate = terminator();
    const registry = createServiceGroupRegistry({ terminate });
    registry.register('api', 101);
    registry.register('worker', 102);

    await registry.releaseAll();

    expect(terminate.signalled).toEqual([101, 102]);
  });

  it('does NOT stop at the first failure', async () => {
    // The subtlety worth a test: one unkillable group must not leave every other
    // service running. Failures are collected and raised together at the end.
    const terminate = terminator(101);
    const registry = createServiceGroupRegistry({ terminate });
    registry.register('api', 101);
    registry.register('worker', 102);
    registry.register('cache', 103);

    await expect(registry.releaseAll()).rejects.toThrow(/could not be torn down/);

    expect(terminate.signalled).toEqual([101, 102, 103]);
  });

  it('is idempotent — a second releaseAll signals nothing', async () => {
    // The teardown stage runs after an early stop, after a thrown error, and
    // after an error thrown by teardown itself. A second round of signals at
    // pids that may since have been REUSED is the failure this prevents.
    const terminate = terminator();
    const registry = createServiceGroupRegistry({ terminate });
    registry.register('api', 101);

    await registry.releaseAll();
    await registry.releaseAll();

    expect(terminate.signalled).toEqual([101]);
  });

  it('forgets a group even when terminating it failed', async () => {
    const terminate = terminator(101);
    const registry = createServiceGroupRegistry({ terminate });
    registry.register('api', 101);

    await expect(registry.releaseAll()).rejects.toThrow();
    await registry.releaseAll();

    expect(terminate.signalled).toEqual([101]);
  });

  it('releases ONE service without touching the others', async () => {
    // The readiness-failure path uses this to collect a failed service's output;
    // the rest must stay live for the teardown stage.
    const terminate = terminator();
    const registry = createServiceGroupRegistry({ terminate });
    registry.register('api', 101);
    registry.register('worker', 102);

    await registry.release('api');

    expect(terminate.signalled).toEqual([101]);

    await registry.releaseAll();
    expect(terminate.signalled).toEqual([101, 102]);
  });

  it('releasing an unknown service is a no-op, not an error', async () => {
    const terminate = terminator();
    const registry = createServiceGroupRegistry({ terminate });

    await expect(registry.release('never-started')).resolves.toBeUndefined();
    expect(terminate.signalled).toEqual([]);
  });
});

describe('the base-URL seam story 4.4 consumes', () => {
  function configWith(services: readonly ServiceFixture[]) {
    const root = mkdtempSync(join(tmpdir(), 'specwitness-baseurl-'));
    mkdirSync(join(root, '.specwitness'));
    writeFileSync(join(root, '.specwitness', 'config.yaml'), servicesYaml(services));
    return loadConfig(root);
  }

  it('derives a base URL from the declared port, on localhost', () => {
    const config = configWith([
      { id: 'backend', run: 'node server.js', port: 4501, ready: READY_URL },
    ]);

    expect(resolveServiceBaseUrl(config, 'backend')).toBe('http://127.0.0.1:4501');
  });

  it("falls back to the readiness URL's ORIGIN when no port is declared", () => {
    const config = configWith([
      { id: 'backend', run: 'node server.js', ready: { url: 'http://localhost:8080/healthz' } },
    ]);

    expect(resolveServiceBaseUrl(config, 'backend')).toBe('http://localhost:8080');
  });

  it('throws ConfigError naming the declared ids for an undeclared service', () => {
    // Mirrors `getObservationCommand`: it throws rather than returning a
    // fallback, because quietly substituting anything would be a hole in the
    // AD-3 boundary.
    const config = configWith([
      { id: 'backend', run: 'node server.js', port: 4501, ready: READY_URL },
      { id: 'worker', run: 'node worker.js', port: 4502, ready: READY_URL },
    ]);

    expect(() => resolveServiceBaseUrl(config, 'frontend')).toThrow(ConfigError);
    try {
      resolveServiceBaseUrl(config, 'frontend');
      expect.unreachable('resolveServiceBaseUrl must throw for an undeclared id');
    } catch (error) {
      expect((error as ConfigError).hint).toContain('backend');
      expect((error as ConfigError).hint).toContain('worker');
    }
  });

  it('throws ConfigError when a service declares neither a port nor a URL probe', () => {
    // No production defaults, ever: a service reachable only through a command
    // probe has told us nothing about where it listens, and inventing
    // `http://127.0.0.1:3000` would be exactly the synthesised URL AD-3 forbids.
    const config = configWith([
      { id: 'backend', run: 'node server.js', ready: { command: 'node probe.js' } },
    ]);

    expect(() => resolveServiceBaseUrl(config, 'backend')).toThrow(ConfigError);
  });

  it('does not resolve a prototype key as a declared service', () => {
    // Own-property check, same reason as `getObservationCommand`: a prototype
    // walk would resolve `constructor` into something that is not a service.
    const config = configWith([
      { id: 'backend', run: 'node server.js', port: 4501, ready: READY_URL },
    ]);

    expect(() => resolveServiceBaseUrl(config, 'constructor')).toThrow(ConfigError);
  });
});
