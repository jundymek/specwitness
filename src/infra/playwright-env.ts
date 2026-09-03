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
 *   linux / anything else         →  $XDG_CACHE_HOME/specwitness/playwright
 *                                    else ~/.cache/specwitness/playwright
 *   darwin                        →  ~/Library/Caches/specwitness/playwright
 *   win32                         →  %LOCALAPPDATA%\specwitness\playwright
 *                                    else ~/AppData/Local/specwitness/playwright
 *
 * Browser bundles go in `<cacheDir>/browsers`, unless the operator set
 * `PLAYWRIGHT_BROWSERS_PATH` — which wins, is made absolute at this process's
 * cwd so no child can read it differently, and is honoured for the BROWSERS
 * only: the package itself always lands in the cache above, because that
 * variable is Playwright's browser-registry override and says nothing about
 * where a node package installs. `=0` is its own case, below.
 *
 * IT IS NEVER UNDER THE TARGET PROJECT, never under the verification worktree,
 * and never under `.specwitness/` — and that holds for OPERATOR-CHOSEN paths
 * too. `PLAYWRIGHT_BROWSERS_PATH` and `XDG_CACHE_HOME` are input, not
 * authority: a value under the project root is refused with exit 3 before
 * anything is written, because AC1's guarantee is about the project's bytes
 * rather than about SpecWitness's preferences. The last one is worth stating rather than
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
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
 *
 * HONOURED, and the scope of that is exact. A complete package-local
 * installation is resolved, reported ready and used, wherever it lives. Writing
 * one is allowed only into SpecWitness's OWN cache: for a project's own
 * Playwright the same setting would put a browser bundle inside the project's
 * `node_modules`, and AC1 forbids that outright. So the project route refuses
 * (exit 3, with a hint) and the owned-cache route passes `0` straight through.
 */
const BROWSERS_PATH_PACKAGE_LOCAL = '0';

/**
 * The `browsers.json` entries that make up the chromium family — CANDIDATES,
 * not a requirement list.
 *
 * WHICH OF THESE ARE ACTUALLY REQUIRED IS READ FROM THE PROJECT'S OWN MANIFEST,
 * and that distinction is the whole point. Current Playwright launches headless
 * through a SEPARATE `chromium_headless_shell-<revision>` bundle, so a modern
 * registry holding only `chromium-<revision>` cannot serve the default headless
 * launch every browser probe makes — but releases before that bundle existed
 * declare `chromium` alone, and demanding a headless shell of them would report
 * a correctly provisioned older project as permanently unusable. Both halves
 * were codex findings on this branch, in that order.
 *
 * A project's pinned version winning is the story's second load-bearing
 * property (FR-24), and it is only really honoured if readiness is judged
 * against THAT version's manifest rather than against the one SpecWitness
 * happens to ship.
 *
 * `ffmpeg` is deliberately absent: it records video, and its absence cannot
 * stop a page from opening.
 */
const CHROMIUM_FAMILY = ['chromium', 'chromium-headless-shell'] as const;

/** The manifest entry without which there is nothing to check against. */
const CHROMIUM_BROWSER_NAME = 'chromium';

/**
 * The marker Playwright writes into a bundle directory when — and only when —
 * the download finished. Reading Playwright's own signal is what makes
 * "browsers present" a fact rather than an inference from a directory name.
 */
const INSTALLATION_COMPLETE = 'INSTALLATION_COMPLETE';

/** Where Playwright keeps browsers when `PLAYWRIGHT_BROWSERS_PATH=0`. */
const PACKAGE_LOCAL_BROWSERS_DIR = '.local-browsers';

/**
 * Last resort for the CLI entry point, used only when the package's own `bin`
 * cannot be read.
 *
 * A LAST RESORT AND NOT A DEFAULT: the path comes from the manifest's `bin`
 * field, because "what is this Playwright's CLI called?" is a question
 * Playwright's own metadata answers and this module has now been wrong three
 * times for guessing such answers instead of reading them. Kept only so that a
 * package with an unreadable manifest produces a classified spawn failure
 * naming a plausible path, rather than no attempt at all.
 */
const FALLBACK_CLI_ENTRY = 'cli.js';

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
      // ABSOLUTISED, never stored verbatim. A relative override would be read
      // against THIS process's cwd here and against the child's cwd - the
      // project root, or the cache - inside `playwright install`, so a download
      // could succeed into one directory while readiness was checked in
      // another. Resolving once, against the parent's cwd (which is where the
      // operator typed the variable), makes parent and child agree; the
      // absolute value is then passed explicitly to every child rather than
      // inherited, so there is no second interpretation of it anywhere.
      // Reported by the codex review of this branch.
      browsersPath: resolve(override),
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
    return await describe('project', fromProject, paths, {
      ...context,
      browsersPath: paths.browsersPathFromEnv
        ? paths.browsersPath
        : playwrightDefaultBrowsersPath(context),
    });
  }

  const fromCache = await resolveContained(paths.cacheDir, paths.cacheDir);
  if (fromCache.kind === 'found') {
    return await describe('specwitness-cache', fromCache, paths, {
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
  /**
   * The realpath'd container the package was accepted from — the project root
   * or SpecWitness's cache.
   *
   * Carried forward because every SUBSEQUENT lookup has to stay inside the same
   * installation. See `findPackageNear`.
   */
  readonly containerDir: string;
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
  const containerReal = await realpathOrResolve(containerDir);
  if (isWithin(containerReal, packageDir)) {
    return { kind: 'found', packageDir, containerDir: containerReal };
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
  resolved: ResolvedInside,
  paths: PlaywrightCachePaths,
  context: CachePathInputs & { readonly browsersPath: string },
): Promise<PlaywrightResolved> {
  const { packageDir } = resolved;
  const manifest = await readManifest(packageDir);
  const coreDir = findPackageNear(packageDir, 'playwright-core', resolved.containerDir);

  // `PLAYWRIGHT_BROWSERS_PATH=0` is a SUPPORTED Playwright configuration, not
  // an unusable one: it keeps browsers under `playwright-core/.local-browsers`.
  // An earlier version of this module reported `browsersPresent: false` for it
  // unconditionally, which meant a project deliberately using package-local
  // browsers could never run a browser probe despite having a complete
  // installation. Reported by the codex re-review of this branch. The path is
  // resolved here rather than in `specwitnessPlaywrightCacheDir` because it
  // depends on WHICH package resolved, which that pure function cannot know.
  const browsersPath =
    paths.browsersPackageLocal && coreDir !== null
      ? join(coreDir, PACKAGE_LOCAL_BROWSERS_DIR)
      : context.browsersPath;

  const browsersPresent = await hasRequiredChromium(coreDir, browsersPath);

  return {
    source,
    packageDir,
    cliPath: join(packageDir, manifest.binRelative ?? FALLBACK_CLI_ENTRY),
    version: manifest.version,
    browsersPath,
    browsersPathFromEnv: paths.browsersPathFromEnv,
    browsersPresent,
    ready: browsersPresent,
    cacheDir: paths.cacheDir,
  };
}

/** The facts this module reads out of a resolved package's own manifest. */
interface PackageManifest {
  /** `null` when unreadable — reported as an unknown version, never guessed. */
  readonly version: string | null;
  /** The `bin` entry for Playwright's CLI, relative to the package directory. */
  readonly binRelative: string | null;
}

/**
 * Read the resolved package's manifest once, for both facts that come from it.
 *
 * An unreadable manifest is NOT a failure: the package still resolves and a run
 * could still drive it, so the version is reported unknown and the CLI path
 * falls back — a spawn against a wrong path is classified as an `InfraError`
 * with a real diagnosis, which beats refusing an installation that may work.
 */
async function readManifest(packageDir: string): Promise<PackageManifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return { version: null, binRelative: null };
    }
    const declared = parsed as { version?: unknown; bin?: unknown };
    const version =
      typeof declared.version === 'string' && declared.version !== '' ? declared.version : null;
    return { version, binRelative: playwrightBinEntry(declared.bin) };
  } catch {
    return { version: null, binRelative: null };
  }
}

/**
 * The CLI path Playwright's manifest declares.
 *
 * Both npm `bin` shapes are handled — a bare string, and the map form
 * `{"playwright": "cli.js"}` that `@playwright/test` actually uses — because
 * reading the field is only an improvement over hard-coding `cli.js` if it
 * reads the field as npm defines it.
 */
function playwrightBinEntry(bin: unknown): string | null {
  if (typeof bin === 'string' && bin !== '') {
    return bin;
  }
  if (typeof bin === 'object' && bin !== null) {
    const entry = (bin as Record<string, unknown>)['playwright'];
    if (typeof entry === 'string' && entry !== '') {
      return entry;
    }
  }
  return null;
}

/**
 * True when the registry holds a COMPLETE copy of every chromium bundle THIS
 * Playwright requires.
 *
 * Three things had to be got right here, and the first two were got wrong first:
 *
 * ONE — A PREFIX MATCH IS NOT ENOUGH. Playwright's registry accumulates one
 * directory per revision, so a developer machine routinely carries several: the
 * machine this was written on carried `chromium-1208`, `-1217`, `-1228` and
 * `-1234` side by side while the pinned 1.62.1 required exactly `1234`.
 * Accepting any `chromium-*` reported `ready` for a registry that could not
 * launch this Playwright at all.
 *
 * TWO — A DIRECTORY IS NOT AN INSTALLATION. An interrupted download leaves the
 * revision directory behind with nothing usable in it, so the name matching is
 * necessary and not sufficient. Playwright writes `INSTALLATION_COMPLETE` into
 * a bundle when the download finished, and reading its own marker is what makes
 * this a fact rather than an inference.
 *
 * THREE — CHROMIUM IS TWO BUNDLES, OR ONE, AND ONLY THE PROJECT'S MANIFEST
 * KNOWS WHICH. Current Playwright launches headless through a separate
 * `chromium_headless_shell-<revision>` that every browser probe uses by
 * default; releases predating it declare `chromium` alone. Requiring both of
 * everyone reported a correctly provisioned older project as permanently
 * unusable, which contradicts the project's-version-wins property. The
 * requirement list is read from the installed version's own `browsers.json`.
 *
 * The first three failures share one shape: provisioning skips a download it
 * needed, `doctor` reports success, and the failure surfaces later as
 * Playwright's own missing-executable error from a machine already called
 * green — the green-for-nothing hazard of this story arriving through the third
 * fact rather than the first. The fourth is its mirror image: a working
 * environment refused. All four came from successive codex reviews of this
 * branch, and all four were the same underlying mistake — judging readiness
 * from plausible heuristics instead of from Playwright's own data.
 *
 * FAIL-CLOSED throughout: anything that cannot be determined is `false`, never
 * a guess that happens to look green.
 */
async function hasRequiredChromium(
  coreDir: string | null,
  browsersPath: string,
): Promise<boolean> {
  const bundles = await requiredChromiumBundles(coreDir);
  if (bundles === null || bundles.length === 0) {
    return false;
  }

  for (const bundle of bundles) {
    if (!(await isCompleteBundle(join(browsersPath, bundle)))) {
      return false;
    }
  }
  return true;
}

/** True when Playwright's own completeness marker is in the bundle directory. */
async function isCompleteBundle(bundleDir: string): Promise<boolean> {
  try {
    const marker = await stat(join(bundleDir, INSTALLATION_COMPLETE));
    return marker.isFile();
  } catch {
    return false;
  }
}

/**
 * The bundle DIRECTORY NAMES this Playwright needs, e.g.
 * `['chromium-1234', 'chromium_headless_shell-1234']` for a current release and
 * `['chromium-1045']` for one predating the headless shell. `null` when the
 * manifest could not be read or does not describe chromium at all.
 *
 * DERIVED FROM THE INSTALLED VERSION'S OWN MANIFEST, never from a hard-coded
 * list. A hard-coded pair made `requiredChromiumBundles` return `null` for any
 * release whose `browsers.json` legitimately declares `chromium` alone — so a
 * project pinning such a version could have its own `playwright install
 * chromium` succeed and still be told the environment was unusable, which
 * contradicts the project's-version-wins property outright. Reported by the
 * third codex review of this branch.
 *
 * `installByDefault` is honoured, which is also what keeps
 * `chromium-tip-of-tree` out: `playwright install chromium` does not fetch it,
 * so requiring it would refuse every ordinary machine.
 *
 * Playwright's directory convention is the browser name with `-` replaced by
 * `_`, then the revision — `chromium-headless-shell` becomes
 * `chromium_headless_shell-1234`. Taken from `playwright-core`'s
 * `browsers.json`, the same table `playwright install` itself reads, so the two
 * cannot disagree about what a complete install looks like.
 */
async function requiredChromiumBundles(coreDir: string | null): Promise<string[] | null> {
  if (coreDir === null) {
    return null;
  }

  let browsers: { name?: unknown; revision?: unknown; installByDefault?: unknown }[];
  try {
    const parsed: unknown = JSON.parse(await readFile(join(coreDir, 'browsers.json'), 'utf8'));
    const declared = (parsed as { browsers?: unknown }).browsers;
    if (!Array.isArray(declared)) {
      return null;
    }
    browsers = declared as typeof browsers;
  } catch {
    return null;
  }

  const bundles: string[] = [];
  for (const name of CHROMIUM_FAMILY) {
    const entry = browsers.find(
      (candidate) => candidate.name === name && candidate.installByDefault === true,
    );
    if (entry === undefined) {
      // Not declared by THIS version, or not installed by default. Absent from
      // the requirement list rather than fatal — that is the difference between
      // reading a manifest and asserting one.
      continue;
    }
    const revision = revisionOf(entry.revision);
    if (revision === null) {
      // Declared but unusable: a manifest we cannot check against is one we
      // must not pretend to have checked. Fail closed.
      return null;
    }
    bundles.push(`${name.replaceAll('-', '_')}-${revision}`);
  }

  // No chromium entry at all means the manifest does not describe the browser
  // this product provisions, so there is nothing to verify and nothing to trust.
  return bundles.some((bundle) => bundle.startsWith(`${CHROMIUM_BROWSER_NAME}-`))
    ? bundles
    : null;
}

function revisionOf(raw: unknown): string | null {
  if (typeof raw === 'string' && raw !== '') {
    return raw;
  }
  if (typeof raw === 'number') {
    return String(raw);
  }
  return null;
}

/**
 * Walk the `node_modules` chain above `fromDir` for a package, WITHOUT leaving
 * `containerDir` and with no global fallback of any kind. Returns its
 * directory, or `null`.
 *
 * ⚠️ THE CONTAINER BOUND IS THE POINT, and it is the third time this module got
 * the same scope wrong. The primary `@playwright/test` resolution has always
 * required the package to live inside the project tree; this secondary lookup
 * did not, so a project-local `@playwright/test` with a missing or malformed
 * `playwright-core` let the walk climb out of the project and pick up an
 * ancestor's — including **SpecWitness's own**. The revision table and the
 * package-local browser path would then describe a DIFFERENT Playwright than
 * the one about to be driven, and readiness would be reported against the wrong
 * installation. Reported by the fifth codex review of this branch.
 *
 * It is also the second half of the `NODE_PATH` fix: Node's own resolution
 * consults `NODE_PATH` and the legacy global folders as a fallback and the
 * `paths` option does not suppress it (both measured), so `require.resolve` is
 * not used here at all. A bounded manual walk is the only lookup that answers
 * "inside THIS installation" and nothing wider.
 *
 * Iteration is bounded as well, so a symlink cycle or a malformed tree
 * terminates rather than climbing forever.
 */
function findPackageNear(fromDir: string, name: string, containerDir: string): string | null {
  let current = fromDir;

  for (let depth = 0; depth < 24; depth += 1) {
    if (!isWithin(containerDir, current)) {
      // Left the installation. Fail closed rather than borrow a neighbour's.
      break;
    }
    if (readFileSyncSafe(join(current, 'node_modules', name, 'package.json')) !== null) {
      return join(current, 'node_modules', name);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
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
 * `child` is `parent`, or beneath it. Both sides must ALREADY be realpath'd.
 *
 * `parent === child` counts, which is what lets `findPackageNear` start its
 * walk at the container itself.
 */
function isWithin(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Canonicalise a path that MAY NOT EXIST YET.
 *
 * ⚠️ THE NAIVE VERSION SILENTLY DEFEATS EVERY CONTAINMENT CHECK IN THIS FILE,
 * and it did. `realpath` throws on a path that does not exist, and falling back
 * to `resolve` returns the uncanonicalised string — so on macOS, where
 * `os.tmpdir()` is `/var/folders/...` and its realpath is
 * `/private/var/folders/...`, comparing a not-yet-created destination against a
 * realpath'd project root compared two spellings of the same directory and
 * answered "outside". That is how the AC1 destination guard passed its own unit
 * test while doing nothing, until the test was written and watched.
 *
 * So the nearest EXISTING ancestor is canonicalised and the missing tail is
 * re-appended: `<realpath of project>/.browsers` rather than
 * `<project as spelled>/.browsers`. Bounded, and it falls back to `resolve` for
 * a path with no existing ancestor at all.
 */
async function realpathOrResolve(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.slice().reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.push(basename(current));
      current = parent;
    }
  }

  return absolute;
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

  // READINESS IS CHECKED FIRST, before any refusal. An earlier version rejected
  // `PLAYWRIGHT_BROWSERS_PATH=0` outright, which turned a supported and
  // COMPLETE package-local installation into an unusable one — a refusal aimed
  // at a configuration SpecWitness cannot write into, fired at one it did not
  // need to write into at all. Reported by the codex re-review of this branch.
  const existing = await resolvePlaywrightEnvironment(options);
  if (existing.ready && !isStaleOwnedCache(existing)) {
    return existing;
  }

  // ⚠️ NOTHING IS WRITTEN INTO THE TARGET PROJECT, INCLUDING WHEN THE OPERATOR
  // ASKS FOR IT. `PLAYWRIGHT_BROWSERS_PATH` and `XDG_CACHE_HOME` are operator
  // input, and a value under `projectRoot` — `<project>/.browsers`, say —
  // pointed hundreds of megabytes straight into the repository under
  // verification. AC1 and FR-24 forbid that outright: a target repository that
  // gained a browser bundle because it was verified has been damaged by its
  // verifier. Reported by the sixth codex review of this branch.
  //
  // The default paths were asserted against this from the start; the
  // ENV-DERIVED ones were not, which is the same shape as this module's other
  // scope errors — a rule proven for one input and not applied to the next.
  //
  // Placed HERE, after the readiness check, on purpose: resolution is read-only
  // and an already-ready environment writes nothing, so refusing it would break
  // a working setup for no benefit — exactly the mistake the `=0` refusal made
  // before it was narrowed.
  const projectReal = await realpathOrResolve(context.projectRoot);

  if (existing.source === 'project') {
    if (paths.browsersPackageLocal) {
      // A refusal, exit 3, and now narrowly scoped: only the PROJECT route.
      // `=0` puts the bundle inside the Playwright package, which for a
      // project's own installation means inside the project's `node_modules` —
      // and a target repository that gained a browser bundle because it was
      // verified would have been damaged by its verifier (AC1, FR-24).
      throw new InfraError(
        `PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH_PACKAGE_LOCAL} asks Playwright to keep browsers ` +
          `inside its own package directory, and SpecWitness will not write a browser bundle into ` +
          `a project's tree`,
        `run \`npx playwright install ${PROVISIONED_BROWSER}\` yourself to populate it, or unset ` +
          'PLAYWRIGHT_BROWSERS_PATH (or point it at a directory SpecWitness may write to) and run ' +
          'the command again',
      );
    }
    await refuseWriteInsideProject(projectReal, existing.browsersPath, paths);
    await installBrowsers(options, context.projectRoot, existing, existing.browsersPath);
    return await requireReady(options, 'project');
  }

  await refuseWriteInsideProject(projectReal, paths.browsersPath, paths);
  await refuseWriteInsideProject(projectReal, paths.cacheDir, paths);

  // The owned-cache route. `=0` is honoured here rather than refused: the
  // fallback package AND its `.local-browsers` both live inside SpecWitness's
  // own cache, so there is no project tree to damage. Reported by the fourth
  // codex review, which is worth naming — the earlier refusal was written for
  // the project route and applied to both by accident.
  await installPackageIntoCache(options, { ...paths, platform: context.platform });

  const installed = await resolvePlaywrightEnvironment(options);
  if (installed.source !== 'specwitness-cache') {
    throw new InfraError(
      `${PLAYWRIGHT_PACKAGE} did not resolve from ${paths.cacheDir} after installing it there`,
      'remove the SpecWitness Playwright cache and run the command again; if it recurs, the ' +
        'install is being written somewhere else — check npm config prefix',
    );
  }

  await installBrowsers(
    options,
    paths.cacheDir,
    installed,
    // `0` is passed through verbatim so Playwright puts the bundle inside the
    // cache's own package, which is exactly where the operator asked for it and
    // is still SpecWitness-owned.
    paths.browsersPackageLocal ? BROWSERS_PATH_PACKAGE_LOCAL : paths.browsersPath,
  );
  return await requireReady(options, 'specwitness-cache');
}

/**
 * Refuse, before any byte is written, a provisioning destination that lies
 * inside the target project.
 *
 * Exit 3 with a hint naming the variable that chose it, because this is an
 * environment problem the operator can fix in one command — never a product
 * FAIL, and never a silent redirect to somewhere SpecWitness prefers: writing
 * hundreds of megabytes to a path the operator did not ask for would be its own
 * surprise.
 */
async function refuseWriteInsideProject(
  projectReal: string,
  destination: string,
  paths: PlaywrightCachePaths,
): Promise<void> {
  if (!isWithin(projectReal, await realpathOrResolve(destination))) {
    return;
  }

  const culprit = paths.browsersPathFromEnv && destination === paths.browsersPath
    ? 'PLAYWRIGHT_BROWSERS_PATH'
    : 'the resolved SpecWitness cache directory (XDG_CACHE_HOME, LOCALAPPDATA or the home directory)';

  throw new InfraError(
    `provisioning would write to ${destination}, which is inside the target project ` +
      `${projectReal}; SpecWitness never writes into the project it is verifying`,
    `${culprit} points inside the project — point it somewhere outside the project tree, or ` +
      `unset it to use SpecWitness's own cache, then run the command again`,
  );
}

/**
 * True when a ready environment is SpecWitness's OWN cache at a version this
 * build was never exercised against.
 *
 * A ready cache would otherwise be reused indefinitely across SpecWitness
 * upgrades, so bumping `PROVISIONED_PLAYWRIGHT_VERSION` would change the pin
 * everywhere except on the machines that already had a cache — browser probes
 * running against an untested fallback while `package.json` said otherwise.
 * That is the contract-freeze rule's own concern: implementation must never
 * silently change expected behaviour. Reported by the fourth codex review.
 *
 * A PROJECT's installation is deliberately exempt. Its version is the project's
 * decision, and honouring it is the whole reason the project is preferred
 * (FR-24) — the pin bounds only what SpecWitness installs for itself.
 */
function isStaleOwnedCache(environment: PlaywrightResolved | PlaywrightAbsent): boolean {
  return (
    environment.source === 'specwitness-cache' &&
    environment.version !== PROVISIONED_PLAYWRIGHT_VERSION
  );
}

/**
 * Create the cache directory and its private manifest, translating a raw
 * filesystem failure into this module's own error type.
 *
 * ⚠️ THE UNWRAPPED VERSION BROKE THIS MODULE'S ONE PROMISE.
 * `provisionPlaywright` says every failure is an `InfraError` carrying
 * `ERROR:`/`HINT:` material, and an unwritable or read-only cache made `mkdir`
 * or `writeFile` reject with a bare `EACCES`/`EROFS` before the classified npm
 * invocation was ever reached. The exit code was still 3 — `exitCodeForError`
 * fails closed — but the operator got a filesystem error with no hint, no
 * mention of which directory SpecWitness had chosen, and no way to move it.
 * Reported by the seventh codex review of this branch.
 *
 * A private manifest is written so npm treats the cache as its own project and
 * does not walk upward into whatever happens to be above it.
 */
async function prepareCacheDirectory(cacheDir: string): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'package.json'),
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
  } catch (error) {
    throw new InfraError(
      `could not prepare the SpecWitness Playwright cache at ${cacheDir}: ${echo(
        error instanceof Error ? error.message : String(error),
      )}`,
      'check that directory is writable, or point the cache root elsewhere (XDG_CACHE_HOME on ' +
        'Linux, LOCALAPPDATA on Windows) and run the command again',
    );
  }
}

/**
 * `npm install @playwright/test@<pinned>` into the cache.
 *
 * A private manifest is written first so npm treats the cache as its own
 * project and does not walk upward into whatever happens to be above it.
 */
async function installPackageIntoCache(
  options: ProvisionOptions,
  paths: PlaywrightCachePaths & { readonly platform: NodeJS.Platform },
): Promise<void> {
  await prepareCacheDirectory(paths.cacheDir);

  const npmBinary = options.npmBinary ?? defaultNpmBinary(paths.platform);

  const result = await spawn(options, {
    binary: npmBinary,
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

  classify(result, `installing ${PLAYWRIGHT_PACKAGE} into ${paths.cacheDir}`, npmBinary);
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

/**
 * `npm` is a shell script on POSIX and a `.cmd` batch file on Windows, and
 * `ProcessRunner` spawns with no shell (AD-3) — so on Windows the bare name
 * does not resolve to anything executable.
 *
 * NOT VERIFIED ON WINDOWS, and said so in the PR body rather than implied: no
 * gate in five epics has run on it. It is written this way because a bare
 * `npm` there is knowably wrong, not because the alternative is tested.
 */
function defaultNpmBinary(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
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
