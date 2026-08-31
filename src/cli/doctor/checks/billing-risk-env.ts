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

import type { DoctorCheck } from '../registry.js';

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
    // would be guessing in the direction of a surprise bill. Only a config that
    // loaded AND declares nothing earns silence.
    if (ctx.config.ok && Object.keys(ctx.config.value.ai.providers ?? {}).length === 0) {
      return {
        status: 'pass',
        detail: `${present.join(', ')} set, but no AI providers are configured — SpecWitness will not call one`,
      };
    }

    const named = present
      .map(
        (name) =>
          `${name} present in environment — provider calls could bill your API account; see provider modes`,
      )
      .join('; ');

    return { status: 'warn', detail: named };
  },
};
