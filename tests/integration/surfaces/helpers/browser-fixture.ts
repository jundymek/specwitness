/**
 * Shared fixtures for the browser surface's integration suites (story 5.2).
 *
 * ⚠️ TWO RULES THIS FILE EXISTS TO KEEP, both from Epic 4's retrospective.
 *
 * **Every fixture is SELF-LIMITING.** When a test run is killed outright, no `afterEach`
 * executes at all (retro §2 observation 8) — so a server that only closes in a hook is a
 * server that survives the run. Every server here also arms an `unref`'d timer that closes
 * it, and every spawn this suite makes is bounded by `ProcessRunner`'s own timeout, which
 * tears the process GROUP down. A leaked browser tree is the worst leak this product can
 * produce, and it lives until reboot.
 *
 * **Every port is EPHEMERAL (`listen(0)`).** The auto-review runs `pnpm test` in the same
 * worktree CONCURRENTLY with the agent (H-8), and a Playwright suite is the most expensive
 * thing that path has ever carried. A hardcoded port makes two concurrent runs fight.
 *
 * ⚠️ **A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS.** `describeWithBrowser`
 * below skips loudly, with a counted reason, when no browser is available — that is a
 * property of the machine running the suite. The PRODUCTION code has NO skip path: every
 * route by which a browser probe could produce no attempts is an `InfraError` or an
 * `execError`. Conflating the two is Epic 4 retro §2 observation 2 arriving a third time.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe } from 'vitest';

import type { Evidence } from '../../../../src/domain/evidence.js';
import type { ProcessRunOptions, ProcessRunner } from '../../../../src/domain/process-runner.js';
import { SystemClock } from '../../../../src/infra/clock.js';
import {
  resolvePlaywrightEnvironment,
  type PlaywrightEnvironment,
} from '../../../../src/infra/playwright-env.js';
import { createProcessRunner } from '../../../../src/infra/process-runner.js';

/** Nothing here waits longer than this; the outer bound on any spawn the suite makes. */
export const SUITE_SPAWN_TIMEOUT_MS = 120_000;

/** How long a fixture server may live even if no hook ever runs. */
const FIXTURE_MAX_LIFETIME_MS = 300_000;

export const clock = new SystemClock();

let cachedEnvironment: PlaywrightEnvironment | undefined;

/** 5.1's answer for THIS repository, resolved once per worker. */
export async function playwrightEnvironment(): Promise<PlaywrightEnvironment> {
  cachedEnvironment ??= await resolvePlaywrightEnvironment({ projectRoot: process.cwd() });
  return cachedEnvironment;
}

/**
 * `describe`, unless this machine has no usable browser — in which case the block is
 * SKIPPED LOUDLY, naming 5.1's own reason so the skip is a diagnosis rather than a silence.
 *
 * Never downloads. The browser download is a one-time cached step outside the suite's hot
 * path (`specwitness doctor` provisions; this suite only consumes), because H-8 puts this
 * suite in the auto-review's way.
 */
export function describeWithBrowser(title: string, body: () => void): void {
  const ready = process.env['SPECWITNESS_BROWSER_SUITE_READY'];
  if (ready === 'no') {
    describe.skip(`${title} [SKIPPED: no usable Playwright environment on this machine]`, body);
    return;
  }
  describe(title, body);
}

/**
 * Decides once, before any suite is collected, whether a browser is available — and says so
 * on stderr when it is not, because a silent skip is how a suite stops proving anything
 * without anybody noticing.
 */
export async function announceBrowserAvailability(): Promise<boolean> {
  const environment = await playwrightEnvironment();
  if (!environment.ready) {
    process.env['SPECWITNESS_BROWSER_SUITE_READY'] = 'no';
    process.stderr.write(
      `\n[specwitness] SKIPPING the browser surface integration suite: ${
        environment.source === 'absent' ? environment.reason : 'no browsers are downloaded'
      }\n` +
        '[specwitness] this is a skipped TEST, not a skipped CRITERION - the executor has no ' +
        'skip path. Run `specwitness doctor` to provision Playwright.\n',
    );
    return false;
  }
  process.env['SPECWITNESS_BROWSER_SUITE_READY'] = 'yes';
  return true;
}

/* ── the fixture app ────────────────────────────────────────────────────────────────── */

export interface FixtureApp {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export type FixtureHandler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * A local HTTP server on an EPHEMERAL port, bound to loopback only (AD-12: hermetic,
 * localhost only, never the network beyond it).
 */
export async function startFixtureApp(handler: FixtureHandler): Promise<FixtureApp> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the browser fixture server did not bind');
  }

  // SELF-LIMITING: closes itself even if no hook ever runs. `unref` so it never keeps the
  // process alive on its own.
  const guard = setTimeout(() => server.close(), FIXTURE_MAX_LIFETIME_MS);
  guard.unref();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      clearTimeout(guard);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The default page: everything the four merged assertion targets can read. */
export function ordersPage(body: string): string {
  return `<!doctype html><html><head><title>Orders</title></head><body>${body}</body></html>`;
}

/* ── the evidence sink ──────────────────────────────────────────────────────────────── */

export interface EvidenceSink {
  /** Absolute path of the pretend run directory. */
  readonly runDir: string;
  readonly members: Evidence[];
  readonly writeEvidence: (relativeName: string, contents: string) => Promise<string>;
  readonly writeEvidenceBytes: (relativeName: string, contents: Uint8Array) => Promise<string>;
  readonly resolveRunPath: (relativeName: string) => string;
  readonly recordEvidence: (evidence: Evidence) => void;
  /** Every file written beneath `runDir`, absolute, recursively. */
  files(): Promise<string[]>;
  cleanup(): Promise<void>;
}

/**
 * A stand-in for `RunStore`'s two evidence writers, bound to a temporary directory.
 *
 * It returns RELATIVE paths, exactly as `RunStore.writeEvidenceFile` does, because that
 * return value goes straight into an `EvidenceRef` (Q48) and the whole point of the ref
 * being relative is that a run directory survives being copied between machines.
 */
export async function createEvidenceSink(): Promise<EvidenceSink> {
  const runDir = await mkdtemp(join(tmpdir(), 'specwitness-browser-run-'));
  const members: Evidence[] = [];

  const write = async (relativeName: string, contents: string | Uint8Array): Promise<string> => {
    const absolute = join(runDir, relativeName);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    return relativeName;
  };

  const files = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        out.push(path);
      }
    };
    await walk(runDir);
    return out;
  };

  return {
    runDir,
    members,
    writeEvidence: async (name, contents) => await write(name, contents),
    writeEvidenceBytes: async (name, contents) => await write(name, contents),
    resolveRunPath: (name) => join(runDir, name),
    recordEvidence: (evidence) => {
      members.push(evidence);
    },
    files,
    cleanup: async () => {
      await rm(runDir, { recursive: true, force: true });
    },
  };
}

/* ── a runner that records what it was asked to spawn ───────────────────────────────── */

export interface RecordingRunner extends ProcessRunner {
  readonly spawns: ProcessRunOptions[];
}

/**
 * The REAL process runner, with every invocation recorded.
 *
 * Recorded rather than mocked: the AD-3 proof is about what actually reached `spawn`, and a
 * mock would assert over a value the test itself invented. `ProcessRunner` takes
 * `(binary, args[])` and has no `shell` option, so this is where a test can see, rather
 * than assume, that no scenario text ever became a command.
 */
export function createRecordingRunner(): RecordingRunner {
  const real = createProcessRunner(clock);
  const spawns: ProcessRunOptions[] = [];

  return {
    spawns,
    run: async (options) => {
      spawns.push(options);
      return await real.run(options);
    },
  };
}

/** Reads a file written into the sink, as text. */
export async function readSinkFile(sink: EvidenceSink, relativeName: string): Promise<string> {
  return await readFile(join(sink.runDir, relativeName), 'utf8');
}
