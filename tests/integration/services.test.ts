import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type ServiceConfig } from '../../src/config/index.js';
import { InfraError } from '../../src/domain/errors.js';
import type { RunAccumulator, StageContext } from '../../src/pipeline/stage.js';
import type { RunResult } from '../../src/domain/run-result.js';
import { createProcessRunner, terminateProcessGroup } from '../../src/infra/process-runner.js';
import {
  createServiceGroupRegistry,
  createServicesStage,
  fetchReadiness,
  type ServiceGroupRegistry,
  type ServicesStageDeps,
} from '../../src/pipeline/stages/services.js';
import { SystemClock } from '../../src/infra/clock.js';

/**
 * Story 4.1 against REAL processes, real sockets and real teardown.
 *
 * This is the file most able to leak the thing it is about — the story spawns
 * long-lived children by definition — so it inherits the safety discipline story
 * 3.2 established in `tests/integration/process-runner-groups.test.ts`:
 *
 *  - every pid a test causes to exist is registered with `trackPid`;
 *  - `afterEach` RECORDS anything still alive before force-killing it, so the
 *    safety net can never be what makes an assertion pass;
 *  - `afterAll` asserts the recording is empty.
 *
 * Scoped to pids THIS FILE created rather than a machine-wide `ps` sweep: several
 * agents run this suite concurrently on one machine (H-8), and a global orphan
 * count would fail on a peer's healthy children. Every scratch directory is an
 * `mkdtemp` and every port is ephemeral, for the same reason.
 */

const NODE = process.execPath;

/** Pids this file caused to exist, killed in `afterEach` no matter what. */
const tracked = new Set<number>();
const leaked: number[] = [];
const scratchDirs: string[] = [];
const openServers: (Server | SocketServer)[] = [];
/** Raw sockets held open by the silent-server fixture; destroyed in afterEach. */
const sockets: import('node:net').Socket[] = [];

function trackPid(pid: number): number {
  tracked.add(pid);
  return pid;
}

/** `kill(pid, 0)` is the portable liveness probe: it signals nothing. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Bounded poll for a pid to disappear: fast when passing, bounded when failing. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

/** Waits for a file to appear NON-EMPTY and returns its trimmed contents. */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(path, 'utf8')).trim();
      if (text !== '') {
        return text;
      }
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${path} never appeared`);
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'specwitness-services-int-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const pid of tracked) {
    if (isAlive(pid)) {
      leaked.push(pid);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // raced us to exit
        }
      }
    }
  }
  tracked.clear();

  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  expect(
    leaked,
    `these pids survived the code that was supposed to reap them: ${leaked.join(', ')}`,
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Real `ServiceConfig`s, minted only the way the product can mint them. */
function declaredServices(yaml: string): Record<string, ServiceConfig> {
  const root = mkdtempSync(join(tmpdir(), 'specwitness-services-cfg-'));
  scratchDirs.push(root);
  mkdirSync(join(root, '.specwitness'));
  writeFileSync(join(root, '.specwitness', 'config.yaml'), yaml);
  return { ...loadConfig(root).services };
}

/**
 * A local HTTP server on an EPHEMERAL port that answers `notReadyTimes` 503s
 * and 200 thereafter.
 *
 * `listen(0)` then read the assigned port: a fixed port would collide with a
 * peer agent running this same suite concurrently (H-8), and this suite's whole
 * subject is what happens when a port is already taken.
 */
async function readinessServer(notReadyTimes = 0): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(hits <= notReadyTimes ? 503 : 200);
    response.end('ok');
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not report a port');
  }
  return { port: address.port, hits: () => hits };
}

/** Occupies an ephemeral port for the Q27 test, and reports which one. */
async function occupiedPort(): Promise<number> {
  const server = createSocketServer();
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture listener did not report a port');
  }
  return address.port;
}

/** The real localhost bind probe, identical in behaviour to doctor's. */
const probePort: ServicesStageDeps['probePort'] = async (port, host) =>
  await new Promise((resolve) => {
    const server = createSocketServer();
    let settled = false;
    const settle = (result: { free: boolean; reason?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close(() => resolve(result));
    };
    server.once('error', (error: NodeJS.ErrnoException) => {
      settled = true;
      server.close();
      resolve({ free: false, reason: error.code ?? error.message });
    });
    server.once('listening', () => settle({ free: true }));
    server.listen({ port, host, exclusive: true });
  });

/**
 * The registry story 4.7 binds, built from the SHIPPED factory.
 *
 * Deliberately not a hand-rolled double: the factory is what 4.7 will actually
 * use, so the tests that prove teardown is total must exercise it rather than a
 * lookalike. `live` is exposed only so assertions can name a pgid.
 */
function realRegistry(graceMs = 500): ServiceGroupRegistry & { readonly live: Map<string, number> } {
  const live = new Map<string, number>();
  const registry = createServiceGroupRegistry({ terminate: terminateProcessGroup, graceMs });
  return {
    live,
    register(serviceId, pgid) {
      live.set(serviceId, pgid);
      registry.register(serviceId, pgid);
    },
    async release(serviceId) {
      live.delete(serviceId);
      await registry.release(serviceId);
    },
    async releaseAll() {
      live.clear();
      await registry.releaseAll();
    },
  };
}

function stageContext(worktreePath: string): StageContext {
  const run: RunAccumulator = {
    epic: 'epic-7',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    gates: [],
    criteria: [],
    evidence: [],
    providerUsage: [],
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      specwitnessVersion: '0.1.0',
      worktreePath,
      runDirectory: '.specwitness/runs/run-20260901T000000Z-ab12',
    },
    contractCriteria: [],
  };

  return {
    runId: 'run-20260901T000000Z-ab12',
    clock: new SystemClock(),
    run,
    snapshot: (): RunResult => {
      throw new Error('the services stage must not call snapshot()');
    },
  };
}

/**
 * A service that FORKS a grandchild and waits, plus the grandchild that records
 * its own pid.
 *
 * The grandchild is the point: a bare-pid kill reaches the direct child only and
 * leaves descendants running — story 3.2 measured exactly that. `sh` with a
 * fixed argv is a test FIXTURE, not a shell escape: AD-3 constrains `src/**`,
 * where there is no `shell` option and no command string anywhere on the path.
 */
async function forkingService(
  dir: string,
): Promise<{ script: string; child: string; pidFile: string }> {
  const child = join(dir, `grandchild-${String(scriptCounter++)}.js`);
  const pidFile = join(dir, `grandchild-${String(scriptCounter)}.pid`);
  const script = join(dir, `forks-${String(scriptCounter)}.sh`);

  await writeFile(
    child,
    ['process.stdout.write(String(process.pid));', 'setTimeout(() => {}, 600000);'].join('\n'),
  );
  await writeFile(script, ['#!/bin/sh', '"$1" "$2" > "$3" &', 'wait'].join('\n'), { mode: 0o755 });

  return { script, child, pidFile };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * A service script written to a FILE rather than passed with `node -e`.
 *
 * Not a style choice. Declared commands are split into argv WITHOUT a shell
 * (AD-3), so quote characters are grouping syntax and are consumed by the split:
 * `node -e console.log("booting")` reaches the child as
 * `console.log(booting)`, which throws a ReferenceError and exits immediately.
 * That is correct product behaviour — and it is precisely why a fixture that
 * needs a string literal must live in a file with no quoting for the splitter to
 * interpret.
 */
async function serviceScript(dir: string, body: readonly string[]): Promise<string> {
  const file = join(dir, `service-${String(scriptCounter++)}.js`);
  await writeFile(file, body.join('\n'));
  return file;
}

let scriptCounter = 0;

/** A service that stays up forever and prints one line first. */
const STAYS_UP = ["console.log('booting');", 'setTimeout(() => {}, 600000);'];

const runner = () => createProcessRunner(new SystemClock());

function deps(overrides: Partial<ServicesStageDeps>): ServicesStageDeps {
  return {
    services: {},
    runner: runner(),
    registry: realRegistry(),
    probePort,
    httpProbe: fetchReadiness,
    pollIntervalMs: 50,
    ...overrides,
  };
}

describe('AC1 — a real service starts in the worktree and is polled until healthy', () => {
  it('starts a real HTTP service and waits for a real 2xx', async () => {
    const dir = await scratch();
    const serviceServer = await readinessServer();
    const script = await serviceScript(dir, STAYS_UP);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  api:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${serviceServer.port}/health"`,
        '      timeoutSec: 10',
      ].join('\n'),
    );

    const registry = realRegistry();
    const stage = createServicesStage(deps({ services, registry }));
    const context = stageContext(dir);

    const result = await stage.run(context);

    expect(result.status).toBe('ok');
    expect(serviceServer.hits()).toBeGreaterThanOrEqual(1);

    const pgid = registry.live.get('api');
    expect(pgid).toBeGreaterThan(0);
    trackPid(pgid as number);

    // AC3: teardown reaps it.
    await registry.releaseAll();
    expect(await waitForExit(pgid as number)).toBe(true);
  });

  it('polls a real server that answers 503 twice before 200', async () => {
    const dir = await scratch();
    const server = await readinessServer(2);
    const script = await serviceScript(dir, STAYS_UP);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  api:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${server.port}/health"`,
        '      timeoutSec: 10',
      ].join('\n'),
    );

    const registry = realRegistry();
    const result = await createServicesStage(deps({ services, registry })).run(stageContext(dir));

    expect(result.status).toBe('ok');
    // Three real requests: two 503s and the 200 that ended the wait. This is the
    // proof that readiness POLLS rather than checking once.
    expect(server.hits()).toBe(3);

    const pgid = trackPid(registry.live.get('api') as number);
    await registry.releaseAll();
    expect(await waitForExit(pgid)).toBe(true);
  });
});

describe('AC2 — a service that never becomes ready ends the run InfraError, not FAIL', () => {
  it('throws InfraError, records no gate, and leaves NOTHING running', async () => {
    const dir = await scratch();
    // A real process that runs forever and answers nothing. The readiness URL
    // points at a port nothing is listening on, so every poll is a real
    // connection refusal — the state is PRODUCED, not mocked.
    const deadPort = await occupiedPortThenFree();
    const script = await serviceScript(dir, STAYS_UP);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  backend:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${deadPort}/health"`,
        '      timeoutSec: 1',
      ].join('\n'),
    );

    const registry = realRegistry();
    const context = stageContext(dir);
    let pgid = 0;

    const error = await createServicesStage(
      deps({
        services,
        registry,
        onProcessGroup: (value) => {
          pgid = trackPid(value);
        },
      }),
    )
      .run(context)
      .then(
        (resolved) => {
          throw new Error(`expected an InfraError, got ${JSON.stringify(resolved)}`);
        },
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain('backend');

    // The classification assertions: no product-negative signal anywhere.
    expect(context.run.gates).toEqual([]);
    expect(context.run.criteria).toEqual([]);

    // The teardown assertion: the process that would not become ready is the one
    // most likely to be left running, so it is asserted BY PID.
    expect(pgid).toBeGreaterThan(0);
    expect(await waitForExit(pgid)).toBe(true);
    expect(registry.live.size).toBe(0);

    // AC2's evidence: real bytes the service printed, not a placeholder.
    expect(JSON.stringify(context.run.evidence)).toContain('booting');
  });

  it('reaps a GRANDCHILD of a service that never becomes ready', async () => {
    // The whole point of the process group. A bare-pid kill reaches the direct
    // child only and leaves its descendants running — measured in story 3.2.
    const dir = await scratch();
    const deadPort = await occupiedPortThenFree();
    const { script, child, pidFile } = await forkingService(dir);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  backend:',
        `    run: ${JSON.stringify(`/bin/sh ${script} ${NODE} ${child} ${pidFile}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${deadPort}/health"`,
        '      timeoutSec: 3',
      ].join('\n'),
    );

    const registry = realRegistry();
    let pgid = 0;
    const pending = createServicesStage(
      deps({
        services,
        registry,
        onProcessGroup: (value) => {
          pgid = trackPid(value);
        },
      }),
    ).run(stageContext(dir));

    const grandchild = trackPid(Number(await waitForFile(pidFile)));
    expect(Number.isInteger(grandchild)).toBe(true);

    await expect(pending).rejects.toBeInstanceOf(InfraError);

    expect(await waitForExit(grandchild)).toBe(true);
    expect(pgid).toBeGreaterThan(0);
  });

  it('diagnoses a service that EXITS immediately, with its real output', async () => {
    const dir = await scratch();
    const deadPort = await occupiedPortThenFree();
    const crashing = await serviceScript(dir, [
      "console.error('EADDRINUSE: address already in use');",
      'process.exit(7);',
    ]);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  backend:',
        `    run: ${JSON.stringify(`${NODE} ${crashing}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${deadPort}/health"`,
        '      timeoutSec: 30',
      ].join('\n'),
    );

    const context = stageContext(dir);
    const error = await createServicesStage(deps({ services })).run(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain('exited');
    // It did NOT wait out the 30s deadline — the test itself would time out.
    expect(JSON.stringify(context.run.evidence)).toContain('EADDRINUSE');
  });
});

describe('AC2 — a readiness endpoint that ACCEPTS and never answers still hits the deadline', () => {
  it('bounds each request so `ready.timeoutSec` is actually enforced', async () => {
    // Codex review, P1, and a real defect this story shipped once. A server that
    // completes the TCP handshake and then never writes a response leaves `fetch`
    // pending forever. The readiness deadline is only consulted AFTER a probe
    // resolves, so an unbounded request meant `timeoutSec` was never enforced at
    // all: verification hung instead of producing the required InfraError.
    //
    // The state is PRODUCED, not mocked — a real listener that accepts and then
    // does nothing, which is exactly what a half-started server looks like. If
    // the bound regresses, this test hangs until vitest kills it rather than
    // failing quietly, which is the honest failure mode for a hang.
    const dir = await scratch();
    const script = await serviceScript(dir, STAYS_UP);

    const silent = createSocketServer((socket) => {
      // Accept, hold the socket open, write nothing. Ever.
      sockets.push(socket);
    });
    openServers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the silent server did not report a port');
    }

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  backend:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${address.port}/health"`,
        '      timeoutSec: 2',
      ].join('\n'),
    );

    const registry = realRegistry();
    let pgid = 0;
    const startedAt = Date.now();

    const error = await createServicesStage(
      deps({
        services,
        registry,
        // Well under the 2s readiness deadline, so several requests are abandoned
        // and the DEADLINE is what ends the wait — not a single hung request.
        requestTimeoutMs: 200,
        onProcessGroup: (value) => {
          pgid = trackPid(value);
        },
      }),
    )
      .run(stageContext(dir))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain('backend');
    expect((error as InfraError).message).toContain('did not become ready');

    // It ended at the deadline rather than hanging: comfortably under the 5s
    // production per-request ceiling this would otherwise have waited on.
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    expect(pgid).toBeGreaterThan(0);
    expect(await waitForExit(pgid)).toBe(true);
  });
});

describe('AC1/Q27 — a REAL occupied port is an InfraError naming it, with nothing spawned', () => {
  it('refuses before spawning when a listener already holds the declared port', async () => {
    const dir = await scratch();
    const port = await occupiedPort();
    const script = await serviceScript(dir, STAYS_UP);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  web:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        `    port: ${port}`,
        '    ready:',
        `      url: "http://127.0.0.1:${port}/health"`,
      ].join('\n'),
    );

    const registry = realRegistry();
    const error = await createServicesStage(deps({ services, registry }))
      .run(stageContext(dir))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).message).toContain(String(port));
    expect((error as InfraError).message).toContain('web');
    // Nothing was spawned: the registry never saw a group.
    expect(registry.live.size).toBe(0);
  });
});

/**
 * An ephemeral port that is bound and then RELEASED, so it is almost certainly
 * free and nothing is listening on it.
 *
 * Used where a test needs a readiness URL that will never answer. Binding first
 * is what makes it a port the OS handed out rather than a number picked out of
 * the air, which on a busy machine could belong to somebody else's service — and
 * a readiness probe that accidentally succeeded against a stranger's server
 * would make this suite pass for the wrong reason.
 */
async function occupiedPortThenFree(): Promise<number> {
  const server = createSocketServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture listener did not report a port');
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('AC3 — teardown is total across several services', () => {
  it('reaps every service group, including one started after another', async () => {
    const dir = await scratch();
    const first = await readinessServer();
    const second = await readinessServer();
    const script = await serviceScript(dir, STAYS_UP);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  api:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${first.port}/health"`,
        '      timeoutSec: 10',
        '  worker:',
        `    run: ${JSON.stringify(`${NODE} ${script}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${second.port}/health"`,
        '      timeoutSec: 10',
      ].join('\n'),
    );

    const registry = realRegistry();
    const result = await createServicesStage(deps({ services, registry })).run(stageContext(dir));

    expect(result.status).toBe('ok');
    const pgids = [...registry.live.values()].map(trackPid);
    expect(pgids).toHaveLength(2);

    await registry.releaseAll();

    for (const pgid of pgids) {
      expect(await waitForExit(pgid)).toBe(true);
    }
    expect(registry.live.size).toBe(0);
  });

  it('forks a grandchild that teardown reaps through the group', async () => {
    const dir = await scratch();
    const server = await readinessServer();
    const { script, child, pidFile } = await forkingService(dir);

    const services = declaredServices(
      [
        'version: 1',
        'project:',
        '  baseBranch: master',
        'services:',
        '  api:',
        `    run: ${JSON.stringify(`/bin/sh ${script} ${NODE} ${child} ${pidFile}`)}`,
        '    ready:',
        `      url: "http://127.0.0.1:${server.port}/health"`,
        '      timeoutSec: 10',
      ].join('\n'),
    );

    const registry = realRegistry();
    const result = await createServicesStage(deps({ services, registry })).run(stageContext(dir));
    expect(result.status).toBe('ok');

    const grandchild = trackPid(Number(await waitForFile(pidFile)));
    const pgid = trackPid(registry.live.get('api') as number);

    await registry.releaseAll();

    // The GRANDCHILD, by pid, after teardown returned.
    expect(await waitForExit(grandchild)).toBe(true);
    expect(await waitForExit(pgid)).toBe(true);
  });
});
