/**
 * Provider provenance for a generated contract (AD-5, Q65, story 3.8).
 *
 * AD-5 requires a contract's `meta` to record "generation provenance (provider,
 * model as reported by the CLI, CLI version, timestamp) for reproducibility".
 * `src/authoring/contract.ts` has always had the parameters; until this story the
 * CLI edge passed two literal `null`s, so `model` and `providerCliVersion` were
 * null in every contract SpecWitness had ever written and the reproducibility
 * claim was half-true everywhere. This module is what fills them.
 *
 * WHY IT LIVES AT THE EDGE. `src/authoring/**` is application layer and may not
 * import `src/providers/**` (AD-1, dependency-cruiser's `adapters-core-only`).
 * Capability probing is adapter work, so the edge reads it and passes the values
 * DOWN into `generateDraft`, which already accepts them. `src/domain/contract.ts`
 * says the same thing in prose: provenance is populated "at the CLI edge, where
 * the provider actually runs".
 *
 * WHY IT NORMALISES HERE RATHER THAN IN THE COMMAND. This mirrors
 * `src/cli/doctor/provider-probe.ts`, and for its stated reason: the adapters'
 * capability results are deliberately not the same shape, and they deliberately
 * do not agree about version reporting either — claude reports `--version`
 * VERBATIM and never parses it, while codex pattern-matches a semver and records
 * NOTHING when the pattern does not match. Both behaviours are merged, tested and
 * correct, and unifying them is out of scope for this story. Absorbing the
 * difference in one small function keeps the command one code path, and keeps
 * adapter-kind knowledge out of `commands/contract.ts`.
 *
 * IT NEVER PROBES TWICE. Both adapters cache their capability probe per session
 * (AD-4) — claude by runner and cwd, codex by binary — and both consult that
 * cache from `generate`. Passing the SAME `ProcessRunner` the provider was built
 * with is the whole trick: whichever call happens first pays for the probe and
 * the other reads it. Spawning `claude --version` a second time to fill a
 * metadata field would add a subprocess to every contract generation for nothing.
 *
 * IT FAILS OPEN, AND THAT IS DELIBERATE — PLEASE DO NOT "FIX" IT. Everywhere else
 * this product fails CLOSED: a capability it needs but cannot confirm is an
 * error, never a hopeful invocation. Provenance is the exception, because it is a
 * metadata RECORD rather than a gate. A contract whose provenance could not be
 * determined is still a completely valid contract, and refusing to write one
 * would turn an unreadable `--version` string into a broken product. So every
 * failure here — a missing binary, a timeout, a version that could not be read,
 * an adapter this build does not know — becomes an explicit `null`, and
 * generation continues.
 *
 * AN EXPLICIT `null` IS AN ANSWER; A GUESS IS NOT. These fields exist to be
 * trusted by someone auditing a contract months later, and nothing downstream can
 * tell a guessed value from a reported one. A value inferred from
 * `ai.providers.<name>.mode`, from a constant, or from SpecWitness's own idea of
 * what model is probably running is not provenance. `null` honestly says "we do
 * not know"; a wrong string says something false, and says it with authority.
 *
 * NFR-1: everything here comes from the CLIs' own public surface (`--version`),
 * through the adapters' existing probes. Nothing reads `~/.claude/`, `~/.codex/`
 * or any other credential store. AD-3: nothing here builds a command string or
 * mints a `DeclaredCommand`.
 */

import type { ProviderDescriptor } from '../../domain/agent-provider.js';
import type { ProcessRunner } from '../../domain/process-runner.js';
import { probeClaudeCapability } from '../../providers/claude-code-cli.js';
import { probeCodexCapability } from '../../providers/codex-cli.js';

/**
 * The two provenance fields the CLI edge can supply, shaped exactly as
 * `GenerateDraftInput` wants them.
 *
 * Both are `string | null` and never `undefined`: `ContractProvenance` records an
 * unknown value as an explicit `null` rather than omitting the key, because an
 * absent key is indistinguishable from a key an older writer never knew about.
 */
export interface ProviderProvenance {
  /** Model as reported by the CLI. See `MODEL_NOT_REPORTED` below. */
  readonly model: string | null;
  /** The AGENT CLI's version, as that adapter reports it. Never SpecWitness's. */
  readonly providerCliVersion: string | null;
}

/** Nothing could be established. The honest answer, and never an error. */
const UNKNOWN: ProviderProvenance = { model: null, providerCliVersion: null };

/**
 * WHY `model` IS NULL ON EVERY PATH TODAY — a recorded finding, not an oversight.
 *
 * AD-2 fixes the provider envelope: `AgentProvider.generate` returns RAW TEXT and
 * nothing else, which is the property that stops adapters validating, retrying or
 * deciding anything. There is no metadata channel on it, so a model name an
 * adapter saw cannot reach this function even when the CLI reported one.
 *
 *  - **codex** genuinely reports no model on the path SpecWitness uses:
 *    `--output-last-message` returns message text only. `src/domain/contract.ts`
 *    already documents that as routine rather than exceptional.
 *  - **claude** parses a `-p --output-format json` envelope, the only place a
 *    model name could appear — but the adapter reads exactly one field from it
 *    (`result`) and returns a string. Surfacing a model would mean widening
 *    `AgentResponse` with a provider-metadata slot, and
 *    `src/domain/agent-provider.ts` states in its own header that doing so "is an
 *    additive field plus an ADR, not a quiet edit".
 *
 * Reading at an envelope key this project has never observed against a real CLI
 * would be worse than the null: it would ship a field that looks wired and is
 * permanently empty — or, worse, occasionally wrong. So `model` stays `null`, the
 * reason is written down here rather than left to be rediscovered, and surfacing
 * it properly is a follow-up story with an ADR attached.
 */
const MODEL_NOT_REPORTED = null;

/**
 * Read what the provider about to run can honestly say about itself.
 *
 * NEVER throws and never rejects — see the fail-open note in the module header.
 * Pass the same `ProcessRunner` the provider was built with, or the cached probe
 * is missed and a second `--version` is spawned for nothing.
 */
export async function readProviderProvenance(
  descriptor: ProviderDescriptor,
  runner: ProcessRunner,
): Promise<ProviderProvenance> {
  try {
    if (descriptor.adapter === 'claude-code-cli') {
      // Verbatim from `--version`, never parsed — story 2.4's stated rule, and
      // the handover comment in its source that this story answers. `undefined`
      // means the probe could not read one (a missing binary, a non-zero
      // `--version`, a timeout) and becomes an explicit null.
      const capability = await probeClaudeCapability(runner);
      return { model: MODEL_NOT_REPORTED, providerCliVersion: capability.version ?? null };
    }

    if (descriptor.adapter === 'codex-cli') {
      // Story 2.5 pattern-matches a semver out of `codex --version` and
      // deliberately records nothing when the pattern does not match. That is its
      // decision, it is tested there, and this function passes it through rather
      // than second-guessing it.
      const capability = await probeCodexCapability(runner);
      return { model: MODEL_NOT_REPORTED, providerCliVersion: capability.version ?? null };
    }

    // `fake` lands here, and correctly: it is a shipped, config-selectable adapter
    // that spawns nothing and has no CLI behind it, so there is no version to
    // report and probing for one would be a subprocess in a path that promises
    // none. An adapter this build does not know lands here too — the config
    // schema rejects those, so reaching this line means the schema and this
    // function disagree, and "we do not know" is the only honest answer either
    // way. Neither case is an error: a contract still gets written.
    return UNKNOWN;
  } catch {
    // A probe that throws is still only a failure to learn a metadata value. Both
    // adapters document that their capability probes never throw; this exists so
    // that a future one which does cannot take contract generation down with it.
    return UNKNOWN;
  }
}
