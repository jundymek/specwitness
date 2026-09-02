/**
 * The composition root for probe execution (story 4.7).
 *
 * `ProbesStageDeps.dispatch` answers one question per probe — *which executor, handed what
 * params* — and this file is the only place in the product that can answer it, because it
 * is the only place allowed to see all three sides at once:
 *
 *  - `src/pipeline/**` may not import `src/authoring/**` (AD-1), so the pipeline cannot
 *    load a plan or a contract;
 *  - `src/surfaces/**` may not import `src/config/**` or `src/pipeline/**`
 *    (`adapters-core-only`), so no executor can resolve a service id, look a declared
 *    command up, or reach the run accumulator.
 *
 * Both rules push the same work to the edge, and both prescribe the same remedy: the caller
 * resolves and passes values in. So this file resolves a service id into a base URL
 * (4.1's `resolveServiceBaseUrl`), a config id into a runnable command
 * (`getObservationCommand` plus the merged splitter and its three malformed-command
 * refusals), and binds the evidence callbacks the run owns.
 *
 * ============================================================================
 * THE TWO EVIDENCE CHANNELS, AND THE ONE THAT FAILS SILENTLY
 * ============================================================================
 *
 * All three merged surfaces take BOTH:
 *
 *  - `writeEvidence(relativeName, contents)` — writes a file into the run directory and
 *    returns its relative path. `ProbeAttempt.evidence` then carries REFS to those files.
 *  - `recordEvidence(member)` — hands the typed, bounded, redacted evidence MEMBER to
 *    whoever owns the run. It reaches this file already bound, from the PROBES STAGE, which
 *    is the only thing holding the run accumulator; that is `context.run.evidence.push`,
 *    literally what `gates.ts` does with its own members.
 *
 * The second one is the one to get right. `RunResult.evidence` is the closed evidence
 * UNION, not bare references, and `report/terminal.ts` renders from the member inline
 * because AD-11 forbids a renderer to open a file. A dispatcher that stubbed or dropped
 * `recordEvidence` would therefore ship an epic whose reports carry gate evidence and NO
 * probe evidence at all — silently, with every surface suite green, because no surface test
 * drives a renderer. All three cohort-2 PR bodies say so in identical words. The sink is
 * therefore handed DOWN by the stage rather than assembled here, so this file has no sink of
 * its own to get wrong; the assertion that proves the whole chain lives in
 * `tests/integration/verify-probes.test.ts`, which renders.
 *
 * ============================================================================
 * WHY A SHELL PROBE RESOLVES AGAINST `observations:`
 * ============================================================================
 *
 * There is no `shell:` map in the Project Config schema, and a shell probe's `commandId` is
 * validated by 4.2's draft gate against `DeclaredIds.commandIds` — which the plan command
 * fills from `config.observations`. So both command-spawning surfaces draw from one
 * declared map, and `getObservationCommand` is the single accessor for it (4.6's PR body
 * prescribes exactly this call). The naming reads oddly and is reported as such rather than
 * changed here: renaming a config key is a breaking change to every project's
 * `.specwitness/config.yaml`, which is an ADR, not a wiring decision.
 */

import { commandText, getObservationCommand, type SpecwitnessConfig } from '../../config/index.js';
import { InfraError } from '../../domain/errors.js';
import type { RedactionOptions } from '../../domain/evidence.js';
import { redactText } from '../../domain/evidence.js';
import type { Clock } from '../../domain/ports.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import {
  hasGluedExecutableSuffix,
  hasUnterminatedQuote,
  splitCommandLine,
  usesUnsupportedEscaping,
} from '../../pipeline/stages/gate-command.js';
import { resolveServiceBaseUrl } from '../../pipeline/stages/services.js';
import type { ProbeDispatch, ProbeDispatcher } from '../../pipeline/stages/probes.js';
import { HttpSurfaceExecutor } from '../../surfaces/http.js';
import { ObservationSurfaceExecutor } from '../../surfaces/observation.js';
import { ShellSurfaceExecutor } from '../../surfaces/shell.js';

export interface ProbeDispatchDeps {
  readonly config: SpecwitnessConfig;
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  /** `RunStore.writeEvidenceFile` with the run id already applied. */
  readonly writeEvidence: (relativeName: string, contents: string) => Promise<string>;
  /** `RunStore.recordProcessGroup` — AD-8, so `specwitness clean` can reap a probe. */
  readonly onProcessGroup: (pgid: number) => void | Promise<void>;
  /** Config-declared extra redaction patterns (AD-10). */
  readonly redaction?: RedactionOptions;
}

/**
 * A declared command resolved into what `ProcessRunner` needs.
 *
 * The shape 4.5 and 4.6 agreed verbatim, so both surfaces read identically here.
 */
interface ResolvedCommand {
  readonly commandId: string;
  readonly displayCommand: string;
  readonly binary: string;
  readonly baseArgs: readonly string[];
}

export function createProbeDispatcher(deps: ProbeDispatchDeps): ProbeDispatcher {
  const resolveCommand = (commandId: string): ResolvedCommand =>
    resolveDeclaredCommand(deps.config, commandId, deps.redaction);

  return ({ probe, attempt, cwd, runAction, recordEvidence }): ProbeDispatch => {
    // `recordEvidence` arrives from the STAGE, already bound to this run's accumulator —
    // see `ProbeDispatcher` in `pipeline/stages/probes.ts` for why that direction matters.
    // There is no sink this file could substitute, correctly or otherwise.
    const evidence = {
      writeEvidence: deps.writeEvidence,
      recordEvidence,
      ...(deps.redaction === undefined ? {} : { redaction: deps.redaction }),
    };

    switch (probe.surface) {
      case 'http':
        return {
          executor: new HttpSurfaceExecutor({ clock: deps.clock, ...evidence }),
          // `HttpProbeParams` NESTS the probe and adds the resolved base URL; the other two
          // surfaces take the probe's own fields flat. That divergence is 4.4's merged
          // contract and is honoured rather than normalised — changing an executor's params
          // shape to make three call sites look alike would break its merged suite and buy
          // nothing an operator can see.
          params: {
            probe,
            baseUrl: resolveServiceBaseUrl(deps.config, probe.mechanics.serviceId),
            attempt,
          },
        };

      case 'observation':
        return {
          executor: new ObservationSurfaceExecutor({
            runner: deps.runner,
            clock: deps.clock,
            cwd,
            resolveCommand,
            onProcessGroup: deps.onProcessGroup,
            // Only a wrapping observation uses it, but binding it unconditionally is what
            // makes an `around` with no runner impossible rather than merely unlikely — the
            // executor's own "wiring defect" refusal then guards a case that cannot arise.
            runAction,
            ...evidence,
          }),
          params: { ...probe, attempt },
        };

      case 'shell':
        return {
          executor: new ShellSurfaceExecutor({
            runner: deps.runner,
            clock: deps.clock,
            cwd,
            command: resolveCommand(probe.mechanics.commandId),
            onProcessGroup: deps.onProcessGroup,
            ...evidence,
          }),
          params: { ...probe, attempt },
        };

      case 'browser':
        // `browser` is in `PROBE_SURFACES` and has no executor: EPIC 5 owns it, and nothing
        // in Epic 4 adds `@playwright/test`. Refused as infrastructure (exit 3) rather than
        // skipped, because a browser probe silently contributing nothing would let a plan
        // that mapped a criterion to a browser check report PASS having checked nothing.
        throw new InfraError(
          `probe '${probe.id}' uses the browser surface, which this build cannot execute`,
          'browser probes arrive in Epic 5 — recompile the plan without them, or carry the ' +
            "criterion as needs-human with reason 'not-safely-automatable' until then",
        );

      default: {
        // Compile-time exhaustiveness: a fifth surface must be routed here rather than
        // falling through to a probe that runs nothing and reports nothing.
        const unreachable: never = probe;
        return unreachable;
      }
    }
  };
}

/**
 * Turns a declared observation command into a binary and argv, or refuses.
 *
 * The three malformed-command refusals are the merged `gate-command.ts` ones, applied
 * verbatim and for the reason `data.ts` gives one artifact over: a declared command is
 * executed WITHOUT a shell, so a backslash-escaped quote, an unterminated quote or text
 * glued to a quoted executable is ambiguous, and refusing beats guessing.
 *
 * `ConfigError`/`InfraError` (exit 3), never a product FAIL: the project's declaration is
 * wrong, which says nothing about whether the branch satisfies its contract.
 */
function resolveDeclaredCommand(
  config: SpecwitnessConfig,
  commandId: string,
  redaction: RedactionOptions | undefined,
): ResolvedCommand {
  // Throws a `ConfigError` naming every declared id when the plan references one the
  // project does not declare. Nothing is substituted — that would be a hole in the AD-3
  // boundary.
  const declared = getObservationCommand(config, commandId);
  const text = commandText(declared);
  // `{shellCommand: true}` is reserved for DECLARED command text and is correct here: this
  // is the string the project owner wrote in their config, not captured output.
  const shown = (): string => redactText(text, { ...redaction, shellCommand: true });

  if (usesUnsupportedEscaping(text)) {
    throw new InfraError(
      `observation command '${commandId}' uses backslash-escaped quotes, which are not supported: '${shown()}'`,
      'declared commands are executed without a shell, so a backslash before a quote is ' +
        'ambiguous and is refused rather than guessed at. Use the other quote style instead',
    );
  }

  if (hasUnterminatedQuote(text)) {
    throw new InfraError(
      `observation command '${commandId}' has an unterminated quote: '${shown()}'`,
      `close the quote in observations.${commandId} in .specwitness/config.yaml — declared ` +
        'commands are split into a binary and arguments without a shell, so an unclosed quote ' +
        'would silently become several arguments rather than one',
    );
  }

  if (hasGluedExecutableSuffix(text)) {
    throw new InfraError(
      `observation command '${commandId}' has text attached to its quoted executable: '${shown()}'`,
      `separate them with a space in observations.${commandId}, or quote the whole path — as ` +
        'written this would run the quoted binary and pass the rest as an argument, which may ' +
        'not be the command you intended',
    );
  }

  const { binary, args } = splitCommandLine(text);
  if (binary === '') {
    throw new InfraError(
      `observation command '${commandId}' declares a command with no executable: '${shown()}'`,
      `set observations.${commandId}.run in .specwitness/config.yaml to a command starting ` +
        'with a binary',
    );
  }

  return { commandId, displayCommand: text, binary, baseArgs: [...args] };
}
