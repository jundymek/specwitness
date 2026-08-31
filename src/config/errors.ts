/**
 * Config-layer error refinements.
 *
 * Every failure this layer produces is a `ConfigError` from the AD-7 hierarchy in
 * `src/domain/errors.ts`, so it maps to exit 3 through the single `cli/exit.ts`
 * table with no new branch there. Nothing here adds a seventh classification: a
 * subclass may refine message and hint, never classification. Wanting a different
 * exit code would be an ADR, not a subclass.
 *
 * `MissingConfigFileError` exists because story 1.5's doctor renders "you have no
 * config" and "your config is wrong" as different diagnoses. Both forms are
 * exported deliberately: the class for `instanceof`, and `isMissingConfigFileError`
 * for callers that would rather not depend on subclass identity surviving a
 * bundling boundary. Doctor uses the predicate.
 *
 * The `SpecWitnessError` base sets `name` from `new.target`, so instances of this
 * subclass already report `MissingConfigFileError` in stack traces without an
 * explicit override.
 */

import { ConfigError } from '../domain/errors.js';

/** Thrown when `.specwitness/config.yaml` does not exist under the project root. */
export class MissingConfigFileError extends ConfigError {}

/** True when the config file was absent, as opposed to present but invalid. */
export function isMissingConfigFileError(error: unknown): boolean {
  return error instanceof MissingConfigFileError;
}
