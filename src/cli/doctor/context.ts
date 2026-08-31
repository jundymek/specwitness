/**
 * The context every doctor check reads (FR-3).
 *
 * ONE OBJECT, NEVER POSITIONAL ARGUMENTS. Story 2.7 adds provider-discovery
 * state to this context; a single extensible object means it can do that
 * additively without touching the signature of a single existing check. That is
 * the whole reason `DoctorCheck.run` takes a context rather than parameters.
 *
 * ALL SIDE EFFECTS ARRIVE THROUGH `effects`. Checks never import `execa`,
 * `node:net` or `node:fs` themselves, so a unit test can exercise every check
 * with no real git repository, no real socket and no real filesystem. The real
 * implementations live in `effects.ts`.
 *
 * CONFIG FAILURE IS DATA, NOT AN EXCEPTION. `loadConfig` throws; this module
 * catches, so `config-valid` can report the error as its detail and the checks
 * that depend on config (base branch, commands, ports) can degrade with an
 * informative detail instead of throwing or silently passing.
 *
 * NFR-1: nothing here — or in any check — reads `~/.claude/`, `~/.codex/` or any
 * other credential store. Doctor does not touch the home directory at all.
 * `tests/unit/doctor/credential-boundary.test.ts` asserts that mechanically.
 */

import { ConfigError } from '../../domain/errors.js';
import { loadConfig, type SpecwitnessConfig } from '../../config/index.js';

import { createDoctorEffects, type DoctorEffects } from './effects.js';

/** The outcome of attempting to load the project config. */
export type ConfigLoad =
  | { readonly ok: true; readonly value: SpecwitnessConfig }
  | { readonly ok: false; readonly error: ConfigError };

export interface DoctorContext {
  /** The directory doctor was invoked in. Doctor never searches upward. */
  readonly projectRoot: string;
  readonly config: ConfigLoad;
  /** e.g. `v22.20.0`. Injected rather than read so the check is testable. */
  readonly nodeVersion: string;
  /** `PATH` as the process sees it; `''` when unset. */
  readonly pathVar: string;
  /**
   * NAMES of the billing-risk environment variables present in this process's
   * environment — never their values (FR-15, story 2.7).
   *
   * Values are deliberately not carried. A warning that printed a key would
   * leak a credential into terminal scrollback, CI logs and PR bodies, which is
   * a worse outcome than the surprise bill it was warning about; keeping the
   * value out of the context means no check can print one even by accident.
   */
  readonly billingRiskEnv: readonly string[];
  readonly effects: DoctorEffects;
}

export interface DoctorContextOptions {
  readonly projectRoot: string;
  /** Overridden by unit tests; production passes nothing. */
  readonly effects?: DoctorEffects;
  readonly nodeVersion?: string;
  readonly pathVar?: string;
  readonly billingRiskEnv?: readonly string[];
}

/**
 * The billing-risk variables doctor knows about, read by NAME at the edge.
 *
 * WRITTEN AS LITERAL READS ON PURPOSE. A loop over an array of names would read
 * exactly the same two variables while making
 * `tests/unit/doctor/credential-boundary.test.ts` blind to them — that guard can
 * only see a name that is written down, and it says so in its own header
 * ("a fully computed access cannot be resolved by any static scan"). Spelling
 * them out keeps doctor's env reads an auditable, closed list of three: `PATH`
 * here and in `createDoctorContext`, plus these two.
 *
 * PRESENCE, NOT EMPTINESS. An exported-but-empty key still names a variable the
 * provider CLIs will see, and stories 2.4/2.5 withhold it on the same rule, so
 * the two halves of the product agree on what "present" means.
 *
 * The value is read and immediately discarded — only the name travels onward.
 */
function presentBillingRiskVariables(): readonly string[] {
  const present: string[] = [];
  if (process.env['ANTHROPIC_API_KEY'] !== undefined) {
    present.push('ANTHROPIC_API_KEY');
  }
  if (process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined) {
    present.push('ANTHROPIC_AUTH_TOKEN');
  }
  if (process.env['OPENAI_API_KEY'] !== undefined) {
    present.push('OPENAI_API_KEY');
  }
  return present;
}

/**
 * Attempt to load the config, capturing failure instead of propagating it.
 *
 * A non-`ConfigError` escaping `loadConfig` would be a bug in the config layer,
 * not a reason for doctor to crash: it is wrapped so the `config-valid` check
 * still reports something actionable (fail closed, AD-7).
 */
function attemptLoad(projectRoot: string): ConfigLoad {
  try {
    return { ok: true, value: loadConfig(projectRoot) };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: new ConfigError(
        `unexpected failure reading the project config: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'this is a SpecWitness bug — please report it with the command you ran',
      ),
    };
  }
}

export function createDoctorContext(options: DoctorContextOptions): DoctorContext {
  return {
    projectRoot: options.projectRoot,
    config: attemptLoad(options.projectRoot),
    nodeVersion: options.nodeVersion ?? process.version,
    // Env is read at the CLI edge only (spine "State & config"). PATH was once
    // the only variable doctor read; story 2.7 added exactly two more, by NAME
    // and never by value, so that FR-15 can warn about a billing risk before
    // anything is spawned. The closed list of three is asserted in
    // `tests/unit/doctor/credential-boundary.test.ts`, with a justification per
    // name — widening it is a deliberate act, which is the point of the guard.
    pathVar: options.pathVar ?? process.env['PATH'] ?? '',
    billingRiskEnv: options.billingRiskEnv ?? presentBillingRiskVariables(),
    effects: options.effects ?? createDoctorEffects(),
  };
}
