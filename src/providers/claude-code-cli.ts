/**
 * The Claude Code CLI adapter (FR-12, FR-15, NFR-1, AD-2, AD-4, ADR-001).
 *
 * SpecWitness performs all LLM work by spawning the user's locally installed
 * official CLI. There is no API key, no SDK and no `fetch`: authentication is
 * entirely the official tool's business, the same trust model as invoking `git`.
 * This file is where that promise is kept or quietly broken.
 *
 * It is a THIN TRANSLATION LAYER: envelope in, argv out, raw text back. It does
 * not validate, retry, record attempts or construct domain objects — all of that
 * is `providers/invoke.ts`, implemented once for every adapter (AD-2). A zod call
 * in this file would be the exact defect that boundary exists to prevent.
 *
 * WHAT IS HARDCODED, AND WHY ONLY THIS. AD-4 permits a tested minimum and
 * nothing more, because these CLIs evolve fast (ADR-001, concern 1). The minimum
 * is `-p --output-format json`, re-verified against claude 2.1.251 on
 * 2026-08-31: `--help` lists `-p, --print` and `--output-format` with choices
 * exactly `text`, `json`, `stream-json`. Everything else is PROBED. In
 * particular the version string is reported verbatim and never parsed into a
 * feature matrix — a `claude` on PATH may be a shell alias or an unrelated
 * program, so only BEHAVIOUR proves capability.
 *
 * BILLING SAFETY IS UNCONDITIONAL (FR-15). The billing variables are withheld
 * from every child environment whatever `mode` says — not only in
 * `subscription`. `mode` is an unconstrained non-empty string in config
 * (`src/config/schema.ts`), no artifact anywhere defines a mode that opts INTO
 * API-key billing, and so a conditional withhold would make silent billing
 * reachable by a typo that validation cannot catch (`mode: subscribtion`). An
 * unrecognized mode therefore withholds anyway and warns, and a variable that is
 * set but EMPTY counts as present: failing safe on money is cheaper than an
 * unexpected charge. Adding an opt-in billing mode later is a config-schema
 * change plus an ADR, never a condition in an adapter.
 *
 * NFR-1, ABSOLUTELY. No path here reads `~/.claude/`, `CLAUDE_CONFIG_DIR`,
 * `.netrc` or any credential store. The only environment variable this module
 * reads is the billing variable itself, and only to decide whether to warn —
 * which is precisely what FR-15 asks for. Naming a variable in order to WITHHOLD
 * it is the categorical opposite of reading a credential.
 */

import type {
  AgentPrompt,
  AgentProvider,
  ProviderDeps,
  ProviderDescriptor,
} from '../domain/agent-provider.js';
import { ProviderError } from '../domain/errors.js';
import type { ProcessResult, ProcessRunner } from '../domain/process-runner.js';
import { stripCodeFence } from './text.js';

/** The binary name. Fixed: never built from config, never a command line (AD-3). */
const BINARY = 'claude';

/** AD-4's hardcodable minimum for claude, and the whole of it. */
const BASELINE_ARGS = ['-p', '--output-format', 'json'] as const;

/** The mode that documents subscription-backed use. Others still withhold. */
const RECOGNIZED_MODE = 'subscription';

/**
 * Withheld from every child environment.
 *
 * This default must be complete on its own. `createProvider` builds the adapter
 * with no options, and the provider config schema is a `strictObject` of
 * `{adapter, mode}` — there is nowhere for a project to name an extra variable.
 * So `billingEnvVars` below is an injection seam for callers and tests, NOT a
 * configuration surface, and anything missing from this list is simply never
 * withheld in practice.
 *
 * Both entries authenticate a billed Anthropic account, which is what AD-4's
 * "provider equivalents" means. Giving projects a way to declare their own would
 * be a config-schema change plus the ADR that goes with it, not an adapter
 * change — flagged for the epic rather than done here.
 */
const DEFAULT_BILLING_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Probe bound, matching `src/cli/doctor/checks/git.ts`'s 5s precedent. Doctor
 * runs on machines that are already unwell; a diagnostic that hangs is worse
 * than one that reports a hang.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** Generation bound. Drafting a contract is slow work, but never unbounded. */
const DEFAULT_INVOCATION_TIMEOUT_MS = 300_000;

/**
 * Above this many bytes the prompt travels on stdin instead of argv.
 *
 * Chosen from a measurement, not a guess. macOS here reports `ARG_MAX` of 1 MiB
 * with a largest single argv element of ~1017 KiB, but Linux independently caps
 * ONE ARGUMENT at `MAX_ARG_STRLEN` = 128 KiB regardless of its much larger
 * `ARG_MAX`. Linux is therefore the binding platform and the one not testable
 * from here, so the threshold sits well below its cap with room for the flags
 * and a large environment. Below it the prompt stays in argv, keeping AD-3's
 * "argv array, no shell" the ordinary, trivially provable path.
 */
const ARGV_PROMPT_LIMIT_BYTES = 64 * 1024;

/** What doctor (story 2.7) renders. Field names mirror the codex adapter's. */
export interface ClaudeCapability {
  readonly binary: string;
  /** The binary resolved on PATH. */
  readonly found: boolean;
  /** Verbatim from `--version`, never parsed. Chuck fills `providerCliVersion` from it. */
  readonly version?: string;
  /** `-p --output-format json` actually worked — behaviour, not inference. */
  readonly nonInteractive: boolean;
  readonly jsonOutputFormat: boolean;
  /** Actionable, present only when something above is false. */
  readonly reason?: string;
}

/**
 * Auth readiness (Q58).
 *
 * `claude` has no `codex doctor` equivalent, so readiness is the exit code of a
 * trivial invocation — the CLI's own public surface, never filesystem
 * inspection. `exitCode: null` means COULD NOT TELL (hung or never started),
 * which is deliberately distinct from a refusal: a timed-out probe is not a
 * diagnosis about the user's authentication and must never be rendered as one.
 */
export interface ClaudeAuthProbe {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly detail?: string;
}

export interface ClaudeAdapterOptions {
  /** Working directory for the child. Defaults to the process cwd. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Extra billing-risk variables to withhold. An injection seam, not a config surface. */
  readonly billingEnvVars?: readonly string[];
}

/**
 * Capability results are cached PER RUNNER rather than in a module-level
 * variable. One runner is built per process, so this is the per-session cache
 * AD-4 and Q56/Q57 ask for — while a test that builds its own runner gets a
 * fresh probe automatically, with no reset hook to forget to call.
 */
const capabilityCache = new WeakMap<ProcessRunner, Promise<ClaudeCapability>>();

/** The child environment: inherited, minus the billing variables. Never mutates the parent. */
function childEnvironment(billingEnvVars: readonly string[]): {
  readonly inherit: true;
  readonly withhold: readonly string[];
} {
  return { inherit: true, withhold: [...billingEnvVars] };
}

async function probeOnce(
  runner: ProcessRunner,
  args: readonly string[],
  billingEnvVars: readonly string[],
): Promise<ProcessResult> {
  return await runner.run({
    binary: BINARY,
    args,
    cwd: process.cwd(),
    timeoutMs: PROBE_TIMEOUT_MS,
    env: childEnvironment(billingEnvVars),
    input: '',
  });
}

/**
 * Does this stderr read like the CLI refusing the ARGUMENTS, as opposed to
 * refusing the work?
 *
 * The distinction decides whether a failed probe counts against capability. A
 * commander-style CLI (which `claude` is) reports an unsupported flag with a
 * recognisable usage error; an authentication or quota refusal looks nothing
 * like one. Matching on that signature is a heuristic, and it is deliberately
 * biased toward "the flags were fine": a false negative merely lets `generate`
 * proceed and report the CLI's own message, whereas a false positive tells the
 * operator their working installation is too old.
 */
function looksLikeFlagRejection(stderr: string): boolean {
  return /unknown option|unrecognized option|unknown argument|invalid option|unknown command|error: unknown|usage:/i.test(
    stderr,
  );
}

/**
 * Renders a non-completion outcome as operator-facing text.
 *
 * `not-found` means only "not on PATH" — story 2.3 made a bad working directory
 * `spawn-failed` precisely so this message cannot tell an operator to install a
 * CLI they already have.
 */
function outcomeReason(result: ProcessResult, timeoutMs: number): string | undefined {
  switch (result.outcome) {
    case 'not-found':
      return `${BINARY} not found on PATH — contract generation unavailable; existing plans still run`;
    case 'timed-out':
      return `${BINARY} did not respond within ${String(timeoutMs)}ms — state unknown`;
    case 'spawn-failed':
      return `${BINARY} could not be started${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`;
    default:
      return undefined;
  }
}

/**
 * Discover `claude` and confirm it can do the non-interactive form.
 *
 * NEVER throws. A missing agent CLI is a normal project state (UJ-4), so it must
 * be expressible as a value doctor can warn about while leaving its exit code at
 * 0. Cached for the process lifetime.
 */
export function probeClaudeCapability(
  runner: ProcessRunner,
  options: ClaudeAdapterOptions = {},
): Promise<ClaudeCapability> {
  const cached = capabilityCache.get(runner);
  if (cached !== undefined) {
    return cached;
  }

  const billingEnvVars = options.billingEnvVars ?? DEFAULT_BILLING_ENV_VARS;

  const probe = (async (): Promise<ClaudeCapability> => {
    const version = await probeOnce(runner, ['--version'], billingEnvVars);

    const versionProblem = outcomeReason(version, PROBE_TIMEOUT_MS);
    if (versionProblem !== undefined) {
      return {
        binary: BINARY,
        found: version.outcome !== 'not-found',
        nonInteractive: false,
        jsonOutputFormat: false,
        reason: versionProblem,
      };
    }

    if (version.exitCode !== 0) {
      return {
        binary: BINARY,
        found: true,
        nonInteractive: false,
        jsonOutputFormat: false,
        reason:
          `${BINARY} is on PATH but \`--version\` exited ${String(version.exitCode)} — ` +
          'it may not be Claude Code',
      };
    }

    const versionText = version.stdout.trim();

    // The REAL proof: exercise the non-interactive form rather than infer it
    // from the version string, which an alias or homonym can print freely.
    const capable = await probeOnce(
      runner,
      [...BASELINE_ARGS, 'Reply with the single word: ok'],
      billingEnvVars,
    );

    const capableProblem = outcomeReason(capable, PROBE_TIMEOUT_MS);
    if (capableProblem !== undefined) {
      return {
        binary: BINARY,
        found: true,
        version: versionText,
        nonInteractive: false,
        jsonOutputFormat: false,
        reason: capableProblem,
      };
    }

    // A non-zero exit means the CLI declined — but NOT necessarily that it does
    // not understand the flags. The probe is a real invocation, so it also fails
    // when the operator is logged out, rate limited or out of quota. Calling any
    // of those a capability failure sends someone to reinstall a working binary
    // AND hides the CLI's own message, because `generate` refuses before it ever
    // reaches the invocation that would have shown it.
    //
    // So only a genuine ARGUMENT rejection counts against capability; everything
    // else means the flags were accepted and readiness is `probeClaudeAuth`'s
    // question, not this one.
    if (capable.exitCode !== 0 && looksLikeFlagRejection(capable.stderr)) {
      return {
        binary: BINARY,
        found: true,
        version: versionText,
        nonInteractive: false,
        jsonOutputFormat: false,
        reason:
          `${BINARY} (${versionText}) rejected \`${BASELINE_ARGS.join(' ')}\` — ` +
          'the CLI is too old, or is not Claude Code',
      };
    }

    return {
      binary: BINARY,
      found: true,
      version: versionText,
      nonInteractive: true,
      jsonOutputFormat: true,
    };
  })();

  capabilityCache.set(runner, probe);
  return probe;
}

/**
 * Auth readiness, via the exit code of a trivial invocation (Q58).
 *
 * Deliberately NOT folded into `probeClaudeCapability`: capability is cached and
 * cheap, whereas this costs a real round trip, and doctor decides when to pay
 * it. Never throws.
 */
export async function probeClaudeAuth(
  runner: ProcessRunner,
  options: ClaudeAdapterOptions = {},
): Promise<ClaudeAuthProbe> {
  const billingEnvVars = options.billingEnvVars ?? DEFAULT_BILLING_ENV_VARS;
  const result = await probeOnce(
    runner,
    [...BASELINE_ARGS, 'Reply with the single word: ok'],
    billingEnvVars,
  );

  const problem = outcomeReason(result, PROBE_TIMEOUT_MS);
  if (problem !== undefined) {
    return { ok: false, exitCode: null, detail: problem };
  }

  if (result.exitCode === 0) {
    return { ok: true, exitCode: 0 };
  }

  const detail = result.stderr.trim();
  return {
    ok: false,
    exitCode: result.exitCode,
    detail: detail === '' ? `${BINARY} exited ${String(result.exitCode)}` : detail,
  };
}

/**
 * Pull the payload text out of the `--output-format json` envelope.
 *
 * Defensive by contract: the envelope shape may change between CLI versions, and
 * that must surface as a diagnosable error naming what was expected — never a
 * `TypeError` from a property access on `undefined`.
 */
function extractPayload(stdout: string): { ok: true; text: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const preview = stdout.trim().slice(0, 200);
    return {
      ok: false,
      reason:
        `expected a JSON envelope from \`${BASELINE_ARGS.join(' ')}\` ` +
        `but the output was not JSON: ${preview}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'expected the JSON envelope to be an object' };
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.is_error === true) {
    const detail = typeof envelope.result === 'string' ? envelope.result : 'no detail reported';
    return { ok: false, reason: `${BINARY} reported an error: ${detail}` };
  }

  if (typeof envelope.result !== 'string') {
    return {
      ok: false,
      reason:
        'expected a string `result` field carrying the payload in the JSON envelope, but it was ' +
        `${envelope.result === undefined ? 'absent' : typeof envelope.result} — ` +
        'the CLI output shape may have changed',
    };
  }

  return { ok: true, text: envelope.result };
}

/**
 * Compose the text the model sees.
 *
 * `contextFiles` are appended as a delimited path list rather than passed
 * through a flag: `--add-dir` and friends are not in the probed baseline, and
 * AD-4 forbids reaching for a flag that has not been tested.
 */
function composePrompt(prompt: AgentPrompt): string {
  if (prompt.contextFiles === undefined || prompt.contextFiles.length === 0) {
    return prompt.prompt;
  }
  const list = prompt.contextFiles.map((file) => `- ${file}`).join('\n');
  return `${prompt.prompt}\n\nContext files:\n${list}`;
}

/** Build the claude adapter. Called by `createProvider` (AD-1: config arrives as arguments). */
export function createClaudeCodeCliProvider(
  descriptor: ProviderDescriptor,
  deps: ProviderDeps,
  options: ClaudeAdapterOptions = {},
): AgentProvider {
  const billingEnvVars = options.billingEnvVars ?? DEFAULT_BILLING_ENV_VARS;
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS;

  /** FR-15 warnings, emitted through the injected sink (AD-1: the edge owns output). */
  function warnAboutBilling(): void {
    if (descriptor.mode !== RECOGNIZED_MODE) {
      deps.warn(
        `⚠ unrecognized provider mode "${descriptor.mode}" for the ${BINARY} adapter — ` +
          'withholding billing variables anyway',
      );
    }

    for (const name of billingEnvVars) {
      // Presence of the NAME counts, even when the value is empty: a variable
      // that exists is one a child could have used. Only the name is ever
      // printed — a warning echoing the value would leak a credential into
      // scrollback and PR bodies.
      if (Object.hasOwn(process.env, name)) {
        deps.warn(
          `⚠ ${name} present in environment — withheld from the ${BINARY} subprocess ` +
            `(mode: ${descriptor.mode})`,
        );
      }
    }
  }

  return {
    id: descriptor.name,
    adapter: descriptor.adapter,

    async generate(prompt: AgentPrompt): Promise<string> {
      // BEFORE the capability probe, which spawns `claude` itself. Warning
      // afterwards would let the session's first subprocess run unannounced, and
      // a probe that failed would throw with no warning at all — so an operator
      // whose key is set would never learn it. The variable is withheld from
      // every spawn either way, probe included; this is the warning contract
      // (FR-15), not the safety property.
      warnAboutBilling();

      const capability = await probeClaudeCapability(deps.processRunner, {
        ...options,
        billingEnvVars,
      });
      if (!capability.found || !capability.nonInteractive) {
        throw new ProviderError(
          `provider "${descriptor.name}" cannot run: ${capability.reason ?? 'capability probe failed'}`,
          'install or update Claude Code, then re-run `specwitness doctor`',
        );
      }

      const text = composePrompt(prompt);

      // The two prompt paths are MUTUALLY EXCLUSIVE. Measured on 2.1.251: piped
      // stdin is APPENDED to an argv prompt rather than replacing it, so
      // supplying both silently duplicates the prompt — and a duplicated prompt
      // still produces plausible output, so nothing downstream would catch it.
      const oversized = Buffer.byteLength(text, 'utf8') > ARGV_PROMPT_LIMIT_BYTES;
      const args = oversized ? [...BASELINE_ARGS] : [...BASELINE_ARGS, text];
      const input = oversized ? text : '';

      const result = await deps.processRunner.run({
        binary: BINARY,
        args,
        cwd,
        timeoutMs,
        env: childEnvironment(billingEnvVars),
        input,
      });

      if (result.outcome === 'timed-out') {
        throw new ProviderError(
          `${BINARY} timed out after ${String(timeoutMs)}ms while drafting for role "${prompt.role}"`,
          'raise the provider timeout, or try a smaller epic',
        );
      }

      const problem = outcomeReason(result, timeoutMs);
      if (problem !== undefined) {
        throw new ProviderError(problem, 'run `specwitness doctor` to check the provider');
      }

      if (result.exitCode !== 0) {
        const detail = result.stderr.trim();
        throw new ProviderError(
          `${BINARY} exited ${String(result.exitCode)}${detail === '' ? '' : `: ${detail}`}`,
          'check that the CLI is authenticated (run `claude` interactively), then retry',
        );
      }

      const payload = extractPayload(result.stdout);
      if (!payload.ok) {
        throw new ProviderError(payload.reason, 'run `specwitness doctor` to check the CLI version');
      }

      // Fence-stripping is CLI-output translation and belongs here; the payload
      // is otherwise returned RAW. Validating it is the gate's job (AD-2), and
      // "repairing" it would hand the gate a body it would otherwise reject.
      return stripCodeFence(payload.text);
    },
  };
}
