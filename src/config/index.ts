/**
 * Project Config — the public surface of the config adapter (FR-2, FR-4, AD-3).
 *
 * SpecWitness learns a project ONLY through `.specwitness/config.yaml`. Nothing in
 * this codebase names a framework, package manager, test runner or database: the
 * install command, gates, service start commands and ports, data commands,
 * observation commands and provider roles all enter through this one file. That is
 * what makes the tool stack-independent (FR-4), and it is also what makes it safe.
 *
 * THE BOUNDARY (AD-3 / NFR-2), stated once for every story that follows:
 *
 *   Epic 3's ProcessRunner accepts only `DeclaredCommand`, never `string`. A
 *   `DeclaredCommand` can be minted only inside `src/config/declared-command.ts`,
 *   during validation of the project's own config file. There is no exported
 *   constructor and no assertion helper, so there is no code path — none — by
 *   which a raw string, or output from a `claude`/`codex` subprocess, becomes an
 *   executable command. Plans reference executables by config id.
 *
 *   Reading a declared command is safe and free (`commandText`); minting one is
 *   the hazard. If a later story needs a command that is not exposed here, add an
 *   accessor to this module — do not add an escape hatch.
 *
 * Usage: the CLI edge loads once and passes the value down. There is no singleton.
 *
 *   const config = loadConfig(projectRoot)   // throws ConfigError; never partial
 */
export { commandText, type DeclaredCommand } from './declared-command.js'
export { MissingConfigFileError, isMissingConfigFileError } from './errors.js'
export { CONFIG_RELATIVE_PATH, loadConfig } from './load.js'
export { AI_ROLES } from './schema.js'
export {
  getObservationCommand,
  resolveRoleProvider,
  type AiConfig,
  type AiRole,
  type GateConfig,
  type PlanningConfig,
  type ProjectConfig,
  type ProviderConfig,
  type ReadinessConfig,
  type ResolvedProvider,
  type ServiceConfig,
  type SetupConfig,
  type SpecwitnessConfig,
} from './types.js'

// Deliberately NOT exported: `declareCommand` (the DeclaredCommand constructor)
// and `declaredCommandSchema`. See declared-command.ts for why.
