import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDoctorContext, type DoctorContext } from '../../../src/cli/doctor/context.js';
import type {
  DoctorEffects,
  PortProbe,
  ProviderProbe,
  RunOutcome,
} from '../../../src/cli/doctor/effects.js';

/**
 * Test doubles for doctor's unit tests.
 *
 * Configs are built by writing real YAML and loading it through the real
 * `loadConfig`, never by casting an object literal: a `DeclaredCommand` may only
 * be minted inside `src/config` (AD-3), and a test that forged one would be
 * asserting against a shape the product can never actually produce.
 */

const GIT_OK: RunOutcome = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  notFound: false,
};

export function gitOk(stdout = ''): RunOutcome {
  return { ...GIT_OK, stdout };
}

export function gitFails(exitCode = 1, stderr = ''): RunOutcome {
  return { ...GIT_OK, exitCode, stderr };
}

export const GIT_MISSING: RunOutcome = {
  exitCode: null,
  stdout: '',
  stderr: 'spawn git ENOENT',
  timedOut: false,
  notFound: true,
};

export const GIT_TIMED_OUT: RunOutcome = {
  exitCode: null,
  stdout: '',
  stderr: '',
  timedOut: true,
  notFound: false,
};

export interface FakeEffectOptions {
  /** Answers keyed by the joined git arguments; unmatched calls use `gitDefault`. */
  readonly git?: Readonly<Record<string, RunOutcome>>;
  readonly gitDefault?: RunOutcome;
  readonly executableFiles?: readonly string[];
  readonly existingPaths?: readonly string[];
  readonly resolvableModules?: readonly string[];
  readonly occupiedPorts?: Readonly<Record<number, string>>;
  /**
   * Provider probe results keyed by the config's provider name (story 2.7).
   *
   * Injected rather than spawned: doctor's unit tests start no `claude` and no
   * `codex`, and a check that needed a real binary to be testable would only be
   * exercised on machines that happen to have one.
   */
  readonly providerProbes?: Readonly<Record<string, ProviderProbe>>;
}

/** A provider that is simply not installed — the UJ-4 edge case. */
export const PROVIDER_ABSENT: ProviderProbe = {
  hermetic: false,
  binary: 'codex',
  found: false,
  capable: false,
  capabilityDetail: '',
  reason: 'codex not found on PATH — contract generation unavailable; existing plans still run',
  auth: null,
};

export function fakeEffects(options: FakeEffectOptions = {}): DoctorEffects {
  return {
    async runGit(args) {
      return options.git?.[args.join(' ')] ?? options.gitDefault ?? gitFails();
    },
    async isExecutableFile(path) {
      return (options.executableFiles ?? []).includes(path);
    },
    async pathExists(path) {
      return (
        (options.existingPaths ?? []).includes(path) ||
        (options.executableFiles ?? []).includes(path)
      );
    },
    resolvesFrom(specifier) {
      return (options.resolvableModules ?? []).includes(specifier);
    },
    async probePort(port): Promise<PortProbe> {
      const reason = options.occupiedPorts?.[port];
      return reason === undefined ? { free: true } : { free: false, reason };
    },
    async probeProvider(descriptor) {
      const probe = options.providerProbes?.[descriptor.name];
      if (probe === undefined) {
        throw new Error(
          `test fixture has no provider probe for "${descriptor.name}" — add one to providerProbes`,
        );
      }
      return probe;
    },
  };
}

/** Creates a project directory; omitting `config` writes no config file at all. */
export async function makeProject(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'specwitness-doctor-'));
  if (config !== undefined) {
    await mkdir(join(root, '.specwitness'), { recursive: true });
    await writeFile(join(root, '.specwitness', 'config.yaml'), config, 'utf8');
  }
  return root;
}

export interface TestContextOptions extends FakeEffectOptions {
  readonly config?: string;
  readonly nodeVersion?: string;
  readonly pathVar?: string;
  /**
   * Billing-risk variable NAMES (story 2.7). Injected rather than set on
   * `process.env`, because mutating the parent environment is what AD-4 forbids
   * the product from doing and would leak across test files besides.
   */
  readonly billingRiskEnv?: readonly string[];
}

export async function testContext(
  options: TestContextOptions = {},
): Promise<{ ctx: DoctorContext; projectRoot: string }> {
  const projectRoot = await makeProject(options.config);
  const ctx = createDoctorContext({
    projectRoot,
    effects: fakeEffects(options),
    nodeVersion: options.nodeVersion ?? 'v22.20.0',
    pathVar: options.pathVar ?? '',
    // Default empty, never the real environment: a developer with a key
    // exported must not get different test results from one without.
    billingRiskEnv: options.billingRiskEnv ?? [],
  });
  return { ctx, projectRoot };
}

/** The smallest config the schema accepts: `version` plus `project.baseBranch`. */
export const MINIMAL_CONFIG = ['version: 1', 'project:', '  baseBranch: master', ''].join('\n');
