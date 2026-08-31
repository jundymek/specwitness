/**
 * Billing-risk environment variables (FR-15, UJ-4, optional).
 *
 * The provider CLIs can bill two different accounts depending on how they find
 * their credentials: a subscription the operator already pays for, or a
 * metered API key they exported months ago and forgot. SpecWitness cannot tell
 * which one a `claude` or `codex` invocation will choose — that is the CLI's own
 * business (AD-4, NFR-1) — so it does the one honest thing available to it: it
 * says the variable is there, before anything is spawned.
 *
 * NAMES, NEVER VALUES. `ctx.billingRiskEnv` carries variable names only. A
 * warning that printed a key would leak a credential into terminal scrollback,
 * CI logs and PR bodies — a worse outcome than the surprise bill it was warning
 * about. The value is discarded at the edge and never reaches this module.
 *
 * WARN, NEVER FAIL (`required: false`). An exported key is a thing to know, not
 * a broken environment. Failing a diagnostic over it would exit 3 on a perfectly
 * working machine and teach the operator to stop reading doctor's output — the
 * same reasoning that keeps `ports-free` and `playwright-capability` optional.
 *
 * Stories 2.4 and 2.5 warn about the same variables from inside an invocation
 * ("withheld from the codex subprocess"). This one fires *before* any
 * invocation, when there may not be one at all. Different site, different
 * sentence, same fact — deliberate, not a duplicate.
 */

import { AI_ROLES, resolveRoleProvider } from '../../../config/index.js';
import type { DoctorCheck } from '../registry.js';

/**
 * Which adapter could actually spend which key.
 *
 * A warning is only true if SpecWitness could plausibly spend the credential.
 * `claude` cannot bill an OpenAI account and `codex` cannot bill an Anthropic
 * one, so a project configured with one of them must not be told the other's
 * key is at risk. The `fake` adapter appears in neither list because it spawns
 * nothing and holds no credentials.
 *
 * An adapter absent from this map is treated as CAPABLE of spending any key —
 * see `spenders` below. Failing safe on billing costs a warning; failing open
 * costs money.
 */
const SPENDABLE_BY: Readonly<Record<string, readonly string[]>> = {
  // Both, because story 2.4's adapter withholds both: `ANTHROPIC_AUTH_TOKEN`
  // authenticates a billed Anthropic account exactly as the API key does, and a
  // diagnostic that warned about only one of them would be silent on a real
  // hazard the product itself already recognises.
  'claude-code-cli': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  'codex-cli': ['OPENAI_API_KEY'],
  fake: [],
};

/** The variable names the configured adapters could plausibly spend. */
function spendable(adapters: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const adapter of adapters) {
    const known = SPENDABLE_BY[adapter];
    if (known === undefined) {
      // An adapter this build does not recognise — a newer config, or one this
      // check has not been taught about. Assume it could spend anything rather
      // than silently clearing a real risk.
      return new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']);
    }
    for (const name of known) {
      names.add(name);
    }
  }
  return names;
}

export const billingRiskEnvCheck: DoctorCheck = {
  id: 'billing-risk-env',
  required: false,
  async run(ctx) {
    const present = ctx.billingRiskEnv;

    if (present.length === 0) {
      return { status: 'pass', detail: 'no billing-risk API-key variables in the environment' };
    }

    // A config that failed to load is NOT treated as "no providers": staying
    // silent about an exported key on the strength of a file we could not read
    // would be guessing in the direction of a surprise bill. `config-valid`
    // already reports the load failure itself.
    if (!ctx.config.ok) {
      return { status: 'warn', detail: warnAbout(present) };
    }

    // REACHABLE, not merely declared. A provider block that no role references
    // can never be invoked — `resolveRoleProvider` is the only way one is
    // selected — and unused provider blocks are common in real configs, kept
    // after a switch or added ahead of use. Warning about a key SpecWitness
    // will never spend through them is the same false alarm as warning about
    // the wrong vendor's key, and it is why this reads roles rather than
    // `ai.providers`.
    const config = ctx.config.value;
    const adapters: string[] = [];
    for (const role of AI_ROLES) {
      const resolved = resolveRoleProvider(config, role);
      if (resolved !== undefined) {
        adapters.push(resolved.adapter);
      }
    }

    if (adapters.length === 0) {
      // The variable is still NAMED (AC3), and the reason it is not a warning is
      // spelled out — including what would turn it into one. An operator who
      // expected a warning learns why there is none; one who later assigns a
      // role knows what changes.
      const declared = Object.keys(config.ai.providers ?? {}).length > 0;
      return {
        status: 'pass',
        detail: declared
          ? `${present.join(', ')} set; providers are declared but no role is assigned to one, so SpecWitness will not call a provider — assigning a role under 'ai.roles' would make this billable`
          : `${present.join(', ')} set, but no AI provider is configured — SpecWitness will not call one`,
      };
    }

    const reachable = spendable(adapters);
    const atRisk = present.filter((name) => reachable.has(name));

    if (atRisk.length === 0) {
      // The keys are there, but nothing configured could spend them. Saying so
      // is more useful than silence: it tells an operator who expected a warning
      // why there isn't one.
      return {
        status: 'pass',
        detail: `${present.join(', ')} set, but no configured provider can spend ${
          present.length === 1 ? 'it' : 'them'
        }`,
      };
    }

    return { status: 'warn', detail: warnAbout(atRisk) };
  },
};

function warnAbout(names: readonly string[]): string {
  return names
    .map(
      (name) =>
        `${name} present in environment — provider calls could bill your API account; see provider modes`,
    )
    .join('; ');
}
