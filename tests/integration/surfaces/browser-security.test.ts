/**
 * AC1's security property, proved rather than asserted — story 5.2.
 *
 * `BrowserProbeMechanics.scenario` is untrusted provider text that becomes executable code.
 * No other executor in this product does that. This file plants hostile scenarios and shows
 * that each one is either REFUSED before any I/O or NEUTRALISED into inert JSON data, and
 * that nothing a provider wrote ever reaches a shell, a command line, or the generated code.
 *
 * **THE DESIGN THIS PROVES.** The generated spec and config are byte-for-byte CONSTANTS of
 * SpecWitness. The scenario is compiled into a separate JSON payload the constant driver
 * READS. So there is no template into which a backtick, a `${`, a quote or a `;` could be
 * placed — the injection surface does not exist rather than being argued closed.
 *
 * **EVERY GUARD HERE WAS VERIFIED RED** against a deliberately weakened implementation; the
 * story's Dev Agent Record records what was planted and which test caught which weakening.
 * A guard is only a guard once you have seen it fail (Epic 4 retro §2 observation 7).
 *
 * ⚠️ A SKIPPED TEST AND A SKIPPED CRITERION ARE DIFFERENT THINGS. The production code has
 * no skip path.
 */

import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { InfraError } from '../../../src/domain/errors.js';
import { BrowserSurfaceExecutor } from '../../../src/surfaces/browser.js';
import {
  announceBrowserAvailability,
  clock,
  createEvidenceSink,
  createRecordingRunner,
  describeWithBrowser,
  ordersPage,
  playwrightEnvironment,
  readSinkFile,
  startFixtureApp,
  SUITE_SPAWN_TIMEOUT_MS,
  type EvidenceSink,
  type FixtureApp,
} from './helpers/browser-fixture.js';

const TEST_TIMEOUT_MS = 120_000;

/** A file no honest run of this suite could ever create. Its ABSENCE is the assertion. */
const SENTINEL = join(tmpdir(), `specwitness-browser-injection-${process.pid}.sentinel`);

let app: FixtureApp;
const sinks: EvidenceSink[] = [];

beforeAll(async () => {
  await announceBrowserAvailability();
  await rm(SENTINEL, { force: true });
  app = await startFixtureApp((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(ordersPage('<h1 id="heading">Orders</h1><button id="go">Go</button>'));
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await rm(SENTINEL, { force: true });
});

afterEach(async () => {
  await Promise.all(sinks.splice(0).map(async (sink) => await sink.cleanup()));
});

async function run(scenario: string) {
  const environment = await playwrightEnvironment();
  if (!environment.ready) {
    throw new Error('the suite should have skipped: no usable Playwright');
  }

  const sink = await createEvidenceSink();
  sinks.push(sink);
  const runner = createRecordingRunner();

  const attempt = await new BrowserSurfaceExecutor({
    clock,
    runner,
    cwd: process.cwd(),
    environment,
    writeEvidence: sink.writeEvidence,
    writeEvidenceBytes: sink.writeEvidenceBytes,
    resolveRunPath: sink.resolveRunPath,
    recordEvidence: sink.recordEvidence,
    stepTimeoutMs: 1_500,
    timeoutMs: SUITE_SPAWN_TIMEOUT_MS,
  }).execute({
    criterionId: 'E5-02',
    surface: 'browser',
    params: {
      probe: {
        id: 'orders',
        surface: 'browser',
        mechanics: { serviceId: 'web', path: '/orders', scenario },
        assertions: [
          {
            description: 'the heading reads Orders',
            target: { source: 'text', selector: '#heading' },
            comparison: 'equals',
            expected: 'Orders',
          },
        ],
      },
      baseUrl: app.baseUrl,
    },
  });

  return { attempt, sink, spawns: runner.spawns };
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

describeWithBrowser('a hostile scenario cannot escape into a shell or into code', () => {
  it(
    'shell metacharacters in a selector become inert JSON DATA and reach no shell',
    async () => {
      // ⚠️ WHAT IS PLANTED: a selector carrying `;`, a command substitution `$(...)`, a
      // backtick pair, and a `touch` of a sentinel path. If ANY of it were word-split,
      // interpolated into a command string, or evaluated by a shell, the sentinel appears.
      // `ProcessRunner` takes `(binary, args[])` and has no `shell` option, so this asserts
      // a structural property rather than careful escaping.
      const hostile = `#go; touch ${SENTINEL}; echo $(whoami) \`id\``;
      const { attempt, sink, spawns } = await run(`click "${hostile}"`);

      // 1. Nothing ran. The sentinel is the assertion, and its ABSENCE is what passes.
      expect(await exists(SENTINEL), 'a shell executed planted scenario text').toBe(false);

      // 2. Not one byte of the scenario reached the spawn's binary or argv.
      expect(spawns).toHaveLength(1);
      const spawn = spawns[0];
      expect(spawn?.binary).toBe(process.execPath);
      const argv = [spawn?.binary ?? '', ...(spawn?.args ?? [])].join(' ');
      expect(argv).not.toContain('touch');
      expect(argv).not.toContain('whoami');
      expect(argv).not.toContain(SENTINEL);
      expect(argv).not.toContain('#go');
      // The argv is a FIXED FOUR-TOKEN SHAPE and nothing widens it: Playwright's own CLI,
      // the `test` subcommand, `--config`, and a path SpecWitness generated. There is no
      // token position a plan can reach, which is the property rather than the escaping.
      expect(spawn?.args).toHaveLength(4);
      expect(spawn?.args[1]).toBe('test');
      expect(spawn?.args[2]).toBe('--config');
      expect(spawn?.args[3]).toBe(sink.resolveRunPath(
        attempt.evidence.find((ref) => ref.path.endsWith('.config.cjs'))?.path ?? '',
      ));

      // 3. It survives only as a JSON string in the payload — data the driver reads, never
      //    code the driver becomes.
      const payloadRef = attempt.evidence.find((ref) => ref.path.endsWith('.payload.json'));
      const payload = JSON.parse(await readSinkFile(sink, payloadRef?.path ?? '')) as {
        steps: { verb: string; selector: string }[];
      };
      expect(payload.steps[0]).toEqual({ verb: 'click', selector: hostile });

      // 4. And the probe ends as an honest `execError`: no element matches that selector, so
      //    the STEP could not be performed. Not a pass, not a silent skip.
      expect(attempt.execError).toBeDefined();
      expect(attempt.assertionEvaluations).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the generated spec and config are CONSTANTS — a hostile scenario changes neither byte',
    async () => {
      // The load-bearing structural claim. Two runs, one benign and one hostile, must
      // produce IDENTICAL code files. If a future edit starts templating anything into
      // them, this test fails at that moment rather than when somebody exploits it.
      const benign = await run('click "#go"');
      // Everything a template could be broken with, assembled from plain pieces so
      // this file's own source stays readable: a backtick, a template-literal
      // placeholder, a closing script tag, a double quote and a comment terminator.
      const BACKTICK = String.fromCharCode(96);
      const hostileSelector =
        '#go' + BACKTICK + '$' + '{process.exit(1)}</script>' + '"' + '*/';
      const hostile = await run("click '" + hostileSelector + "'");

      for (const suffix of ['.spec.cjs', '.config.cjs']) {
        const of = async (result: typeof benign): Promise<string> => {
          const ref = result.attempt.evidence.find((r) => r.path.endsWith(suffix));
          expect(ref, `no ${suffix} was generated`).toBeDefined();
          return await readSinkFile(result.sink, ref?.path ?? '');
        };

        const benignText = await of(benign);
        const hostileText = await of(hostile);

        expect(hostileText).toBe(benignText);
        // And the constant really is a constant: no scenario text in it at all.
        expect(hostileText).not.toContain('#go');
        expect(hostileText).not.toContain('process.exit');
        expect(hostileText).not.toContain(hostileSelector);
        expect(hostileText).toContain('GENERATED BY SPECWITNESS');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the generated files live in the RUN DIRECTORY and nowhere else (Q30/Q31)',
    async () => {
      const { attempt, sink } = await run('click "#go"');

      // Ephemeral, never in the project tree, never in the verification worktree's sources.
      // Every ref is run-RELATIVE, so an absolute path is not even constructible (Q48).
      const generated = attempt.evidence.filter((ref) =>
        ['.spec.cjs', '.config.cjs', '.payload.json'].some((s) => ref.path.endsWith(s)),
      );
      expect(generated).toHaveLength(3);
      for (const ref of generated) {
        expect(ref.path.startsWith('/')).toBe(false);
        expect(ref.path.includes('..')).toBe(false);
        expect(ref.path.startsWith('evidence/')).toBe(true);
      }

      // Nothing was written into this repository. The only place SpecWitness wrote is the
      // run directory it was handed and a temp directory it removed.
      const files = await sink.files();
      expect(files.every((path) => path.startsWith(sink.runDir))).toBe(true);
      expect(await exists(join(process.cwd(), 'evidence'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('refusals that need no browser at all', () => {
  // These are here rather than in the unit suite because they belong to the SECURITY
  // argument and a reviewer should find the whole argument in one file.
  async function refuse(scenario: string, path = '/orders'): Promise<InfraError> {
    const executor = new BrowserSurfaceExecutor({
      clock,
      runner: {
        run: async () => {
          throw new Error('a refused probe reached the spawn');
        },
      },
      cwd: process.cwd(),
      environment: {
        ready: true,
        packageDir: '/opt/pw',
        cliPath: '/opt/pw/cli.js',
        browsersPath: '/opt/browsers',
      },
      writeEvidence: async () => {
        throw new Error('a refused probe wrote evidence');
      },
      writeEvidenceBytes: async () => {
        throw new Error('a refused probe wrote evidence');
      },
      resolveRunPath: (p) => p,
      recordEvidence: () => undefined,
    });

    const error = await executor
      .execute({
        criterionId: 'E5-02',
        surface: 'browser',
        params: {
          probe: {
            id: 'orders',
            surface: 'browser',
            mechanics: { serviceId: 'web', path, scenario },
            assertions: [
              {
                description: 'heading',
                target: { source: 'text', selector: 'h1' },
                comparison: 'equals',
                expected: 'Orders',
              },
            ],
          },
          baseUrl: 'http://127.0.0.1:4000',
        },
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error, 'a hostile input was accepted').toBeInstanceOf(InfraError);
    return error as InfraError;
  }

  it('refuses an off-host absolute URL in a goto — BEFORE writing or spawning anything', async () => {
    // AD-3's "no production URL defaults", at the only place a plan could still try to name
    // a host: `BrowserProbeMechanics` has no url field, so the scenario is the last door.
    const error = await refuse('goto "https://evil.example.com/exfiltrate"');

    expect(error.message).toContain('not service-relative');
  });

  it('refuses a data: URL in a goto — a scheme is a scheme', async () => {
    const error = await refuse('goto "data:text/html,<script>fetch(1)</script>"');

    expect(error.message).toContain('not service-relative');
  });

  it('refuses free prose rather than ignoring it and asserting anyway', async () => {
    // The green-for-nothing route. Executing a browser probe WITHOUT the interaction it
    // describes would report a criterion as verified having checked nothing.
    const error = await refuse('Log in as an administrator and delete the first order.');

    expect(error.message).toContain('not a directive this executor can perform');
  });
});
