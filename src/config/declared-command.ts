/**
 * The trusted-command boundary (AD-3 / NFR-2) — the security core of SpecWitness.
 *
 * THE CONTRACT, for every story that comes after this one:
 *
 *   The only strings that ever reach a shell are values declared in the target
 *   project's `.specwitness/config.yaml`. Epic 3's ProcessRunner accepts only
 *   `DeclaredCommand` — never `string`. Therefore no call site anywhere in the
 *   codebase can hand a shell a raw string, and in particular nothing a provider
 *   CLI (claude/codex) authored can become an executable command. Provider-drafted
 *   plans reference executables by config id, never by command string.
 *
 * HOW IT IS ENFORCED:
 *
 *   `DeclaredCommand` is a string carrying a brand whose symbol is declared here
 *   and never exported. Because the symbol is unreachable, no code outside this
 *   package can produce a value of this type by construction — the only remaining
 *   route is a deliberate `as` cast, which TypeScript cannot prevent in any
 *   design and which `tests/unit/config/boundary-scan.test.ts` rejects mechanically.
 *
 *   The single promotion from `string` to `DeclaredCommand` lives in `schema.ts`,
 *   inside the config schema itself, and is a module-private function there. This
 *   module deliberately exports NO callable that mints: an exported
 *   `declaredCommandSchema` would have been a `.parse(anyString)` bypass, because
 *   application layers (`pipeline`, `authoring`, `ingest`, `report`) are permitted
 *   to import `src/config`.
 *
 *   The direction matters and is deliberate:
 *     - `DeclaredCommand -> string` is FREE. Reading a declared command is safe:
 *       story 1.5's doctor resolves its first token on PATH, and renderers print
 *       commands into evidence. `commandText()` makes that intent explicit.
 *     - `string -> DeclaredCommand` is unavailable outside `src/config/`. Minting
 *       is the hazard, not reading.
 *
 * DO NOT add an `asDeclaredCommand()` / `unsafeDeclaredCommand()` escape hatch, and
 * do not export a schema or helper that mints. If a later story needs a command
 * this module does not expose, add a config accessor instead.
 */

declare const declaredCommandBrand: unique symbol;

/**
 * A shell command string that provably came from the project's Project Config.
 *
 * Assignable TO `string` (reading is safe); a `string` is NOT assignable to it
 * (minting is not). Produced only inside `src/config/schema.ts` during validation.
 */
export type DeclaredCommand = string & { readonly [declaredCommandBrand]: 'DeclaredCommand' };

/**
 * Read a declared command back as a plain string, for display, logging and PATH
 * resolution. This does not execute anything and never will.
 */
export function commandText(command: DeclaredCommand): string {
  return command;
}
