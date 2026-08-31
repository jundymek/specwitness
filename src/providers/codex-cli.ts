/**
 * The Codex CLI adapter — story 2.5, FR-13, FR-15.
 *
 * A THIN TRANSLATION LAYER, and nothing more: an AD-2 request envelope goes in,
 * a `codex exec` argv array goes out, the model's RAW text comes back. It does
 * not validate, retry, record attempts, or build domain objects — all of that is
 * `providers/invoke.ts`, implemented exactly once for every provider (AD-2). If
 * you are about to add a zod call to this file, stop: a second validation here
 * is precisely the defect AD-2 exists to prevent.
 *
 * Codex is the model-diversity half of ADR-001. A Codex-authored verification
 * contract for Claude-authored code is a genuinely independent reading of the
 * same spec, which is the whole premise of catching correlated misunderstanding.
 * `codex exec --output-schema` makes it a better-BEHAVED provider than claude —
 * it constrains the final response to a JSON Schema, so malformed output is
 * rarer. It does not make it an AUTHORITY, and rarer is not impossible: every
 * response still passes the shared gate.
 *
 * DECISIONS THAT ARE AGREED, NOT PREFERENCES (cohort intent-sync, 2026-08-31):
 *
 * - An UNRECOGNIZED `mode` withholds the billing variable anyway, and warns.
 *   Failing safe on billing is cheaper than an unexpected charge on a user's
 *   account. Agreed identically with story 2.4 so the two adapters cannot
 *   disagree about when money is at risk.
 * - A billing variable that is SET BUT EMPTY counts as present: presence of the
 *   NAME is what matters, because we never look at the value.
 * - The warning is emitted through the injected `WarnSink`, never `process.stderr`
 *   (AD-1: the edge owns output), and it names the variable (FR-15).
 *
 * SECURITY (NFR-1, AD-3, AD-4), all mechanically enforced:
 * - Nothing here reads `~/.codex/`, `CODEX_HOME`, or any credential store. Ever.
 *   ChatGPT OAuth stays entirely the Codex CLI's business, and auth readiness is
 *   probed only through the CLI's own public surface (`codex doctor`, Q58).
 * - Fixed binary name + argv array. No shell, no `sh -c`, no interpolation, so a
 *   prompt full of shell metacharacters is inert by construction rather than by
 *   escaping. There is a test that proves it rather than a comment that claims it.
 * - `codex` is SpecWitness's own trusted tool (like `git`), NOT a
 *   `DeclaredCommand`. Do not import that brand or try to mint one here.
 * - The parent environment is never mutated. The child environment is built by
 *   OMISSION, via `ChildEnvironment`.
 */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { AgentPrompt, AgentProvider, WarnSink } from '../domain/agent-provider.js';
import { ProviderError } from '../domain/errors.js';
import type { ChildEnvironment, ProcessRunner } from '../domain/process-runner.js';

import { stripCodeFence } from './text.js';

/**
 * The binary name, fixed. Never built from config and never interpolated — that
 * is the AD-3 boundary, and it is why a hostile prompt cannot become a command.
 */
const BINARY = 'codex';

/**
 * Probes are bounded at the spawn, not by the caller, matching the 5s
 * `src/cli/doctor/checks/git.ts` already uses. A diagnostic that can hang is not
 * a diagnostic.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Authoring a contract is a real model call over a whole epic, so the default is
 * generous. It is still a bound: no invocation waits forever.
 */
const DEFAULT_INVOKE_TIMEOUT_MS = 600_000;

/**
 * The billing-risk variable FR-15 names for this provider. This is the ONLY
 * environment name this module knows, and it is named here in order to WITHHOLD
 * it — the categorical opposite of reading a credential, which is why the NFR-1
 * guard's provider allow-list admits it with that justification attached.
 *
 * AD-4 says "provider equivalents", plural, so the obvious question is whether
 * this list is too short. It was checked against the CLI's own help rather than
 * guessed at, and the answer is no:
 *
 * - `OPENAI_API_KEY` is the one variable that authenticates an OpenAI account
 *   and therefore BILLS it. `codex login --with-api-key` documents it by name.
 * - `CODEX_ACCESS_TOKEN` also appears in `codex login --help`, but it is a
 *   ChatGPT *access token*, not an API key: withholding it would not prevent a
 *   charge, and could break a legitimately signed-in subscription user. Adding
 *   it would trade a real regression for no billing benefit.
 * - The remaining `OPENAI_*` variables in common use (`OPENAI_BASE_URL`,
 *   `OPENAI_ORG_ID`) select a route or attribute usage; neither authenticates,
 *   so neither can bill on its own.
 *
 * Story 2.4 widened its Anthropic list to include `ANTHROPIC_AUTH_TOKEN`, which
 * is correct there — that is a documented alternative credential that bills.
 * The OpenAI side has no equivalent, so mirroring the change for symmetry's sake
 * would be cargo-culting. A project needing more declares them via
 * `billingEnvVars`, which EXTENDS this list and can never shrink it.
 */
const DEFAULT_BILLING_ENV_VARS: readonly string[] = ['OPENAI_API_KEY'];

/**
 * Above this many bytes the prompt travels on STDIN instead of in argv.
 *
 * Not a guess — the platform limit that binds is Linux's `MAX_ARG_STRLEN`, a
 * per-argument cap of 32 pages (131072 bytes) that holds INDEPENDENTLY of the
 * much larger `ARG_MAX` total. macOS is far more permissive (measured on this
 * machine: `ARG_MAX` 1048576, largest single argument ~1041408 bytes), so a
 * ~300 KiB prompt succeeds here and fails with `E2BIG` on Linux and in CI. A
 * contract prompt carries an EpicSpec plus its criteria, so 300 KiB is not a
 * hypothetical size, and the bug would present as an intermittent host-specific
 * adapter failure — exactly what deciding this now is meant to prevent.
 *
 * 64 KiB sits comfortably under the Linux cap with room for the flags and a
 * large environment, rather than near any platform's true ceiling. Below it the
 * prompt stays in argv, so AD-3's "argv array, no shell, nothing interpolated"
 * remains the ordinary path and stays trivially provable.
 *
 * `codex exec` documents the fallback itself: "If not provided as an argument
 * (or if `-` is used), instructions are read from stdin." So this uses the
 * CLI's own mechanism rather than inventing one. Note it also says a piped
 * stdin alongside a prompt argument is APPENDED as a `<stdin>` block — which is
 * why the two paths are exclusive and never both.
 *
 * The macOS numbers were measured; the Linux constant is documented and NOT
 * verified here (no Linux host in this worktree). Stated as such in the PR body.
 */
const ARGV_PROMPT_LIMIT_BYTES = 64 * 1024;

/**
 * Every `codex exec` flag this adapter actually puts on a command line.
 *
 * AD-4 permits hardcoding a *tested minimum* — `exec --output-schema`, two
 * things. That is what we may ASSUME. It is not a licence to use other flags
 * unprobed: `--output-last-message` is how the answer is captured
 * deterministically and `--cd` is how the target directory is set explicitly, so
 * a codex lacking either cannot do this job at all. Probing only the minimum and
 * then invoking the rest hopefully is precisely the failure AD-4 exists to
 * prevent — it would report a fully capable CLI and fail at the point of use.
 *
 * `--skip-git-repo-check` is deliberately NOT here: it is conditional (needed
 * only for a non-git target), so its absence is handled at invocation time
 * rather than disqualifying an otherwise usable CLI.
 */
const REQUIRED_EXEC_FLAGS: readonly string[] = [
  '--output-schema',
  '--output-last-message',
  '--cd',
];

/** `codex exec`'s documented "read the prompt from stdin" sentinel. */
const STDIN_PROMPT = '-';

/** The mode that means "the user pays through a subscription, not an API key". */
const SUBSCRIPTION_MODE = 'chatgpt';

export interface ProbeOptions {
  readonly timeoutMs?: number;
  /**
   * Extra billing-risk variable names to withhold, on top of the defaults.
   *
   * Probes withhold the SAME variables an invocation does, and that is load
   * bearing for two separate reasons:
   *
   * 1. **The probe must predict the invocation.** `codex doctor` run with
   *    `OPENAI_API_KEY` inherited can report auth as usable *because of the API
   *    key* — while the real `codex exec`, which withholds it, then fails. A
   *    diagnostic that answers a different question from the one it claims to
   *    answer is worse than no diagnostic, and story 2.7 renders this verbatim.
   * 2. **The FR-15 guarantee is about codex SUBPROCESSES, not about `exec`.**
   *    `codex doctor` is one. Leaking the key into it would break the guarantee
   *    in a place nobody thought to look.
   *
   * Like `CodexAdapterOptions.billingEnvVars`, this EXTENDS the defaults and can
   * never shrink them.
   */
  readonly billingEnvVars?: readonly string[];
}

/**
 * What we could establish about the local `codex`, for story 2.7's doctor check
 * to render. Shape pinned with dolph during intent-sync — he codes against it
 * verbatim, so it must not be changed for convenience here.
 *
 * Nothing on the probe path throws: a missing CLI is a FLAG, because every
 * provider doctor check is `required: false` and a missing agent CLI must never
 * make `doctor` exit non-zero (UJ-4 — contract *generation* becomes unavailable,
 * but execution of existing plans still works).
 */
export interface CodexCapability {
  readonly binary: string;
  /** Resolved on PATH and answered at all. */
  readonly found: boolean;
  /** As reported by `codex --version`. `undefined` when it could not be read. */
  readonly version?: string;
  /** The `exec` subcommand exists. */
  readonly execAvailable: boolean;
  /** `exec` accepts `--output-schema` — half of AD-4's hardcodable minimum. */
  readonly outputSchemaSupported: boolean;
  /** `exec` accepts `--skip-git-repo-check`, needed for a non-git `-C` target. */
  readonly skipGitRepoCheckSupported: boolean;
  /**
   * Required `exec` flags this codex did NOT advertise, if any.
   *
   * Additive field: story 2.7 pinned the fields above and none of them changed,
   * so its call sites and rendering keep working untouched — `reason` already
   * carries the human-readable version of this.
   */
  readonly missingFlags?: readonly string[];
  /** Operator-facing, present only when something above is false. */
  readonly reason?: string;
}

/**
 * Auth readiness via `codex doctor` — the CLI's own public surface (Q58). Never
 * filesystem inspection.
 *
 * `conclusive` exists because `ok: false` would otherwise conflate two states
 * that mean different things to a user: "codex says you are not signed in" is a
 * diagnosis, whereas "the probe timed out" or "this codex has no `doctor`
 * subcommand" is NOT a diagnosis about their auth and must never be rendered as
 * one. Requested by dolph during intent-sync; do not collapse it into
 * `exitCode === null`, which would break the first time something returns null
 * for a reason neither story predicted.
 */
export interface CodexAuthProbe {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly conclusive: boolean;
  readonly detail?: string;
}

/**
 * Per-session capability cache (AD-4: probe at runtime, cache per session).
 *
 * Keyed by binary name and holding the in-flight PROMISE, so several roles
 * resolving to the same codex — the addendum's sketch points both
 * `contract-author` and `plan-author` at it — probe once even when they start
 * concurrently. `doctor`'s registry is deliberately sequential, so this is what
 * keeps it fast.
 *
 * There is deliberately no "bypass the cache" option: `specwitness doctor` is a
 * fresh process, so the table starts empty on every run and an operator always
 * sees live state. A `fresh` flag would be dead surface with no caller.
 */
const capabilityCache = new Map<string, Promise<CodexCapability>>();

/** Test-only: drops the session cache so each case probes from a clean slate. */
export function resetCodexProbeCache(): void {
  capabilityCache.clear();
}

/**
 * Pulls a version out of `codex --version` output.
 *
 * Deliberately lenient — a future codex may reword this line, and refusing to
 * record a version we could not pattern-match would make the adapter fail for a
 * cosmetic change. Leniency here is safe because it is NOT what proves
 * capability: the `--output-schema` check below is. A program on PATH called
 * `codex` that is not the Codex CLI passes this and still fails there, which is
 * exactly the "must not accept arbitrary output as proof of capability" case.
 */
function parseVersion(stdout: string): string | undefined {
  const firstLine = stdout.trim().split('\n')[0]?.trim();
  if (firstLine === undefined || firstLine === '') {
    return undefined;
  }
  // Prefer the bare semver ("0.144.4" out of "codex-cli 0.144.4") so consumers
  // can render "codex v0.144.4" without re-parsing; fall back to the whole line.
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(firstLine)?.[1] ?? firstLine;
}

function notFound(reason: string): CodexCapability {
  return {
    binary: BINARY,
    found: false,
    execAvailable: false,
    outputSchemaSupported: false,
    skipGitRepoCheckSupported: false,
    missingFlags: REQUIRED_EXEC_FLAGS,
    reason,
  };
}

/**
 * Probes the local `codex` for everything the adapter and doctor need.
 *
 * AD-4's hardcodable minimum is `exec --output-schema` — two things, not a flag
 * list. Everything else (`-o/--output-last-message`, `-C/--cd`,
 * `--skip-git-repo-check`) is what we probe FOR, never what we assume; ADR-001's
 * first concern is that these CLIs evolve fast.
 *
 * Flags are probed via `exec --help`, which lists them WITHOUT invoking a model.
 * Probing therefore costs nothing, consumes no subscription, and is safe to run
 * from `doctor`.
 */
export async function probeCodexCapability(
  runner: ProcessRunner,
  options: ProbeOptions = {},
): Promise<CodexCapability> {
  const cached = capabilityCache.get(BINARY);
  if (cached !== undefined) {
    return cached;
  }
  const probe = probeUncached(
    runner,
    options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    billingNames(options.billingEnvVars),
  );
  capabilityCache.set(BINARY, probe);
  return probe;
}

async function probeUncached(
  runner: ProcessRunner,
  timeoutMs: number,
  withhold: readonly string[],
): Promise<CodexCapability> {
  const version = await runner.run({
    binary: BINARY,
    args: ['--version'],
    cwd: process.cwd(),
    timeoutMs,
    env: childEnvironment(withhold),
    input: '',
  });

  if (version.outcome === 'not-found') {
    return notFound(
      `${BINARY} not found on PATH — contract generation unavailable; existing plans still run`,
    );
  }
  if (version.outcome === 'timed-out') {
    return notFound(`${BINARY} did not respond within ${timeoutMs}ms — could not determine capability`);
  }
  if (version.outcome === 'spawn-failed') {
    // NOT the same as "absent". Story 2.3's runner reports `spawn-failed` for a
    // non-existent working directory as well as for a binary that could not be
    // launched, so this must not claim the CLI is missing — telling an operator
    // to install a CLI they already have is worse than saying we could not tell.
    return notFound(
      `${BINARY} could not be started — contract generation unavailable (the binary may not be executable, or the working directory may not exist)`,
    );
  }
  if (version.exitCode !== 0) {
    return notFound(
      `${BINARY} --version exited ${String(version.exitCode)} — found a "${BINARY}" on PATH that could not be identified`,
    );
  }

  const reported = parseVersion(version.stdout);

  const help = await runner.run({
    binary: BINARY,
    args: ['exec', '--help'],
    cwd: process.cwd(),
    timeoutMs,
    env: childEnvironment(withhold),
    input: '',
  });

  const base = { binary: BINARY, found: true, version: reported } as const;

  if (help.outcome !== 'completed' || help.exitCode !== 0) {
    return {
      ...base,
      execAvailable: false,
      outputSchemaSupported: false,
      skipGitRepoCheckSupported: false,
      missingFlags: REQUIRED_EXEC_FLAGS,
      reason: `${BINARY} has no usable "exec" subcommand — contract generation unavailable`,
    };
  }

  // Both streams: a CLI may print help to either, and which one is not a
  // stable contract worth depending on.
  const helpText = `${help.stdout}\n${help.stderr}`;
  const outputSchemaSupported = helpText.includes('--output-schema');
  const skipGitRepoCheckSupported = helpText.includes('--skip-git-repo-check');

  // EVERY flag the invocation actually uses is probed, not just AD-4's
  // hardcodable minimum. `--output-schema` is the minimum we are allowed to
  // assume; `--output-last-message` and `--cd` are ones we USE, and a capability
  // we need but cannot confirm must produce a capability error rather than a
  // hopeful invocation. A codex new enough for `--output-schema` but missing
  // either of these would otherwise be reported as fully capable and then fail
  // at the point of use, which is the failure AD-4 exists to prevent.
  const missingFlags = REQUIRED_EXEC_FLAGS.filter((flag) => !helpText.includes(flag));

  const versionSuffix = reported === undefined ? '' : ` (v${reported})`;

  return {
    ...base,
    execAvailable: true,
    outputSchemaSupported,
    skipGitRepoCheckSupported,
    missingFlags,
    reason:
      missingFlags.length === 0
        ? undefined
        : `${BINARY}${versionSuffix} does not accept ${missingFlags.join(' or ')} — contract generation unavailable`,
  };
}

/**
 * Auth readiness, via `codex doctor` only (Q58).
 *
 * Story 2.7 renders this; it writes no probe of its own, so that what `doctor`
 * reports and what an invocation would actually do cannot drift apart — the one
 * failure a diagnostic tool must not have.
 */
export async function probeCodexAuth(
  runner: ProcessRunner,
  options: ProbeOptions = {},
): Promise<CodexAuthProbe> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Withheld here for the same reason generation withholds: `codex doctor` must
  // answer the question a real `codex exec` would face, not a more permissive
  // one. Inheriting the API key could report auth as usable on the strength of
  // a credential the invocation then removes.
  const withhold = billingNames(options.billingEnvVars);
  const result = await runner.run({
    binary: BINARY,
    args: ['doctor'],
    cwd: process.cwd(),
    timeoutMs,
    env: childEnvironment(withhold),
    input: '',
  });

  if (result.outcome === 'not-found') {
    return {
      ok: false,
      exitCode: null,
      conclusive: false,
      detail: `${BINARY} not found on PATH — could not determine auth readiness`,
    };
  }
  if (result.outcome === 'timed-out') {
    return {
      ok: false,
      exitCode: null,
      conclusive: false,
      detail: `${BINARY} doctor did not respond within ${timeoutMs}ms — could not determine auth readiness`,
    };
  }
  if (result.outcome === 'spawn-failed') {
    return {
      ok: false,
      exitCode: null,
      conclusive: false,
      detail: `${BINARY} doctor could not be started — could not determine auth readiness`,
    };
  }
  if (result.exitCode === 0) {
    return { ok: true, exitCode: 0, conclusive: true };
  }

  // An old codex without the subcommand is "could not tell", NOT "not signed in".
  const combined = `${result.stdout}\n${result.stderr}`;
  const missingSubcommand = /unrecognized subcommand|unknown subcommand|unexpected argument/i.test(
    combined,
  );

  return {
    ok: false,
    exitCode: result.exitCode,
    conclusive: !missingSubcommand,
    detail: missingSubcommand
      ? `this ${BINARY} has no "doctor" subcommand — could not determine auth readiness`
      : firstMeaningfulLine(combined) ??
        `${BINARY} doctor exited ${String(result.exitCode)} — auth does not appear usable`,
  };
}

/**
 * Whether `dir` is inside a git working tree, by walking up for `.git`.
 *
 * Deliberately NOT `git rev-parse`: this adapter's AD-3 contract is that the
 * only binary it ever spawns is `codex`, and spawning `git` here to answer a
 * capability question would widen that for no benefit. `.git` is a file as well
 * as a directory in worktrees and submodules, so existence is the right test
 * rather than "is a directory".
 *
 * Called only when `--skip-git-repo-check` is unavailable, so the common path
 * touches the filesystem not at all.
 */
async function isInsideGitRepo(dir: string): Promise<boolean> {
  let current = resolve(dir);
  for (;;) {
    try {
      await access(join(current, '.git'));
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
    }
  }
}

/**
 * Compose the text the model sees, folding in the envelope's `contextFiles`.
 *
 * Appended as a delimited path list rather than passed through a flag: codex has
 * no probed flag for attaching text files (`-i/--image` is for images), and AD-4
 * forbids reaching for one that has not been tested.
 *
 * The format is BYTE-IDENTICAL to story 2.4's `composePrompt`, deliberately.
 * Both adapters answer the same envelope for the same roles, so a contract's
 * quality must not depend on which provider happened to run — and story 2.6
 * cannot compensate for a difference it cannot see. Dropping `contextFiles`
 * entirely, which is what this file did before, meant the codex path silently
 * lost context the caller had asked for.
 *
 * NOTE — known duplication, raised rather than hidden: this is the same five
 * lines in both adapters. `src/providers/text.ts` (story 2.4's shared helper) is
 * the natural home, but it is already merged and it is not this story's file to
 * edit. Flagged to story 2.4 and the supervisor for consolidation; pinned by a
 * test here in the meantime so the two cannot drift silently.
 */
function composePrompt(prompt: AgentPrompt): string {
  if (prompt.contextFiles === undefined || prompt.contextFiles.length === 0) {
    return prompt.prompt;
  }
  const list = prompt.contextFiles.map((file) => `- ${file}`).join('\n');
  return `${prompt.prompt}\n\nContext files:\n${list}`;
}

function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }
  return undefined;
}

export interface CodexAdapterOptions {
  /** Extra billing-risk variable names this project declares. */
  readonly billingEnvVars?: readonly string[];
  /** Directory `codex` runs in. Passed explicitly via `-C`, never inherited. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
}

export interface CodexAdapterDeps {
  readonly runner: ProcessRunner;
  readonly warn: WarnSink;
}

/**
 * Builds the CHILD environment by OMISSION.
 *
 * `withhold` deletes the name from an otherwise-inherited environment, and
 * `ProcessRunner` spawns with `extendEnv: false`, so what this returns IS the
 * child's entire environment — nothing is merged back on top. The parent's
 * `process.env` is read but NEVER mutated: no `delete process.env.X`, no
 * assignment to it. There is a test asserting the parent still holds the
 * variable after a call, because getting this wrong costs a user real money.
 */
function childEnvironment(withhold: readonly string[]): ChildEnvironment {
  return { inherit: true, withhold };
}

/**
 * The billing-risk names to withhold, defaults UNION caller-supplied.
 *
 * One resolver for probes and generation alike, so the two can never drift into
 * withholding different sets — which is the bug that would let `codex doctor`
 * answer a different question from the `codex exec` it exists to predict. It
 * only ever grows the list: there is deliberately no way to withhold fewer
 * variables than the defaults.
 */
function billingNames(extra: readonly string[] | undefined): readonly string[] {
  return [...new Set([...DEFAULT_BILLING_ENV_VARS, ...(extra ?? [])])];
}

/**
 * Which billing-risk variables are present in the parent environment.
 *
 * Presence of the NAME counts, even when the value is empty — agreed with story
 * 2.4 so the two adapters cannot disagree. We never read the value for any
 * purpose other than knowing the name is set, and we never log either.
 */
function presentBillingVars(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): readonly string[] {
  return names.filter((name) => Object.hasOwn(env, name));
}

/**
 * Emits the FR-15 billing warnings.
 *
 * WITHHOLDING IS UNCONDITIONAL, and that is a deliberate reading of the
 * artifacts rather than an oversight. `ai.providers.<name>.mode` is validated
 * only as a non-empty string (story 1.3), and the sole modes any planning
 * artifact defines are `subscription` (claude) and `chatgpt` (codex) — both of
 * which withhold. NOTHING defines a mode that opts INTO API-key billing. So
 * there is no value of `mode` for which passing `OPENAI_API_KEY` to the child is
 * an authorized outcome, and inventing one would create a silent-billing escape
 * hatch reachable by a typo the schema does not catch. An unrecognized mode
 * withholds and warns (agreed with story 2.4): failing safe on billing is
 * cheaper than an unexpected charge on someone's account. Adding an opt-in mode
 * later is an explicit config-schema change plus an ADR, not a condition here.
 */
function warnAboutBilling(
  mode: string,
  billingEnvVars: readonly string[],
  warn: WarnSink,
): void {
  for (const name of presentBillingVars(process.env, billingEnvVars)) {
    warn(`⚠ ${name} present in environment — withheld from the ${BINARY} subprocess (mode: ${mode})`);
  }
  if (mode !== SUBSCRIPTION_MODE) {
    warn(
      `⚠ unrecognized provider mode "${mode}" for the ${BINARY} adapter — withholding billing variables anyway`,
    );
  }
}

/**
 * Creates the adapter. `mode` comes from `ai.providers.<name>.mode`, already
 * validated as a non-empty string by story 1.3.
 */
export function createCodexCliProvider(
  descriptor: { readonly name: string; readonly mode: string },
  deps: CodexAdapterDeps,
  options: CodexAdapterOptions = {},
): AgentProvider {
  const billingEnvVars = [
    ...new Set([...DEFAULT_BILLING_ENV_VARS, ...(options.billingEnvVars ?? [])]),
  ];

  return {
    id: descriptor.name,
    adapter: 'codex-cli',
    generate: (prompt) =>
      generate(prompt, descriptor.mode, billingEnvVars, deps, options),
  };
}

async function generate(
  prompt: AgentPrompt,
  mode: string,
  billingEnvVars: readonly string[],
  deps: CodexAdapterDeps,
  options: CodexAdapterOptions,
): Promise<string> {
  // Warn BEFORE probing, not after. The probe itself spawns `codex` with these
  // variables withheld, so by the time it returns the warning is already a
  // statement about something that happened. Emitting it afterwards means a
  // probe that fails or times out SUPPRESSES a warning FR-15 requires — the
  // operator would be told nothing about a withholding that did occur. Story
  // 2.4 warns pre-probe for the same reason, so the two adapters agree.
  warnAboutBilling(mode, billingEnvVars, deps.warn);

  const capability = await probeCodexCapability(deps.runner, {
    timeoutMs: options.probeTimeoutMs,
    billingEnvVars,
  });

  // A capability we need but could not confirm produces a capability ERROR, not
  // a hopeful invocation (AD-4). Exit 3 — infra, never a product FAIL.
  if (
    !capability.found ||
    !capability.execAvailable ||
    !capability.outputSchemaSupported ||
    (capability.missingFlags?.length ?? 0) > 0
  ) {
    throw new ProviderError(
      capability.reason ?? `${BINARY} cannot author verification artifacts`,
      `install or update the Codex CLI, then re-run 'specwitness doctor'`,
    );
  }

  const cwd = options.cwd ?? process.cwd();

  // ONE temp directory per invocation, created atomically by `mkdtemp`. That
  // makes a filename collision between two concurrent invocations impossible
  // without inventing an entropy scheme, and it makes cleanup a single `rm` in
  // the `finally` below. It lives in the OS temp dir, never in the user's
  // project tree: nothing in this story writes under `.specwitness/`, where
  // `RunStore` is the sole writer (AD-8), and we are not in a run.
  const workspace = await mkdtemp(join(tmpdir(), 'specwitness-codex-'));
  const lastMessagePath = join(workspace, 'last-message.txt');

  try {
    const args = ['exec'];

    // The gate derives the JSON Schema and forwards it untouched (story 2.3).
    // This adapter must NOT derive one as well: two derivations that can
    // disagree is the AD-2 failure of validation happening twice. When it is
    // absent — an unrepresentable schema, or a non-zod validator in a test —
    // the flag is simply omitted; the gate still validates what comes back.
    if (prompt.jsonSchema !== undefined) {
      const schemaPath = join(workspace, 'response-schema.json');
      // mode 0o600: the schema is not a secret, but a world-readable temp file
      // is a bad default to establish in a security-sensitive module.
      await writeFile(schemaPath, JSON.stringify(prompt.jsonSchema), { encoding: 'utf8', mode: 0o600 });
      args.push('--output-schema', schemaPath);
    }

    args.push('--output-last-message', lastMessagePath);
    // Explicit, never inherited: the caller decides where codex runs.
    args.push('--cd', cwd);
    if (capability.skipGitRepoCheckSupported) {
      // `-C` at a non-git directory fails without this. Probed, not assumed.
      args.push('--skip-git-repo-check');
    } else if (!(await isInsideGitRepo(cwd))) {
      // The flag is unavailable AND the target is not a git repository, so
      // `codex exec` is certain to refuse. Failing here, naming both facts, is
      // the capability error AD-4 requires — launching a command already known
      // to fail would surface as an opaque codex error the operator cannot act
      // on. Checked only on this branch: for a git target, or a codex that has
      // the flag, no filesystem work happens at all.
      throw new ProviderError(
        `${cwd} is not a git repository and this ${BINARY} does not accept --skip-git-repo-check`,
        `update the Codex CLI, or run against a directory inside a git repository`,
      );
    }
    // The prompt is the final positional argument — one element of an argv array
    // handed to execve, never through a shell, so metacharacters in it are inert
    // data. Proven by test, not asserted here.
    //
    // Unless it is too large for a single argument on Linux, in which case it
    // travels on stdin via codex's own `-` sentinel. The two paths are mutually
    // exclusive: codex APPENDS a piped stdin as a `<stdin>` block when a prompt
    // argument is also present, so sending both would silently duplicate it.
    const composed = composePrompt(prompt);
    const oversized = Buffer.byteLength(composed, 'utf8') > ARGV_PROMPT_LIMIT_BYTES;
    args.push(oversized ? STDIN_PROMPT : composed);

    const result = await deps.runner.run({
      binary: BINARY,
      args,
      cwd,
      timeoutMs: options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      env: childEnvironment(billingEnvVars),
      // Prompt-free by contract on the ordinary path: an empty stdin means codex
      // can never block waiting for input that is not coming.
      input: oversized ? composed : '',
    });

    if (result.outcome === 'not-found') {
      throw new ProviderError(
        `${BINARY} not found on PATH`,
        `install the Codex CLI, then re-run 'specwitness doctor'`,
      );
    }
    if (result.outcome === 'timed-out') {
      throw new ProviderError(
        `${BINARY} did not finish within ${String(options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS)}ms`,
        // Deliberately does NOT say "raise the timeout": there is no
        // configuration surface for it (`ai.providers.<name>` carries only
        // `adapter` and `mode`), so that would send an operator looking for a
        // knob that does not exist. Under the ERROR/HINT contract an
        // unactionable hint is worse than none. Every step below is something
        // they can actually run.
        `check the Codex CLI responds — run 'codex doctor', then try the same prompt with 'codex exec' directly; a smaller epic authors faster`,
      );
    }
    // `spawn-failed` is kept separate from a non-zero exit rather than folded in
    // with it. The process never started, so there is no exit code to report —
    // saying "exited null" would be noise — and story 2.3's runner classifies a
    // non-existent working directory as `spawn-failed` too, since a bad `cwd`
    // raises the same ENOENT as a missing binary. Naming the directory is
    // therefore the difference between an actionable message and one that sends
    // an operator off to reinstall a CLI they already have.
    if (result.outcome === 'spawn-failed') {
      throw new ProviderError(
        `${BINARY} could not be started in ${cwd}${
          result.stderr.trim() === '' ? '' : `: ${firstMeaningfulLine(result.stderr) ?? ''}`
        }`,
        `check that the directory exists and that '${BINARY}' is executable, then re-run 'specwitness doctor'`,
      );
    }
    if (result.exitCode !== 0) {
      // stderr is included because it is where codex explains itself. It is NOT
      // used to decide success: see the note on the read below.
      throw new ProviderError(
        `${BINARY} exec exited ${String(result.exitCode)}${
          result.stderr.trim() === '' ? '' : `: ${firstMeaningfulLine(result.stderr) ?? ''}`
        }`,
        `run 'codex doctor' to check the Codex CLI is signed in and healthy`,
      );
    }

    // Read the ANSWER FILE, not stdout. Codex writes progress and event text to
    // stdout and stderr, so scraping them would be exactly the fragile coupling
    // AD-4 warns against — and non-empty stderr is therefore NOT a failure.
    let raw: string;
    try {
      raw = await readFile(lastMessagePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A run that failed or was killed can exit 0 having written nothing.
        // Name the missing file: this must never surface as a TypeError, and
        // must never be laundered into a silent empty success.
        throw new ProviderError(
          `${BINARY} exec reported success but wrote no final message to ${lastMessagePath}`,
          `run 'codex doctor', then retry; if it recurs, run the same prompt with 'codex exec' manually to see what it reports`,
        );
      }
      throw error;
    }

    // `stripCodeFence` is story 2.4's shared helper (arnold owns the file).
    // Deliberately strict: anything not positively recognised as a fully fenced
    // payload comes back byte-identical, so the gate can reject honestly rather
    // than receive a repaired body.
    return stripCodeFence(raw);
  } finally {
    // Cleanup on BOTH the success and the throw path — a failed invocation must
    // leave nothing behind. `force` so a partially-created workspace is not a
    // second error on the way out of the first.
    await rm(workspace, { recursive: true, force: true });
  }
}
