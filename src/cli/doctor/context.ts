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
  readonly effects: DoctorEffects;
}

export interface DoctorContextOptions {
  readonly projectRoot: string;
  /** Overridden by unit tests; production passes nothing. */
  readonly effects?: DoctorEffects;
  readonly nodeVersion?: string;
  readonly pathVar?: string;
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
    // Env is read at the CLI edge only (spine "State & config"), and PATH is the
    // only variable doctor reads at all.
    pathVar: options.pathVar ?? process.env['PATH'] ?? '',
    effects: options.effects ?? createDoctorEffects(),
  };
}
