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
 *   `DeclaredCommand` is a branded string. The brand symbol is module-private and
 *   `declareCommand` is never exported — not from this module's public surface and
 *   not from `src/config/index.ts`. Validation (`declaredCommandSchema`, used by
 *   `schema.ts`) is the ONE place a raw string is promoted, and it only ever runs
 *   over bytes read from the project's own config file.
 *
 *   The direction matters and is deliberate:
 *     - `DeclaredCommand -> string` is FREE. Reading a declared command is safe:
 *       story 1.5's doctor resolves its first token on PATH, and renderers print
 *       commands into evidence. `commandText()` makes that intent explicit.
 *     - `string -> DeclaredCommand` is IMPOSSIBLE outside this module. Minting is
 *       the hazard, not reading.
 *
 * DO NOT add an `asDeclaredCommand()` / `unsafeDeclaredCommand()` escape hatch. If
 * a later story needs a command this module does not expose, add a config accessor
 * instead. `tests/unit/config/declared-command.type.test.ts` fails the build if a
 * plain string ever becomes assignable to `DeclaredCommand`, or if a constructor
 * leaks into the public surface.
 */
import { z } from 'zod'

declare const declaredCommandBrand: unique symbol

/**
 * A shell command string that provably came from the project's Project Config.
 *
 * Assignable TO `string` (reading is safe); a `string` is NOT assignable to it
 * (minting is not). Constructible only inside this module.
 */
export type DeclaredCommand = string & { readonly [declaredCommandBrand]: 'DeclaredCommand' }

/**
 * The single promotion point from raw string to `DeclaredCommand`.
 * Module-private on purpose — see the header. Never export this.
 */
const declareCommand = (raw: string): DeclaredCommand => raw as DeclaredCommand

/**
 * The zod schema every command-valued config field must go through, so that all
 * promotion flows through `declareCommand` above.
 */
export const declaredCommandSchema: z.ZodType<DeclaredCommand, string> = z
  .string()
  .min(1, 'command must not be empty')
  .transform(declareCommand)

/**
 * Read a declared command back as a plain string, for display, logging and PATH
 * resolution. This does not execute anything and never will.
 */
export function commandText(command: DeclaredCommand): string {
  return command
}
