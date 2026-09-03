/**
 * The zod model of `.specwitness/config.yaml` (FR-2, FR-4).
 *
 * Two rules govern every line below:
 *
 * 1. STRICT AT EVERY LEVEL. Objects are `z.strictObject`, so an unknown key —
 *    `setupp:` at the root, or a nested typo like `readyness:` — is an error
 *    naming its YAML path rather than silently doing nothing. A misspelled
 *    readiness block that validated would mean a service SpecWitness never
 *    waits for.
 *
 * 2. DELIBERATE DEFAULTS ONLY. zod defaults silently materialise values the user
 *    did not write, so the complete list lives here and nowhere else:
 *
 *      planning.format                  = 'bmad-v6'
 *      planning.planningArtifacts       = 'docs/planning-artifacts'
 *      planning.implementationArtifacts = 'docs/implementation-artifacts'
 *      planning | setup | services | data | observations | ai = {}  (whole block)
 *      gates                            = []
 *      services.<name>.ready.timeoutSec = 60   (addendum section D example value)
 *
 *    `project.baseBranch` deliberately has NO default: addendum section D
 *    annotates it "never assumed", and defaulting it is exactly the assumption
 *    the brief forbids. It plus `version` are the entire required surface, which
 *    is what lets story 1.4's `init` skeleton stay tiny.
 *
 * Key names are camelCase per the spine, EXCEPT the three `ai.roles` keys, which
 * the story spec and addendum section D both spell kebab-case. Spec wins; the
 * divergence is recorded in DECISIONS.md.
 */

import { z } from 'zod';

import type { ProbeSurface } from '../domain/criterion-result.js';

import type { DeclaredCommand } from './declared-command.js';

const DEFAULT_PLANNING_ARTIFACTS = 'docs/planning-artifacts';
const DEFAULT_IMPLEMENTATION_ARTIFACTS = 'docs/implementation-artifacts';
const DEFAULT_READY_TIMEOUT_SEC = 60;

const nonEmptyString = z.string().min(1);

/**
 * The ONE promotion point from a raw string to a `DeclaredCommand` (AD-3).
 *
 * Module-private on purpose, and deliberately NOT exported as a zod schema: an
 * exported `declaredCommandSchema` would be a callable `.parse(anyString)` mint,
 * and the application layers (`pipeline`, `authoring`, `ingest`, `report`) may
 * legitimately import `src/config`. Keeping it here means the only remaining
 * route to a `DeclaredCommand` outside this file is a deliberate cast, which
 * TypeScript cannot prevent in any design and which
 * `tests/unit/config/boundary-scan.test.ts` rejects mechanically.
 */
const declaredCommand = (): z.ZodType<DeclaredCommand, string> =>
  z
    .string()
    .min(1, 'command must not be empty')
    .transform((raw): DeclaredCommand => raw as DeclaredCommand);

const projectSchema = z.strictObject({
  /** No default: the base branch is never assumed (addendum section D). */
  baseBranch: nonEmptyString,
  epicBranchPattern: nonEmptyString.optional(),
});

const planningSchema = z.strictObject({
  format: z.literal('bmad-v6').default('bmad-v6'),
  planningArtifacts: nonEmptyString.default(DEFAULT_PLANNING_ARTIFACTS),
  implementationArtifacts: nonEmptyString.default(DEFAULT_IMPLEMENTATION_ARTIFACTS),
});

const setupSchema = z.strictObject({
  install: declaredCommand().optional(),
});

const gateSchema = z.strictObject({
  id: nonEmptyString,
  run: declaredCommand(),
});

/**
 * A service is ready when a URL answers OR when a probe command succeeds —
 * exactly one, enforced by the refinement below.
 *
 * This is deliberately one strict object rather than a `z.union` of a url arm and
 * a command arm. Under a union, a bad `timeoutSec` fails both arms and zod reports
 * a single `invalid_union` issue whose path stops at `services.<name>.ready`, so
 * the user is told the block is wrong without being told which key. AC2 requires
 * naming the offending path, so the shape follows the error quality:
 * `services.backend.ready.timeoutSec: expected number, received string`.
 */
const readinessSchema = z
  .strictObject({
    url: nonEmptyString.optional(),
    command: declaredCommand().optional(),
    timeoutSec: z.number().int().positive().default(DEFAULT_READY_TIMEOUT_SEC),
  })
  .superRefine((ready, ctx) => {
    const hasUrl = ready.url !== undefined;
    const hasCommand = ready.command !== undefined;
    if (hasUrl === hasCommand) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: hasUrl
          ? "declare exactly one of 'url' or 'command', not both"
          : "declare exactly one of 'url' or 'command'",
      });
    }
  });

const serviceSchema = z.strictObject({
  run: declaredCommand(),
  /** Explicit per-service ports; V0 does not auto-allocate (questions doc Q26). */
  port: z.number().int().min(1).max(65535).optional(),
  /**
   * Required, not optional. The spec's service shape marks `port?` and `env?`
   * optional and writes `ready:` without the `?` — the same notation that makes
   * `project.baseBranch` required — and AC1 says services carry "command +
   * readiness". A service with no declared readiness has no defined moment at
   * which the pipeline may proceed, so accepting one would defer a config error
   * into a race at run time.
   */
  ready: readinessSchema,
  env: z.record(z.string(), z.string()).optional(),
});

const providerSchema = z.strictObject({
  // `fake` is a SHIPPED adapter, not a test-only escape hatch: it returns canned
  // responses from a fixture directory so the Golden Corpus e2e (Epic 6) can
  // drive the real `specwitness` binary with no agent CLI installed and no
  // network. Story 2.3 added it; 2.4 and 2.5 implement the two real ones.
  adapter: z.enum(['claude-code-cli', 'codex-cli', 'fake']),
  mode: nonEmptyString,
});

/** Kebab-case by spec + addendum section D; see the header note. */
export const AI_ROLES = ['contract-author', 'plan-author', 'explainer'] as const;

const aiSchema = z.strictObject({
  providers: z.record(nonEmptyString, providerSchema).optional(),
  roles: z
    .strictObject({
      'contract-author': nonEmptyString.optional(),
      'plan-author': nonEmptyString.optional(),
      explainer: nonEmptyString.optional(),
    })
    .optional(),
});

const observationSchema = z.strictObject({
  run: declaredCommand(),
});

/**
 * ============================================================================
 * `retries:` — story 5.4. The field Epic 4 built the mechanism for and left out.
 * ============================================================================
 *
 * WHY IT LIVES HERE AND NOT IN THE PLAN. Both were candidates and the argument is not
 * close. A retry count is an *environment* property — "this machine's browser is flaky",
 * "this CI box drops the first connection" — and the Project Config is where every other
 * per-environment knob already lives. The Plan (`src/schemas/plan.ts`) is compiled from a
 * frozen contract and carries that contract's fingerprint: a retry count baked into it
 * would become part of what "the same verification" MEANS, so raising it on a flaky
 * machine would read as tampering with the specification rather than as tuning the
 * environment. Disagreement with that is an ADR in `docs/adr/`, not an edit here.
 *
 * OPT-IN, DEFAULT 0, FOR EVERY SURFACE (AD-9, question Q43). A run is deterministic
 * unless the project asked otherwise. A default retry would silently convert every flaky
 * environment into green, which is FR-32's failure mode arriving through the config file
 * — so the default is written surface by surface below and pinned by a test that fails if
 * any of them ever becomes non-zero.
 *
 * REJECTED, NOT CLAMPED — and this deliberately diverges from `src/providers/invoke.ts`,
 * whose `clampRetries` folds an out-of-range `maxRetries` into `[0, 5]` because "clamping
 * is friendlier than rejecting a config over a number that has an obviously sane
 * interpretation". That reasoning holds for an INTERNAL option with a documented default
 * that no human typed. It does not hold here, for two reasons. First, this file's whole
 * convention is to fail closed and name the offending YAML path, because a config error a
 * user can find is worth more than one the product papers over. Second, and decisively:
 * an operator who wrote `retries: { http: 1000 }` and got 5 would believe they had
 * configured something they did not get, and a verification tool whose settings quietly
 * mean something other than what they say is the same class of defect as a verdict that
 * quietly means something other than what it says. The ceiling exists so a typo cannot
 * spend an afternoon; saying so out loud costs one error message.
 *
 * `z.number().int().min(0).max(...)` closes every non-terminating value in one line: zod's
 * number rejects NaN, `.int()` rejects both infinities and any fraction, `.min(0)` rejects
 * a negative. There is no path from this field to a loop that does not end.
 */

/**
 * The most EXTRA attempts any one probe class may take, so 5 retries means at most 6
 * attempts. The same ceiling `src/providers/invoke.ts` applies to provider retries, and
 * deliberately the same number: two different bounds on "how many times may this be
 * repeated" would be two numbers to look up and one to get wrong.
 */
export const MAX_PROBE_RETRIES = 5;

const retryCount = z.number().int().min(0).max(MAX_PROBE_RETRIES).default(0);

/**
 * Declared as a `Record<ProbeSurface, ...>` rather than inline in `z.strictObject`, which
 * is what makes the exhaustiveness a COMPILE-TIME fact: a fifth probe surface added to
 * `PROBE_SURFACES` stops this file compiling until it is given a default here, and a key
 * that is not a surface is rejected by the type checker before the schema ever sees it.
 */
const retriesShape: Record<ProbeSurface, typeof retryCount> = {
  http: retryCount,
  browser: retryCount,
  observation: retryCount,
  shell: retryCount,
};

const retriesSchema = z.strictObject(retriesShape);

const baseConfigSchema = z.strictObject({
  version: z.literal(1),
  project: projectSchema,
  /**
   * `prefault`, not `default`: zod returns a `default` value AS-IS without
   * parsing it, so `.default({})` would yield a bare `{}` and silently skip the
   * three inner field defaults below. `prefault` runs the fallback through the
   * schema, so an omitted `planning:` block gets the documented values and an
   * unknown key inside a partial block is still rejected. Verified against the
   * pinned zod 4.5 before relying on it.
   */
  planning: planningSchema.prefault({}),
  setup: setupSchema.default({}),
  /** Order is significant: gates run in YAML declaration order with early stop. */
  gates: z.array(gateSchema).default([]),
  services: z.record(nonEmptyString, serviceSchema).default({}),
  /** Free-form command map keyed by name; `reset` is the conventional key. */
  data: z.record(nonEmptyString, declaredCommand()).default({}),
  observations: z.record(nonEmptyString, observationSchema).default({}),
  /**
   * Opt-in bounded retries per probe class (AD-9, FR-32). `prefault`, not `default`, for
   * the reason `planning` states above: a bare `.default({})` is returned AS-IS without
   * being parsed, so an absent block would yield `{}` and every `config.retries.<surface>`
   * read would be `undefined` rather than 0 — a silently policy-free retry policy.
   */
  retries: retriesSchema.prefault({}),
  ai: aiSchema.default({}),
});

/**
 * Cross-field rules a per-field schema cannot express. Each issue carries an
 * explicit `path` so the loader can render the offending YAML path.
 */
export const configSchema = baseConfigSchema.superRefine((config, ctx) => {
  const firstSeenAt = new Map<string, number>();
  config.gates.forEach((gate, index) => {
    const earlier = firstSeenAt.get(gate.id);
    if (earlier === undefined) {
      firstSeenAt.set(gate.id, index);
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['gates', index, 'id'],
      message: `duplicate gate id "${gate.id}" (already declared at gates[${earlier}]); gate ids must be unique`,
    });
  });

  const declaredProviders = Object.keys(config.ai.providers ?? {});
  for (const role of AI_ROLES) {
    const assigned = config.ai.roles?.[role];
    if (assigned === undefined) {
      continue;
    }
    if (declaredProviders.includes(assigned)) {
      continue;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['ai', 'roles', role],
      message:
        `role "${role}" references undeclared provider "${assigned}"; ` +
        (declaredProviders.length > 0
          ? `declared providers are: ${declaredProviders.join(', ')}`
          : 'no providers are declared under ai.providers'),
    });
  }
});
