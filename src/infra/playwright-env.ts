/**
 * Story 5.1 — which Playwright will be used, at what version, with which
 * browsers, from where; and how to provision one when there is none.
 *
 * This is the environment story 5.2's browser executor drives. It answers ONE
 * question as a typed value and provisions when the answer is "none". It runs
 * no spec, generates no spec, and never sees a plan, a scenario or any provider
 * text — a genuine property of this module rather than an omission.
 *
 * ── THE RESOLUTION ORDER (FR-24, brief §33, Q30) ────────────────────────────
 *
 *   1. THE PROJECT'S OWN INSTALLATION WINS. A team that pins Playwright with
 *      its own config and its own browser channel gets *their* Playwright.
 *   2. SpecWitness's cache, if this product provisioned one earlier.
 *   3. `absent` — A FIRST-CLASS VALUE, not an exception. Resolution is
 *      read-only and always answers.
 *
 * ── WHERE SPECWITNESS'S OWN BYTES LAND, NAMED EXACTLY ───────────────────────
 *
 * This is the only work in five epics that deliberately writes outside the
 * repository, so the location is stated here rather than left to be derived:
 *
 *   PLAYWRIGHT_BROWSERS_PATH set  →  that directory, verbatim (operator wins)
 *   linux / anything else         →  $XDG_CACHE_HOME/specwitness/playwright
 *                                    else ~/.cache/specwitness/playwright
 *   darwin                        →  ~/Library/Caches/specwitness/playwright
 *   win32                         →  %LOCALAPPDATA%\specwitness\playwright
 *                                    else ~/AppData/Local/specwitness/playwright
 *
 * and browser bundles go in `<cacheDir>/browsers` unless the operator's
 * `PLAYWRIGHT_BROWSERS_PATH` says otherwise.
 *
 * IT IS NEVER UNDER THE TARGET PROJECT, never under the verification worktree,
 * and never under `.specwitness/`. The last one is worth stating rather than
 * leaving a reader to wonder: AD-8 makes `RunStore` the sole writer beneath
 * `.specwitness/runs/`, and because this cache is not under `.specwitness/` at
 * all, this module is clear of that rule entirely. A target repository that
 * gained a `node_modules` or a browser bundle because it was verified would
 * have been damaged by its verifier (AC1, FR-24).
 *
 * ── THE STANDING HAZARD, AND THIS MODULE'S SHARE OF IT ──────────────────────
 *
 * Epic 4 retro §2 observation 2: twice now a criterion nobody could adjudicate
 * reported PASS, because `skipped` is inert to `aggregate` and every new way
 * for a criterion to produce no attempts is a new way to reach green-for-
 * nothing. Epic 5 adds exactly such a way and this module owns it:
 * **Playwright is absent or refuses to provision.**
 *
 * THE RULE: an unavailable browser environment is `InfraError` (exit 3) — the
 * run could not proceed — or, where a single criterion is the unit of failure,
 * criterion `error`. It is NEVER `skipped`, NEVER `pass`, and never a silently
 * absent probe. **There is no skip path anywhere in this file.** Epic 4
 * deliberately made the browser seam throw rather than contribute nothing
 * (`src/cli/verify/probe-dispatch.ts`); story 5.2 replaces that refusal with an
 * executor driving this environment, and must not replace it with a skip.
 *
 * ── AD-3, stated because this is the one exception-looking case ─────────────
 *
 * Provisioning spawns `npm` and Playwright's own `cli.js`. These are
 * SpecWitness's OWN, hard-coded, argv-form invocations through `ProcessRunner`
 * — the same footing as `git` in `src/cli/doctor/effects.ts` and `claude` /
 * `codex` in the provider adapters. They are NOT project-declared and NOT
 * provider-authored, so there is no `DeclaredCommand` to mint and none is
 * minted: that brand constrains project-declared SHELL STRINGS, and there is no
 * shell here to constrain. `tests/unit/config/boundary-scan.test.ts` covers this
 * file automatically and was verified red against a planted assertion.
 *
 * AD-1: an adapter. Imports `src/domain/**`, its own siblings and npm only.
 * AD-4 / NFR-1: nothing here reads `~/.claude/`, `~/.codex/` or any credential
 * store. We provision a browser, not a provider.
 * AD-12: `resolvePlaywrightEnvironment` performs no network I/O at all, which is
 * what lets `doctor` call it. **`doctor` reports and hints; it never downloads.**
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { redactText } from '../domain/evidence.js';
import { InfraError } from '../domain/errors.js';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from '../domain/process-runner.js';

import type { ParentEnvironment } from './process-runner.js';

/** The runner package. Standard tooling is reused, never rebuilt (brief §33). */
export const PLAYWRIGHT_PACKAGE = '@playwright/test';

/**
 * The version SpecWitness provisions into its OWN cache.
 *
 * Kept in step with `package.json` by `tests/unit/infra/playwright-pin.test.ts`
 * rather than by memory: a cache pinned to a version this build was never
 * tested against is a silent behaviour change, which is the class of thing the
 * contract-freeze rule exists to forbid. It bounds only SpecWitness's own
 * fallback — a project's own installation is used at whatever version the
 * project pinned, which is the whole point of preferring it.
 */
export const PROVISIONED_PLAYWRIGHT_VERSION = '1.62.1';

/** The one browser SpecWitness provisions. 5.2 drives it; nothing here does. */
export const PROVISIONED_BROWSER = 'chromium';

/**
 * Playwright's own value for "keep browsers inside the package directory".
 * SpecWitness honours it by refusing to guess — see `browsersPresent`.
 */
const BROWSERS_PATH_PACKAGE_LOCAL = '0';

/** Directory-name prefixes Playwright uses for a downloaded chromium bundle. */
const CHROMIUM_PREFIXES = ['chromium-', 'chromium_headless_shell-'] as const;

/** Bound on any subprocess text echoed into an error message. */
const MAX_ECHOED_OUTPUT = 400;

/* ── the answer ────────────────────────────────────────────────────────────── */

export type PlaywrightSource = 'project' | 'specwitness-cache' | 'absent';

interface PlaywrightEnvironmentCommon {
  /** SpecWitness's own cache root — always computed, even when unused. */
  readonly cacheDir: string;
  /** The directory browser bundles are looked for in. */
  readonly browsersPath: string;
  /** True when `PLAYWRIGHT_BROWSERS_PATH` decided `browsersPath`. */
  readonly browsersPathFromEnv: boolean;
  /**
   * Whether the browsers this environment needs are ACTUALLY DOWNLOADED.
   *
   * A resolvable `@playwright/test` with no chromium is a real and common
   * state, and reporting it as "present" would make `doctor` green immediately
   * before a run fails. Fail-closed: when it cannot be told (see
   * `BROWSERS_PATH_PACKAGE_LOCAL`) the answer is `false`, which costs one extra
   * hint and can never make a machine that cannot open a browser look ready.
   */
  readonly browsersPresent: boolean;
  /** `source !== 'absent' && browsersPresent`. The single "can 5.2 run?" bit. */
  readonly ready: boolean;
  /** From the resolved package's `package.json`; `null` when unreadable. */
  readonly version: string | null;
}

export interface PlaywrightResolved extends PlaywrightEnvironmentCommon {
  readonly source: 'project' | 'specwitness-cache';
  /** Absolute, realpath-resolved directory of the resolved package. */
  readonly packageDir: string;
  /** Absolute path to Playwright's own CLI entry point (`cli.js`). */
  readonly cliPath: string;
}

export interface PlaywrightAbsent extends PlaywrightEnvironmentCommon {
  readonly source: 'absent';
  readonly version: null;
  readonly browsersPresent: false;
  readonly ready: false;
  /** Why, in operator-facing words. Names the path when one was found. */
  readonly reason: string;
}

export type PlaywrightEnvironment = PlaywrightResolved | PlaywrightAbsent;

export interface PlaywrightEnvironmentInputs {
  /** The target project. Resolution is project-local BY CONSTRUCTION. */
  readonly projectRoot: string;
  /** Defaults to `process.env`. Injected so a test is not at the mercy of one. */
  readonly env?: ParentEnvironment;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

export interface CachePathInputs {
  readonly env: ParentEnvironment;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
}

export interface PlaywrightCachePaths {
  readonly cacheDir: string;
  readonly browsersPath: string;
  readonly browsersPathFromEnv: boolean;
  /** True when the operator asked for package-local browsers (`...PATH=0`). */
  readonly browsersPackageLocal: boolean;
}

/* ── the cache directory ───────────────────────────────────────────────────── */

/**
 * Where SpecWitness's own Playwright and browsers live. Pure.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` is honoured for the BROWSERS only; the package
 * itself always goes in SpecWitness's cache, because that variable is
 * Playwright's browser-registry override and has nothing to say about where a
 * node package is installed.
 */
export function specwitnessPlaywrightCacheDir(inputs: CachePathInputs): PlaywrightCachePaths {
  const cacheDir = join(userCacheRoot(inputs), 'specwitness', 'playwright');
  const override = inputs.env['PLAYWRIGHT_BROWSERS_PATH'];

  if (override === BROWSERS_PATH_PACKAGE_LOCAL) {
    return {
      cacheDir,
      browsersPath: join(cacheDir, 'browsers'),
      browsersPathFromEnv: true,
      browsersPackageLocal: true,
    };
  }

  if (override !== undefined && override !== '') {
    return {
      cacheDir,
      browsersPath: override,
      browsersPathFromEnv: true,
      browsersPackageLocal: false,
    };
  }

  return {
    cacheDir,
    browsersPath: join(cacheDir, 'browsers'),
    browsersPathFromEnv: false,
    browsersPackageLocal: false,
  };
}

function userCacheRoot(inputs: CachePathInputs): string {
  if (inputs.platform === 'darwin') {
    return join(inputs.homeDir, 'Library', 'Caches');
  }
  if (inputs.platform === 'win32') {
    const localAppData = inputs.env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData !== '') {
      return localAppData;
    }
    return join(inputs.homeDir, 'AppData', 'Local');
  }
  const xdg = inputs.env['XDG_CACHE_HOME'];
  if (xdg !== undefined && xdg !== '') {
    return xdg;
  }
  return join(inputs.homeDir, '.cache');
}

/**
 * Playwright's OWN default browser registry — where a PROJECT's Playwright
 * downloads to when the operator set no override. Mirrored (not guessed) from
 * Playwright's documented default so that "browsers present" is a fact about
 * the installation that would actually be driven, not about ours.
 */
function playwrightDefaultBrowsersPath(inputs: CachePathInputs): string {
  return join(userCacheRoot(inputs), 'ms-playwright');
}

/* ── resolution ────────────────────────────────────────────────────────────── */

/**
 * Resolve which Playwright a run would use. Read-only; no network; no spawn.
 *
 * ⚠️ THE HOISTING HAZARD, and why this does more than ask "does it resolve?".
 *
 * `src/cli/doctor/effects.ts#resolvesFrom` states the rule this must not break:
 * *a `@playwright/test` hoisted into SpecWitness's own dependencies must not
 * make a target project look provisioned.* Story 5.1 adds that dependency to
 * this repository, which is exactly the change that could break it: Node's
 * resolution walks UPWARD through `node_modules`, so a target project nested
 * under a directory that carries SpecWitness's own dependencies resolves the
 * package and would report as provisioned.
 *
 * A boolean cannot tell those apart. This resolver therefore requires the
 * resolved package to live INSIDE the project tree (realpath-compared, so a
 * pnpm store symlink under `<project>/node_modules/.pnpm/` still counts) before
 * it will call it the project's. Anything resolved from above the project root
 * is reported `absent`, with the offending path named.
 *
 * The cost, stated because nobody was here to argue it: a monorepo that hoists
 * `@playwright/test` to the workspace root while `projectRoot` points at one
 * package reports `absent`, and SpecWitness provisions its own copy rather than
 * reusing the hoisted one. That is a wasted download, visible in `doctor`'s
 * output with the exact path that was rejected. The opposite error — an
 * unprovisioned project reported ready — is the one AC1 and the merged check
 * forbid, so the fail-closed direction was chosen deliberately.
 */
export async function resolvePlaywrightEnvironment(
  inputs: PlaywrightEnvironmentInputs,
): Promise<PlaywrightEnvironment> {
  const context = withDefaults(inputs);
  const paths = specwitnessPlaywrightCacheDir(context);

  const fromProject = await resolveContained(context.projectRoot, context.projectRoot);
  if (fromProject.kind === 'found') {
    return await describe('project', fromProject.packageDir, paths, {
      ...context,
      browsersPath: paths.browsersPathFromEnv
        ? paths.browsersPath
        : playwrightDefaultBrowsersPath(context),
    });
  }

  const fromCache = await resolveContained(paths.cacheDir, paths.cacheDir);
  if (fromCache.kind === 'found') {
    return await describe('specwitness-cache', fromCache.packageDir, paths, {
      ...context,
      browsersPath: paths.browsersPath,
    });
  }

  return {
    source: 'absent',
    version: null,
    browsersPresent: false,
    ready: false,
    cacheDir: paths.cacheDir,
    browsersPath: paths.browsersPath,
    browsersPathFromEnv: paths.browsersPathFromEnv,
    reason: absentReason(fromProject, fromCache, context.projectRoot),
  };
}

interface ResolvedInside {
  readonly kind: 'found';
  readonly packageDir: string;
}

interface ResolvedOutside {
  readonly kind: 'outside';
  /** Where it DID resolve — named so an operator can see why it was rejected. */
  readonly packageDir: string;
}

interface NotResolved {
  readonly kind: 'missing';
}

type ContainedResolution = ResolvedInside | ResolvedOutside | NotResolved;

/**
 * Resolve `@playwright/test` from `fromDir` and accept it only if it landed
 * inside `containerDir`. Both sides are realpath-compared: on macOS a temp
 * directory is `/var/folders/...` while `require.resolve` answers
 * `/private/var/folders/...`, and comparing the two verbatim would reject every
 * legitimate installation on the platform every gate in this project runs on.
 */
async function resolveContained(
  fromDir: string,
  containerDir: string,
): Promise<ContainedResolution> {
  const packageJson = resolvePackageJson(fromDir);
  if (packageJson === null) {
    return { kind: 'missing' };
  }

  const packageDir = dirname(packageJson);
  if (await isInside(containerDir, packageDir)) {
    return { kind: 'found', packageDir };
  }
  return { kind: 'outside', packageDir };
}

/**
 * Node's own resolution, from a file inside `fromDir` — which is what makes the
 * lookup project-local by construction rather than by convention.
 *
 * The subpath form is tried first because it lands on the manifest directly.
 * The fallback covers a package whose `exports` map withholds `./package.json`;
 * it walks up from the entry point to the nearest manifest that claims the
 * name, bounded, so a malformed tree terminates rather than climbing to `/`.
 */
function resolvePackageJson(fromDir: string): string | null {
  const require = createRequire(pathToFileURL(join(fromDir, 'specwitness-resolution-anchor.js')));

  try {
    return require.resolve(`${PLAYWRIGHT_PACKAGE}/package.json`);
  } catch {
    // Fall through to the entry-point walk.
  }

  let current: string;
  try {
    current = dirname(require.resolve(PLAYWRIGHT_PACKAGE));
  } catch {
    return null;
  }

  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, 'package.json');
    try {
      const parsed: unknown = JSON.parse(readFileSyncSafe(candidate) ?? '');
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { name?: unknown }).name === PLAYWRIGHT_PACKAGE
      ) {
        return candidate;
      }
    } catch {
      // Not a manifest, or not this package's. Keep climbing.
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

/**
 * Synchronous by necessity: it sits inside `resolvePackageJson`, which mirrors
 * Node's own synchronous resolution and is called from an async caller anyway.
 */
function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function describe(
  source: 'project' | 'specwitness-cache',
  packageDir: string,
  paths: PlaywrightCachePaths,
  context: CachePathInputs & { readonly browsersPath: string },
): Promise<PlaywrightResolved> {
  const version = await readVersion(packageDir);
  const browsersPresent = paths.browsersPackageLocal
    ? false
    : await hasChromium(context.browsersPath);

  return {
    source,
    packageDir,
    cliPath: join(packageDir, 'cli.js'),
    version,
    browsersPath: context.browsersPath,
    browsersPathFromEnv: paths.browsersPathFromEnv,
    browsersPresent,
    ready: browsersPresent,
    cacheDir: paths.cacheDir,
  };
}

async function readVersion(packageDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version !== '') {
        return version;
      }
    }
  } catch {
    // An unreadable manifest is reported as an unknown version, never as a
    // failure: the package still resolves and a run could still drive it.
  }
  return null;
}

/** True when the registry directory holds a downloaded chromium bundle. */
async function hasChromium(browsersPath: string): Promise<boolean> {
  try {
    const entries = await readdir(browsersPath);
    return entries.some((entry) => CHROMIUM_PREFIXES.some((prefix) => entry.startsWith(prefix)));
  } catch {
    return false;
  }
}

function absentReason(
  fromProject: ContainedResolution,
  fromCache: ContainedResolution,
  projectRoot: string,
): string {
  if (fromProject.kind === 'outside') {
    return (
      `${PLAYWRIGHT_PACKAGE} resolves from ${projectRoot} but is installed OUTSIDE the project ` +
      `tree, at ${fromProject.packageDir}; it is not this project's installation and is ignored ` +
      `so that a copy hoisted into SpecWitness's own dependencies cannot make an unprovisioned ` +
      `project look ready`
    );
  }
  if (fromCache.kind === 'outside') {
    return (
      `${PLAYWRIGHT_PACKAGE} does not resolve from ${projectRoot}, and the SpecWitness cache ` +
      `resolved one outside itself at ${fromCache.packageDir}`
    );
  }
  return `${PLAYWRIGHT_PACKAGE} does not resolve from ${projectRoot} and is not in the SpecWitness cache`;
}

/**
 * `child` is `parent` or beneath it, compared on realpaths.
 *
 * A path that does not exist yet cannot be realpath'd; it falls back to
 * `resolve`, which is correct for the "cache not created yet" case and is the
 * conservative answer for every other.
 */
async function isInside(parent: string, child: string): Promise<boolean> {
  const realParent = await realpathOrResolve(parent);
  const realChild = await realpathOrResolve(child);
  const rel = relative(realParent, realChild);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function withDefaults(inputs: PlaywrightEnvironmentInputs): CachePathInputs & {
  readonly projectRoot: string;
} {
  return {
    projectRoot: inputs.projectRoot,
    // Env is read here rather than threaded from the CLI edge for the same
    // reason `src/providers/codex-cli.ts` reads it: the pure resolver takes the
    // environment as a parameter, and only the convenience default touches the
    // real one. Nothing is ever written to it.
    env: inputs.env ?? process.env,
    platform: inputs.platform ?? process.platform,
    homeDir: inputs.homeDir ?? defaultHomeDir(),
  };
}

/**
 * The user's home directory, for the CACHE ROOT and nothing else.
 *
 * NFR-1 / AD-4 / Q59: this is not a credential-store read and must never become
 * one. No path under the home directory is read except the SpecWitness cache
 * this module owns; `~/.claude/`, `~/.codex/`, `credentials.json` and `.netrc`
 * are never touched, here or anywhere beneath it. The doctor module — which
 * `tests/unit/doctor/credential-boundary.test.ts` scans for exactly these
 * routes — reaches this through an injected effect and contains no home-
 * directory access of its own, which keeps that guard's closed list closed.
 */
function defaultHomeDir(): string {
  return homedir();
}

/* ── provisioning ──────────────────────────────────────────────────────────── */

export interface ProvisionOptions extends PlaywrightEnvironmentInputs {
  /** AD-8: every spawn goes through the merged runner. No `execa` here. */
  readonly runner: ProcessRunner;
  /** Per-command budget. Browser downloads are slow; callers pass minutes. */
  readonly timeoutMs: number;
  /**
   * AD-8. Wired into EVERY spawn so `specwitness clean` can reap the group.
   * A leaked browser process tree is strictly worse than a leaked node script
   * (Epic 4 retro §2 observations 3 and 8), and this is the hook that prevents
   * it. Passing `RunStore.recordProcessGroup` here is the intended use.
   */
  readonly onProcessGroup?: (pgid: number) => void | Promise<void>;
  /** Overridable for tests and for a machine whose npm is not on PATH. */
  readonly npmBinary?: string;
  /** Overridable for tests. Defaults to the running Node. */
  readonly nodeBinary?: string;
}

/**
 * Ensure a usable Playwright, provisioning SpecWitness's own when there is none.
 *
 * Returns the environment a browser probe can drive. THROWS `InfraError`
 * (exit 3) on any failure — offline, missing npm, a timeout, or an install that
 * reported success and left nothing resolvable. It never returns an unusable
 * environment, never falls back to "no browser probes ran", and has no skip
 * path: see the module header.
 *
 * THREE ROUTES, in order:
 *   ready already          → return it, spawn nothing.
 *   the project has it     → download only the browsers, into the PROJECT's own
 *                            Playwright registry (a user cache, never the
 *                            project tree) so their pinned version is honoured.
 *   nothing usable         → `npm install` into SpecWitness's cache, then
 *                            download chromium into `<cacheDir>/browsers`.
 */
export async function provisionPlaywright(options: ProvisionOptions): Promise<PlaywrightResolved> {
  const context = withDefaults(options);
  const paths = specwitnessPlaywrightCacheDir(context);

  if (paths.browsersPackageLocal) {
    throw new InfraError(
      `PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH_PACKAGE_LOCAL} asks Playwright to keep browsers ` +
        `inside its own package directory, which SpecWitness's cache layout cannot provision into`,
      'unset PLAYWRIGHT_BROWSERS_PATH, or point it at a directory SpecWitness may write to, ' +
        'then run the command again',
    );
  }

  const existing = await resolvePlaywrightEnvironment(options);
  if (existing.ready) {
    return existing;
  }

  if (existing.source === 'project') {
    await installBrowsers(options, context.projectRoot, existing, existing.browsersPath);
    return await requireReady(options, 'project');
  }

  await installPackageIntoCache(options, paths);

  const installed = await resolvePlaywrightEnvironment(options);
  if (installed.source !== 'specwitness-cache') {
    throw new InfraError(
      `${PLAYWRIGHT_PACKAGE} did not resolve from ${paths.cacheDir} after installing it there`,
      'remove the SpecWitness Playwright cache and run the command again; if it recurs, the ' +
        'install is being written somewhere else — check npm config prefix',
    );
  }

  await installBrowsers(options, paths.cacheDir, installed, paths.browsersPath);
  return await requireReady(options, 'specwitness-cache');
}

/**
 * `npm install @playwright/test@<pinned>` into the cache.
 *
 * A private manifest is written first so npm treats the cache as its own
 * project and does not walk upward into whatever happens to be above it.
 */
async function installPackageIntoCache(
  options: ProvisionOptions,
  paths: PlaywrightCachePaths,
): Promise<void> {
  await mkdir(paths.cacheDir, { recursive: true });
  await writeFile(
    join(paths.cacheDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'specwitness-playwright-cache',
        version: '0.0.0',
        private: true,
        description:
          'SpecWitness-owned Playwright cache. Created by `specwitness`; safe to delete.',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = await spawn(options, {
    binary: options.npmBinary ?? 'npm',
    args: [
      'install',
      `${PLAYWRIGHT_PACKAGE}@${PROVISIONED_PLAYWRIGHT_VERSION}`,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    cwd: paths.cacheDir,
    timeoutMs: options.timeoutMs,
    env: { inherit: true },
  });

  classify(result, `installing ${PLAYWRIGHT_PACKAGE} into ${paths.cacheDir}`, options.npmBinary ?? 'npm');
}

/** `playwright install chromium`, into `browsersPath`. */
async function installBrowsers(
  options: ProvisionOptions,
  cwd: string,
  resolved: PlaywrightResolved,
  browsersPath: string,
): Promise<void> {
  const nodeBinary = options.nodeBinary ?? process.execPath;

  const result = await spawn(options, {
    binary: nodeBinary,
    args: [resolved.cliPath, 'install', PROVISIONED_BROWSER],
    // The project's own root, or SpecWitness's cache — never a directory
    // inside `node_modules`, so a reader of a process listing can tell at a
    // glance whose installation is being provisioned.
    cwd,
    timeoutMs: options.timeoutMs,
    // Set explicitly rather than inherited so the bundle lands where this
    // module said it would, and so a stale variable in the parent cannot
    // silently redirect hundreds of megabytes somewhere nobody looks.
    env: { inherit: true, set: { PLAYWRIGHT_BROWSERS_PATH: browsersPath } },
  });

  classify(result, `downloading ${PROVISIONED_BROWSER} into ${browsersPath}`, nodeBinary);
}

async function spawn(
  options: ProvisionOptions,
  run: Omit<ProcessRunOptions, 'onProcessGroup'>,
): Promise<ProcessResult> {
  return await options.runner.run({
    ...run,
    ...(options.onProcessGroup === undefined ? {} : { onProcessGroup: options.onProcessGroup }),
  });
}

/**
 * Turn a subprocess outcome into either "carry on" or an `InfraError`.
 *
 * Every arm is exit 3. There is no arm that returns "we could not, so nothing
 * ran" — see the module header.
 */
function classify(result: ProcessResult, what: string, binary: string): void {
  if (result.outcome === 'not-found') {
    throw new InfraError(
      `${binary} is not on PATH, so SpecWitness cannot provision Playwright (${what})`,
      `install ${binary} and run the command again, or install ${PLAYWRIGHT_PACKAGE} in the ` +
        'project so its own installation is used',
    );
  }

  if (result.outcome === 'timed-out') {
    throw new InfraError(
      `${what} timed out`,
      'a first browser download can take several minutes on a slow connection — raise the ' +
        'timeout, or provision Playwright yourself and run the command again',
    );
  }

  if (result.outcome === 'spawn-failed' || result.exitCode !== 0) {
    throw new InfraError(
      `${what} failed (exit ${String(result.exitCode)}): ${echo(result.stderr || result.stdout)}`,
      'this needs a working network connection and access to the npm registry and to ' +
        'Playwright’s browser CDN — check connectivity, proxy and registry settings, or install ' +
        `${PLAYWRIGHT_PACKAGE} and its browsers yourself and run the command again`,
    );
  }
}

/**
 * Subprocess output is UNTRUSTED text from outside SpecWitness, so it is
 * redacted fail-closed and bounded before it can reach a terminal, a log or a
 * PR body. `redactText`'s default is over-redaction, which is the safe
 * direction for a message nobody reads until something is already wrong.
 */
function echo(raw: string): string {
  const redacted = redactText(raw.trim());
  const collapsed = redacted.replace(/\s+/g, ' ');
  return collapsed.length > MAX_ECHOED_OUTPUT
    ? `${collapsed.slice(0, MAX_ECHOED_OUTPUT)}…`
    : collapsed;
}

/**
 * Re-resolve and insist the result is usable.
 *
 * A provisioning step that "succeeded" and left no browser is exactly the
 * green-for-nothing shape this story exists to keep out of Epic 5, so it is an
 * error rather than a shrug.
 */
async function requireReady(
  options: ProvisionOptions,
  expected: 'project' | 'specwitness-cache',
): Promise<PlaywrightResolved> {
  const env = await resolvePlaywrightEnvironment(options);

  if (env.source === 'absent') {
    throw new InfraError(
      `${PLAYWRIGHT_PACKAGE} did not resolve after provisioning: ${env.reason}`,
      'remove the SpecWitness Playwright cache and run the command again',
    );
  }

  if (!env.browsersPresent) {
    throw new InfraError(
      `${PROVISIONED_BROWSER} is still not present in ${env.browsersPath} after provisioning ` +
        `the ${expected} installation`,
      `run \`npx playwright install ${PROVISIONED_BROWSER}\` yourself to see the download's own ` +
        'diagnosis, then run the command again',
    );
  }

  return env;
}
