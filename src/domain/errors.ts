/**
 * AD-7 — the one typed error hierarchy for the whole codebase.
 *
 * Every adapter maps its native failures into these six classes at its own
 * boundary; anything that escapes unclassified is escalated to exit 3 by
 * `cli/exit.ts` (fail closed — never silently PASS, never mislabelled as a
 * product FAIL).
 *
 * Gate failure is deliberately NOT in this hierarchy. A failing gate is a
 * stage result carried through verdict aggregation (AD-6), not an exception.
 * Do not add a seventh class here: the taxonomy is closed, and widening it is
 * an ADR in `docs/adr/`, not an edit.
 *
 * AD-1: this module is pure. It imports nothing — not a node builtin, not an
 * npm package (zod included) — so the domain core stays free of side effects
 * and `dependency-cruiser` keeps it that way.
 */

/** Base of the AD-7 hierarchy. Not thrown directly; use one of the six. */
export abstract class SpecWitnessError extends Error {
  /** House style: `HINT: <how to fix>`, printed under `ERROR: <what>`. */
  readonly hint?: string;

  protected constructor(message: string, hint?: string) {
    super(message);
    // `new.target` gives the concrete subclass, so stack traces read
    // `UsageError: ...` rather than `Error: ...`.
    this.name = new.target.name;
    if (hint !== undefined) {
      this.hint = hint;
    }
  }
}

/** Bad invocation: unknown command, unknown flag, missing argument. Exit 64. */
export class UsageError extends SpecWitnessError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/** `.specwitness/config.yaml` missing, unreadable, or failing validation. */
export class ConfigError extends SpecWitnessError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/** Planning artifacts could not be read into an EpicSpec. */
export class IngestError extends SpecWitnessError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/** A frozen artifact's fingerprint does not match its content. */
export class IntegrityError extends SpecWitnessError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/** A delegated agent CLI failed, or returned output the schema gate rejected. */
export class ProviderError extends SpecWitnessError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/** Worktree, service, port, or dependency failure — the environment, not the product. */
export class InfraError extends SpecWitnessError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

/**
 * Type guard for the hierarchy. Uses `instanceof`, so refinements defined in
 * other layers (e.g. a `ConfigError` subclass in `src/config/`) classify
 * correctly too. Deliberately not duck-typed: an arbitrary object carrying a
 * `hint` property is not one of our errors.
 */
export function isSpecWitnessError(err: unknown): err is SpecWitnessError {
  return err instanceof SpecWitnessError;
}
