/**
 * The typed Project Config surface and its accessors.
 *
 * Types are inferred from the zod schema rather than hand-written, so the schema
 * and the type cannot drift. Accessors are plain functions over a config value:
 * there is no singleton and no module-level cache, because the CLI edge loads the
 * config once and passes it down (spine Consistency Conventions, "State & config").
 */

import type { z } from 'zod';

import { ConfigError } from '../domain/errors.js';

import type { DeclaredCommand } from './declared-command.js';
import { AI_ROLES, configSchema } from './schema.js';

/** The validated Project Config. Every command-valued field is a `DeclaredCommand`. */
export type SpecwitnessConfig = z.output<typeof configSchema>;

export type ProjectConfig = SpecwitnessConfig['project'];
export type PlanningConfig = SpecwitnessConfig['planning'];
export type SetupConfig = SpecwitnessConfig['setup'];
export type GateConfig = SpecwitnessConfig['gates'][number];
export type ServiceConfig = NonNullable<SpecwitnessConfig['services'][string]>;
export type ReadinessConfig = NonNullable<ServiceConfig['ready']>;
export type AiConfig = SpecwitnessConfig['ai'];
/**
 * The per-probe-class retry counts (story 5.4). Every surface is always present and
 * zero-valued when the project declared nothing, so no caller writes `?? 0` — the same
 * discipline `domain/result-counts.ts` states for counts, and for the same reason: a
 * caller who has to remember a fallback will eventually forget it, and here forgetting
 * would mean an undefined retry count reaching an attempt loop.
 */
export type RetriesConfig = SpecwitnessConfig['retries'];
export type ProviderConfig = NonNullable<NonNullable<AiConfig['providers']>[string]>;

/** The AI roles a project may assign; kebab-case per the spec and addendum section D. */
export type AiRole = (typeof AI_ROLES)[number];

/** A role assignment resolved to the provider it names. */
export interface ResolvedProvider {
  /** The key under `ai.providers` this role points at. */
  name: string;
  adapter: ProviderConfig['adapter'];
  mode: ProviderConfig['mode'];
}

/**
 * Look up a declared observation command by its config id.
 *
 * Throws rather than returning a fallback: an unknown id means a plan referenced
 * an observation the project never declared, and quietly substituting anything
 * would be a hole in the AD-3 boundary.
 */
export function getObservationCommand(config: SpecwitnessConfig, id: string): DeclaredCommand {
  // Own-property check on purpose: a prototype walk would resolve `constructor`
  // or `toString` into something that is not a declared observation at all.
  const observation = Object.hasOwn(config.observations, id)
    ? config.observations[id]
    : undefined;

  if (observation === undefined) {
    const declared = Object.keys(config.observations);
    throw new ConfigError(
      `observations.${id}: no observation with id "${id}" is declared in .specwitness/config.yaml`,
      declared.length > 0
        ? `declare it under 'observations:' or use one of: ${declared.join(', ')}`
        : "declare it under 'observations:' in .specwitness/config.yaml",
    );
  }

  return observation.run;
}

/**
 * Resolve an AI role to the provider it names, or `undefined` when the project
 * assigned no provider to that role. A role naming an undeclared provider cannot
 * reach here — the schema rejects it at load time.
 */
export function resolveRoleProvider(
  config: SpecwitnessConfig,
  role: AiRole,
): ResolvedProvider | undefined {
  const name = config.ai.roles?.[role];
  if (name === undefined) {
    return undefined;
  }

  const provider = config.ai.providers?.[name];
  if (provider === undefined) {
    return undefined;
  }

  return { name, adapter: provider.adapter, mode: provider.mode };
}
